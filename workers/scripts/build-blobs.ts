import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertKvEndpoint,
  blobPutBody,
  groupBlobKey,
  keywordBlobEntries,
  splitLogBlobs,
  userShardIndex,
  userShardKey,
  type BlobPut,
  type GroupBlob,
  type LogRow,
  type UserShard,
} from "../src/blob-store.ts";
import { IMPORT_SECRET_HEADER } from "../src/import-plan.ts";

export interface BuildBlobOptions {
  sqlitePath: string;
  outDir: string;
  repoRoot: string;
  upload?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  stdout: (line: string) => void;
}

export interface BlobSummary {
  groups: number;
  groupsMissing: number;
  groupBytes: number;
  users: number;
  userShards: number;
  userBytes: number;
  settingsDm: number;
  settingsGroup: number;
  settingsSkipped: number;
  membersSkipped: number;
  keywords: number;
  keywordKeys: number;
  keywordBytes: number;
  logRows: number;
  logKeys: number;
  logBytes: number;
  puts: number;
}

export async function buildBlobs(options: BuildBlobOptions): Promise<BlobSummary> {
  const sqlitePath = resolve(options.sqlitePath);
  const outDir = resolve(options.outDir);
  assertOutsideRepo(outDir, resolve(options.repoRoot));
  if (outDir === sqlitePath) throw new Error("output directory must differ from the sqlite file");
  if (options.upload !== undefined) {
    assertKvEndpoint(options.upload);
    if (options.secret === undefined || options.secret.length === 0) {
      throw new Error("import secret is empty");
    }
  }
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const built = collect(db);
    mkdirSync(outDir, { recursive: true });
    for (const put of built.puts) writePut(outDir, put);
    const summary = built.summary;
    writeFileSync(
      resolve(outDir, "c-manifest.json"),
      `${JSON.stringify({
        groups: summary.groups,
        groupsMissing: summary.groupsMissing,
        users: summary.users,
        userShards: summary.userShards,
        keywordKeys: summary.keywordKeys,
        keywordBytes: summary.keywordBytes,
        logKeys: summary.logKeys,
        logRows: summary.logRows,
        puts: summary.puts,
      })}\n`,
    );
    if (options.upload !== undefined && options.secret !== undefined) {
      const fetchImpl = options.fetchImpl ?? fetch;
      for (const put of built.puts) {
        const response = await fetchImpl(options.upload, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [IMPORT_SECRET_HEADER]: options.secret,
          },
          body: blobPutBody(put),
        });
        if (!response.ok) throw new Error(`blob upload failed: ${response.status}`);
      }
    }
    options.stdout(formatSummary(summary));
    return summary;
  } finally {
    db.close();
  }
}

