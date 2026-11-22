import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { it } from "vitest";
import { COLD_BOT_STATE, keywordBlobEntries } from "../src/blob-store";
import type { BotState } from "../src/bot-state";
import type { KeywordSelect } from "../src/keywords";

const ROWS = 50_929;
const ANCHORS = 24_711;
const GROUPS = 4_407;

it("measures cold keyword paths at production size", async () => {
  const stub: DurableObjectStub<BotState> = env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE));
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.deleteAll();
    await instance.migrate();
  });

  const rows = [];
  const reply = "r".repeat(64);
  for (let i = 0; i < ROWS; i += 1) {
    rows.push({
      id: i < 552 ? "C0" : `C${1 + (i % GROUPS)}`,
      author: `U${i}`.padEnd(33, "a"),
      keyword: `a${i % ANCHORS}**x${i % 2}`,
      reply: `${reply}${i}`,
    });
  }
  const entries = keywordBlobEntries(rows);
  let blobBytes = 0;
  for (const entry of entries) blobBytes += entry.bytes?.byteLength ?? JSON.stringify(entry.json).length;
  await runInDurableObject(stub, async (_instance, state) => {
    for (const entry of entries) {
      if (entry.bytes !== undefined) await state.storage.put(entry.key, entry.bytes.buffer);
      else await state.storage.put(entry.key, entry.json);
    }
  });

  await runInDurableObject(stub, (_instance, state) => {
    const box = { n: 0 };
    (globalThis as unknown as { __benchGets: { n: number } }).__benchGets = box;
    const get = state.storage.get.bind(state.storage);
    state.storage.get = (async (key: string) => {
      box.n += 1;
      return get(key);
    }) as typeof state.storage.get;
  });

  const coldStart = performance.now();
  const cold = await stub.measureColdRequest(query("a0"), 1);
  const coldMs = performance.now() - coldStart;
  const gets = await runInDurableObject(
    stub,
    () => (globalThis as unknown as { __benchGets: { n: number } }).__benchGets.n,
  );

  const probeStart = performance.now();
  const probe = await stub.selectKeywordReplies(query("a0"));
  const probeMs = performance.now() - probeStart;

  const scopeStart = performance.now();
  const scoped = await stub.listKeywords("C0");
  const scopedMs = performance.now() - scopeStart;

  const inspectStart = performance.now();
  const inspect = await stub.inspectKeywords();
  const inspectMs = performance.now() - inspectStart;
  const internal = await runInDurableObject(stub, async (instance) => {
    const start = performance.now();
    const result = await instance.inspectKeywords();
    return { ms: performance.now() - start, count: result.keywords.length };
  });

  console.log(JSON.stringify({
    entries: entries.length,
    blobBytes,
    gets,
    coldMs: round(coldMs),
    decodeMs: round(cold.decodeMs[0] ?? 0),
    requestMs: round(cold.requestMs[0] ?? 0),
    probeMs: round(probeMs),
    probeHits: probe.candidates,
    scopedCount: scoped.length,
    scopedMs: round(scopedMs),
    inspectCount: inspect.keywords.length,
    inspectRpcMs: round(inspectMs),
    inspectInternalMs: round(internal.ms),
    inspectInternalCount: internal.count,
  }));
}, 300_000);

function query(message: string): KeywordSelect {
  return { message, scopeId: null, allReply: true, excludeUrl: false, stripName: false, rng: [{ op: "choice", index: 0 }] };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
