import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { it } from "vitest";
import { COLD_BOT_STATE, groupBlobKey } from "../src/blob-store";
import type { BotState } from "../src/bot-state";
import type { KeywordSelect } from "../src/keywords";

const BASE = "http://127.0.0.1:8797";
const NOW = "2024-01-02 03:04:05";
const SECRET = "bench";

interface BlobFile {
  name: string;
  size: number;
}

interface Index {
  files: BlobFile[];
  stats: {
    totalBytes: number;
    files: number;
    keywordBytes: number;
    largestGroup: { members: number; file: string | null; size: number };
    max: { probe: BlobFile | null; row: BlobFile | null; log: BlobFile | null; group: BlobFile | null };
  };
}

it("measures option C against real blobs", async () => {
  const index = (await (await fetch(`${BASE}/index.json`)).json()) as Index;
  const keywordFiles = index.files.filter((f) => f.name.startsWith("keyword-"));
  const stub: DurableObjectStub<BotState> = env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE));
  env.IMPORT_SECRET = SECRET;

  await fresh(stub);
  await putKeywordBlobs(stub, keywordFiles);
  await spyGets(stub);
  const coldWall = performance.now();
  const cold = await stub.measureColdRequest(query("zz-no-match"), 3);
  const coldWallMs = performance.now() - coldWall;
  const coldGets = await readGets(stub);

  await installMeter(stub);
  const dmCold = await timed(() => stub.recordMessage(dm("Ubench-dm", "zz-no-match"), NOW));
  const dmColdRows = await readMeter(stub);
  await resetMeter(stub);
  const dmWarm = await timed(() => stub.recordMessage(dm("Ubench-dm", "zz-no-match"), NOW));
  const dmWarmRows = await readMeter(stub);

  const uploads: Record<string, { wallMs: number; status: number }> = {};
  for (const [name, file] of Object.entries(index.stats.max)) {
    if (file === null) continue;
    uploads[name] = await upload(stub, file);
  }

  await fresh(stub);
  const groupFile = index.stats.largestGroup.file;
  if (groupFile === null) throw new Error("largest group blob missing");
  const group = (await (await fetch(`${BASE}/${encodeURIComponent(groupFile)}`)).json()) as {
    id: string;
    users: Array<{ uid: string }>;
  };
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(groupBlobKey(group.id), group);
  });
  await installMeter(stub);
  const speaker = group.users[0]?.uid;
  if (speaker === undefined) throw new Error("group has no users");

  await runInDurableObject(stub, () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  });

  const hydrate = await timed(() => stub.recordMessage(groupText(group.id, speaker, "zz-no-match"), NOW));
  let alarmMaxMs = 0;
  let alarmTotalMs = 0;
  let steps = 0;
  for (;;) {
    const step = await timed(() => stub.pumpHydration());
    alarmMaxMs = Math.max(alarmMaxMs, step.ms);
    alarmTotalMs += step.ms;
    steps += 1;
    const done = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec("SELECT done FROM cold_group WHERE id = ?", group.id).toArray()[0];
      return row?.done === 1;
    });
    if (done) break;
    if (steps > 40) throw new Error("hydration did not finish");
  }
  const hydrateRows = await readMeter(stub);
  await resetMeter(stub);
  const follow = await timed(() => stub.recordMessage(groupText(group.id, speaker, "zz-no-match"), NOW));
  const followRows = await readMeter(stub);

  await stub.upsertKeyword({
    scopeId: group.id,
    author: speaker,
    keyword: "bench-trigger",
    reply: "bench-reply",
    plus: false,
    now: NOW,
  });
  await resetMeter(stub);
  const trigger = await timed(() => stub.recordMessage(groupText(group.id, speaker, "bench-trigger"), NOW));
  const triggerRows = await readMeter(stub);

  console.log(
    `C_MEASURE ${JSON.stringify({
      keyword: {
        files: keywordFiles.length,
        bytes: index.stats.keywordBytes,
        gets: coldGets,
        decodeMs: cold.decodeMs,
        requestMs: cold.requestMs,
        wallMs: round(coldWallMs),
        hitsPerRound: coldGets / 3,
      },
      dm: { coldMs: round(dmCold.ms), coldRows: dmColdRows, warmMs: round(dmWarm.ms), warmRows: dmWarmRows },
      upload: uploads,
      hydrate: {
        members: index.stats.largestGroup.members,
        blobBytes: index.stats.largestGroup.size,
        firstMs: round(hydrate.ms),
        rows: hydrateRows,
        steps,
        alarmMaxMs: round(alarmMaxMs),
        alarmTotalMs: round(alarmTotalMs),
      },
      follow: { ms: round(follow.ms), rows: followRows },
      trigger: { ms: round(trigger.ms), rows: triggerRows },
      totals: { files: index.stats.files, bytes: index.stats.totalBytes },
    })}`,
  );
});