function collect(db: DatabaseSync): { puts: BlobPut[]; summary: BlobSummary } {
  const names = new Map<string, string | null>();
  const users = new Map<number, UserShard>();
  let userCount = 0;
  for (const row of db.prepare("SELECT id, name, create_on, update_on FROM user").all()) {
    const id = text(row, "id");
    if (id === null) continue;
    userCount += 1;
    const name = text(row, "name");
    names.set(id, name);
    const shard = users.get(userShardIndex(id)) ?? { users: [], settings: [] };
    shard.users.push({
      id,
      name,
      create_on: text(row, "create_on"),
      update_on: text(row, "update_on"),
    });
    users.set(userShardIndex(id), shard);
  }

  const groups = new Map<string, GroupBlob>();
  for (const row of db.prepare('SELECT id, _id, _count, _setting, _admin, create_on, update_on FROM "group"').all()) {
    const id = text(row, "id");
    if (id === null) continue;
    groups.set(id, {
      id,
      group: {
        id,
        _id: text(row, "_id"),
        _count: text(row, "_count") ?? "{}",
        _setting: text(row, "_setting") ?? "{}",
        _admin: text(row, "_admin") ?? "{}",
        create_on: text(row, "create_on"),
        update_on: text(row, "update_on"),
      },
      users: [],
      settings: [],
    });
  }

  let membersSkipped = 0;
  for (const row of db.prepare("SELECT gid, uid, _count, _setting FROM group_user").all()) {
    const gid = text(row, "gid");
    if (gid === null) {
      membersSkipped += 1;
      continue;
    }
    const group = groups.get(gid) ?? emptyGroup(gid);
    groups.set(gid, group);
    const uid = text(row, "uid") ?? "";
    group.users.push({
      uid,
      name: names.get(uid) ?? null,
      _count: text(row, "_count") ?? "{}",
      _setting: text(row, "_setting") ?? "{}",
    });
  }

  let settingsDm = 0;
  let settingsGroup = 0;
  let settingsSkipped = 0;
  for (const row of db.prepare("SELECT group_id, user_id, options FROM user_settings").all()) {
    const options = text(row, "options");
    if (options === null || options.trim() === "" || options.trim() === "{}") {
      settingsSkipped += 1;
      continue;
    }
    const userId = text(row, "user_id") ?? "";
    const groupId = text(row, "group_id") ?? "";
    if (groupId === "") {
      const shard = users.get(userShardIndex(userId)) ?? { users: [], settings: [] };
      shard.settings.push({ user_id: userId, options });
      users.set(userShardIndex(userId), shard);
      settingsDm += 1;
      continue;
    }
    const group = groups.get(groupId) ?? emptyGroup(groupId);
    groups.set(groupId, group);
    group.settings.push({ user_id: userId, options });
    settingsGroup += 1;
  }

  const keywords: Array<{ id: string | null; keyword: string; reply: string }> = [];
  for (const row of db.prepare("SELECT id, keyword, reply FROM user_keyword ORDER BY _id").all()) {
    const keyword = text(row, "keyword");
    const reply = text(row, "reply");
    if (keyword === null || reply === null) continue;
    keywords.push({ id: text(row, "id"), keyword, reply });
  }
  const keywordPuts = keywordBlobEntries(keywords);

  const logs: LogRow[] = [];
  for (const row of db.prepare("SELECT _id, id, keyword, reply, create_on FROM keywords_logs ORDER BY _id").all()) {
    const id = text(row, "_id");
    if (id === null) continue;
    logs.push([
      id,
      text(row, "id"),
      text(row, "keyword"),
      text(row, "reply"),
      text(row, "create_on"),
    ]);
  }
  const logParts = splitLogBlobs(logs);

  const puts: BlobPut[] = [...keywordPuts];
  let groupBytes = 0;
  let groupsMissing = 0;
  for (const group of groups.values()) {
    if (group.group === null) groupsMissing += 1;
    const key = groupBlobKey(group.id);
    groupBytes += new TextEncoder().encode(JSON.stringify(group)).byteLength;
    puts.push({ key, json: group });
  }
  let userBytes = 0;
  for (const [index, shard] of users) {
    userBytes += new TextEncoder().encode(JSON.stringify(shard)).byteLength;
    puts.push({ key: userShardKey(index), json: shard });
  }
  let logBytes = 0;
  logParts.forEach((part, index) => {
    logBytes += new TextEncoder().encode(JSON.stringify(part)).byteLength;
    puts.push({ key: `c-logs:${index}`, json: part });
  });
  const keywordBytes = keywordPuts.reduce((sum, put) => sum + (put.bytes?.byteLength ?? 0), 0);
  puts.push({
    key: "c-manifest",
    json: {
      groups: groups.size,
      users: userCount,
      userShards: users.size,
      keywordKeys: keywordPuts.length,
      keywordBytes,
      logKeys: logParts.length,
      logRows: logs.length,
      puts: puts.length + 1,
    },
  });

  return {
    puts,
    summary: {
      groups: groups.size,
      groupsMissing,
      groupBytes,
      users: userCount,
      userShards: users.size,
      userBytes,
      settingsDm,
      settingsGroup,
      settingsSkipped,
      membersSkipped,
      keywords: keywords.length,
      keywordKeys: keywordPuts.length,
      keywordBytes,
      logRows: logs.length,
      logKeys: logParts.length,
      logBytes,
      puts: puts.length,
    },
  };
}

function emptyGroup(id: string): GroupBlob {
  return { id, group: null, users: [], settings: [] };
}

function writePut(outDir: string, put: BlobPut): void {
  const safe = put.key.replaceAll("/", "_");
  if (put.bytes !== undefined) {
    writeFileSync(resolve(outDir, `${safe}.bin`), put.bytes);
    return;
  }
  writeFileSync(resolve(outDir, `${safe}.json`), JSON.stringify(put.json));
}

function formatSummary(summary: BlobSummary): string {
  return [
    `groups=${summary.groups}`,
    `groups_missing=${summary.groupsMissing}`,
    `group_bytes=${summary.groupBytes}`,
    `users=${summary.users}`,
    `user_shards=${summary.userShards}`,
    `user_bytes=${summary.userBytes}`,
    `settings_dm=${summary.settingsDm}`,
    `settings_group=${summary.settingsGroup}`,
    `settings_skipped=${summary.settingsSkipped}`,
    `members_skipped=${summary.membersSkipped}`,
    `keywords=${summary.keywords}`,
    `keyword_keys=${summary.keywordKeys}`,
    `keyword_bytes=${summary.keywordBytes}`,
    `log_rows=${summary.logRows}`,
    `log_keys=${summary.logKeys}`,
    `log_bytes=${summary.logBytes}`,
    `puts=${summary.puts}`,
  ].join("\n");
}

function text(row: unknown, name: string): string | null {
  if (row === null || typeof row !== "object") return null;
  const value = (row as Record<string, unknown>)[name];
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function assertOutsideRepo(outDir: string, repoRoot: string): void {
  const rel = relative(repoRoot, outDir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("output directory must be outside the repo");
  }
}

function main(argv: readonly string[]): Promise<void> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error("usage: build-blobs --sqlite PATH --out DIR [--upload URL --secret SECRET]");
    }
    args.set(flag, value);
  }
  const sqlitePath = args.get("--sqlite");
  const outDir = args.get("--out");
  if (sqlitePath === undefined || outDir === undefined) {
    throw new Error("usage: build-blobs --sqlite PATH --out DIR [--upload URL --secret SECRET]");
  }
  return buildBlobs({
    sqlitePath,
    outDir,
    repoRoot: resolve(import.meta.dirname, "../.."),
    upload: args.get("--upload"),
    secret: args.get("--secret"),
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
  }).then(() => undefined);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "blob build failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
