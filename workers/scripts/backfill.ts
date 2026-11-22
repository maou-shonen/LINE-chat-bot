import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { IMPORT_SECRET_HEADER } from "../src/import-gate.ts";
import { EXPORT_TABLES, type ExportTable } from "../src/export-tables.ts";

const FETCH_LIMIT = 200;

export interface BackfillOptions {
  endpoint: string;
  sqlitePath: string;
  secret: string;
  fetchImpl?: typeof fetch;
  limit?: number;
  stdout: (line: string) => void;
}

export async function runBackfill(options: BackfillOptions): Promise<Record<ExportTable, number>> {
  const endpoint = assertExportEndpoint(options.endpoint);
  if (options.secret.length === 0) throw new Error("import secret is empty");
  const limit = options.limit ?? FETCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("fetch limit must be 1..500");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const db = new DatabaseSync(resolve(options.sqlitePath));
  const counts: Record<ExportTable, number> = {
    user: 0,
    group: 0,
    group_user: 0,
    user_settings: 0,
    user_keyword: 0,
    keywords_logs: 0,
    keyword_tombstone: 0,
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of EXPORT_TABLES) {
      let after = 0;
      for (;;) {
        const response = await fetchImpl(endpoint.toString(), {
          method: "POST",
          headers: { "content-type": "application/json", [IMPORT_SECRET_HEADER]: options.secret },
          body: JSON.stringify({ table, after, limit }),
        });
        if (!response.ok) throw new Error(`export failed for ${table}: ${response.status}`);
        const page = parsePage(await response.json());
        applyRows(db, table, page.rows);
        counts[table] += page.rows.length;
        if (page.next === null) break;
        after = page.next;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  options.stdout(EXPORT_TABLES.map((table) => `${table}=${counts[table]}`).join("\n"));
  return counts;
}

export function assertExportEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("endpoint must be an absolute URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("endpoint must not include a user, query, or hash");
  }
  if (url.pathname !== "/export") throw new Error("endpoint path must be /export");
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("endpoint must be https, or http on localhost");
  }
  return url;
}

export function applyRows(db: DatabaseSync, table: ExportTable, rows: readonly Record<string, unknown>[]): void {
  switch (table) {
    case "user":
      for (const row of rows) {
        db.prepare(
          `INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = COALESCE(excluded.name, user.name),
             create_on = COALESCE(excluded.create_on, user.create_on),
             update_on = COALESCE(excluded.update_on, user.update_on)`,
        ).run(text(row, "id"), nullableText(row, "name"), nullableText(row, "create_on"), nullableText(row, "update_on"));
      }
      return;
    case "group":
      for (const row of rows) {
        db.prepare(
          `INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             _id = COALESCE(excluded._id, "group"._id),
             _count = excluded._count,
             _setting = excluded._setting,
             _admin = excluded._admin,
             create_on = COALESCE(excluded.create_on, "group".create_on),
             update_on = COALESCE(excluded.update_on, "group".update_on)`,
        ).run(
          text(row, "id"),
          nullableText(row, "_id"),
          text(row, "_count"),
          text(row, "_setting"),
          text(row, "_admin"),
          nullableText(row, "create_on"),
          nullableText(row, "update_on"),
        );
      }
      return;
    case "group_user":
      for (const row of rows) {
        const gid = nullIfEmpty(text(row, "gid"));
        const uid = nullIfEmpty(text(row, "uid"));
        const found = db
          .prepare("SELECT _id FROM group_user WHERE COALESCE(gid, '') = ? AND COALESCE(uid, '') = ?")
          .get(gid ?? "", uid ?? "");
        const existing = rowId(found);
        if (existing === null) {
          db.prepare("INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?)").run(
            gid,
            uid,
            text(row, "_count"),
            text(row, "_setting"),
          );
        } else {
          db.prepare("UPDATE group_user SET _count = ?, _setting = ? WHERE _id = ?").run(
            text(row, "_count"),
            text(row, "_setting"),
            existing,
          );
        }
      }
      return;
    case "user_settings":
      for (const row of rows) {
        const groupId = nullIfEmpty(text(row, "group_id"));
        const userId = nullIfEmpty(text(row, "user_id"));
        const found = db
          .prepare("SELECT _id FROM user_settings WHERE COALESCE(group_id, '') = ? AND COALESCE(user_id, '') = ?")
          .get(groupId ?? "", userId ?? "");
        const existing = rowId(found);
        if (existing === null) {
          db.prepare("INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)").run(
            groupId,
            userId,
            text(row, "options"),
          );
        } else {
          db.prepare("UPDATE user_settings SET options = ? WHERE _id = ?").run(text(row, "options"), existing);
        }
      }
      return;
    case "user_keyword":
      for (const row of rows) {
        const id = nullableText(row, "id");
        const keyword = text(row, "keyword");
        const found = db.prepare("SELECT _id FROM user_keyword WHERE id IS ? AND keyword = ?").get(id, keyword);
        const existing = rowId(found);
        if (existing === null) {
          db.prepare("INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)").run(
            id,
            nullableText(row, "author"),
            keyword,
            text(row, "reply"),
            text(row, "anchor"),
          );
        } else {
          db.prepare("UPDATE user_keyword SET author = ?, reply = ?, anchor = ? WHERE _id = ?").run(
            nullableText(row, "author"),
            text(row, "reply"),
            text(row, "anchor"),
            existing,
          );
        }
      }
      return;
    case "keywords_logs":
      for (const row of rows) {
        db.prepare(
          `INSERT INTO keywords_logs (_id, id, keyword, reply, create_on) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(_id) DO NOTHING`,
        ).run(
          text(row, "_id"),
          nullableText(row, "id"),
          nullableText(row, "keyword"),
          nullableText(row, "reply"),
          nullableText(row, "create_on"),
        );
      }
      return;
    case "keyword_tombstone":
      for (const row of rows) {
        db.prepare("DELETE FROM user_keyword WHERE id IS ? AND keyword = ?").run(
          nullableText(row, "id"),
          text(row, "keyword"),
        );
      }
      return;
  }
}

function parsePage(value: unknown): { rows: Record<string, unknown>[]; next: number | null } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("export page must be an object");
  }
  const record = value as Record<string, unknown>;
  const rows = record.rows;
  const next = record.next;
  if (!Array.isArray(rows) || rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("export rows must be objects");
  }
  if (next !== null && (typeof next !== "number" || !Number.isSafeInteger(next) || next < 0)) {
    throw new Error("export cursor must be a non-negative integer or null");
  }
  return { rows: rows as Record<string, unknown>[], next };
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`export column ${key} was not text`);
  return value;
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`export column ${key} was not text`);
  return value;
}

function rowId(found: unknown): number | null {
  if (found === null || typeof found !== "object" || !("_id" in found)) return null;
  const id = found._id;
  if (typeof id === "number") return id;
  if (typeof id === "bigint") return Number(id);
  return null;
}

function nullIfEmpty(value: string): string | null {
  return value === "" ? null : value;
}

function main(argv: readonly string[]): Promise<void> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error("usage: backfill --endpoint URL --sqlite PATH");
    }
    args.set(flag, value);
  }
  const endpoint = args.get("--endpoint");
  const sqlitePath = args.get("--sqlite");
  if (endpoint === undefined || sqlitePath === undefined) {
    throw new Error("usage: backfill --endpoint URL --sqlite PATH");
  }
  const secret = process.env.IMPORT_SECRET ?? "";
  return runBackfill({
    endpoint,
    sqlitePath,
    secret,
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
  }).then(() => undefined);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "backfill failed";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