function query(message: string): KeywordSelect {
  return { message, scopeId: null, allReply: true, excludeUrl: false, stripName: false, rng: [{ op: "choice", index: 0 }] };
}

function dm(userId: string, message: string) {
  return { kind: "text", text: message, source: { type: "user", groupId: null, userId } };
}

function groupText(groupId: string, userId: string, message: string) {
  return { kind: "text", text: message, source: { type: "group", groupId, userId } };
}

async function fresh(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.deleteAll();
    await instance.migrate();
  });
}

async function putKeywordBlobs(stub: DurableObjectStub<BotState>, files: BlobFile[]): Promise<void> {
  const loaded = await Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await (await fetch(`${BASE}/${encodeURIComponent(file.name)}`)).arrayBuffer());
      return { key: blobKey(file.name), bytes };
    }),
  );
  await runInDurableObject(stub, async (_instance, state) => {
    for (const file of loaded) {
      if (file.key.endsWith("-meta") || file.key === "c-manifest") {
        await state.storage.put(file.key, JSON.parse(new TextDecoder().decode(file.bytes)));
      } else {
        await state.storage.put(file.key, file.bytes.buffer);
      }
    }
  });
}

async function upload(stub: DurableObjectStub<BotState>, file: BlobFile): Promise<{ wallMs: number; status: number }> {
  const bytes = new Uint8Array(await (await fetch(`${BASE}/${encodeURIComponent(file.name)}`)).arrayBuffer());
  const key = blobKey(file.name);
  const body = file.name.endsWith(".json")
    ? JSON.stringify({ key, json: JSON.parse(new TextDecoder().decode(bytes)) })
    : JSON.stringify({ key, bytes: base64(bytes) });
  const started = performance.now();
  const response = await stub.fetch(
    new Request("https://do/import/kv", {
      method: "POST",
      headers: { "content-type": "application/json", "x-import-secret": SECRET },
      body,
    }),
  );
  return { wallMs: round(performance.now() - started), status: response.status };
}

async function timed(fn: () => Promise<unknown>): Promise<{ ms: number }> {
  const started = performance.now();
  await fn();
  return { ms: performance.now() - started };
}

async function spyGets(stub: DurableObjectStub<BotState>): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => {
    const box = { n: 0 };
    (globalThis as unknown as { __benchGets: typeof box }).__benchGets = box;
    const get = state.storage.get.bind(state.storage);
    state.storage.get = (async (key: string) => {
      box.n += 1;
      return get(key);
    }) as typeof state.storage.get;
    return box.n;
  });
}

async function readGets(stub: DurableObjectStub<BotState>): Promise<number> {
  return runInDurableObject(
    stub,
    () => (globalThis as unknown as { __benchGets: { n: number } }).__benchGets.n,
  );
}

async function installMeter(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const box = { rowsRead: 0, rowsWritten: 0 };
    (globalThis as unknown as { __benchMeter: typeof box }).__benchMeter = box;
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    state.storage.sql.exec = ((statement: string, ...bindings: unknown[]) => {
      const cursor = exec(statement, ...(bindings as never[]));
      box.rowsRead += cursor.rowsRead;
      box.rowsWritten += cursor.rowsWritten;
      return cursor;
    }) as typeof state.storage.sql.exec;
  });
}

async function readMeter(stub: DurableObjectStub<BotState>): Promise<{ rowsRead: number; rowsWritten: number }> {
  return runInDurableObject(stub, () => {
    const box = (globalThis as unknown as { __benchMeter: { rowsRead: number; rowsWritten: number } }).__benchMeter;
    return { rowsRead: box.rowsRead, rowsWritten: box.rowsWritten };
  });
}

async function resetMeter(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, () => {
    const box = (globalThis as unknown as { __benchMeter: { rowsRead: number; rowsWritten: number } }).__benchMeter;
    box.rowsRead = 0;
    box.rowsWritten = 0;
  });
}

function blobKey(name: string): string {
  return name.endsWith(".json") ? name.slice(0, -5) : name.slice(0, -4);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
