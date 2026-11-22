import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import type { KeywordSelect } from "../src/keywords";

type GetBox = { calls: string[][] };
type MeterBox = { n: number };
// Both boxes live on the isolate globalThis shared by runInDurableObject calls.
type PrefetchGlobals = { __kwGets: GetBox; __kwMeter: MeterBox };

function query(message: string, scopeId: string | null): KeywordSelect {
  return { message, scopeId, allReply: false, excludeUrl: false, stripName: false, rng: [] };
}

function rows(prefix: string, count: number): Array<{ id: string; author: string; keyword: string; reply: string }> {
  const made = [];
  for (let i = 0; i < count; i += 1) {
    made.push({ id: "g", author: "U", keyword: `${prefix}${i}anchor`, reply: `${prefix}${i}` });
  }
  return made;
}

async function finish(state: DurableObjectStub<BotState>): Promise<void> {
  for (let round = 0; round < 500; round += 1) {
    const step = await state.compactKeywordCache();
    if (step.done) return;
  }
  throw new Error("compaction did not finish");
}

async function stored(state: DurableObjectStub<BotState>): Promise<{ gen: number; chunks: number; keys: number }> {
  return await runInDurableObject(state, async (_instance: BotState, ctx) => {
    const meta = await ctx.storage.get("keyword-cache-meta") as { rowGen?: number; rowChunks?: number } | undefined;
    const gen = meta?.rowGen ?? 0;
    const keys = (await ctx.storage.list({ prefix: `keyword-rows-${gen}-` })).size;
    return { gen, chunks: meta?.rowChunks ?? 0, keys };
  });
}

async function spyGets(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const box: GetBox = { calls: [] };
    (globalThis as unknown as PrefetchGlobals).__kwGets = box;
    const get = state.storage.get.bind(state.storage);
    state.storage.get = (async (key: string | string[]) => {
      box.calls.push(Array.isArray(key) ? [...key] : [key]);
      return (get as (key: string | string[]) => Promise<unknown>)(key);
    }) as typeof state.storage.get;
  });
}

async function installMeter(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const box: MeterBox = { n: 0 };
    (globalThis as unknown as PrefetchGlobals).__kwMeter = box;
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    state.storage.sql.exec = ((query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...(bindings as never[]));
      box.n += cursor.rowsWritten;
      return cursor;
    }) as typeof state.storage.sql.exec;
  });
}

async function readSpy(stub: DurableObjectStub<BotState>): Promise<{ calls: string[][]; written: number; gen: number }> {
  return await runInDurableObject(stub, async (_instance, ctx) => {
    const globals = globalThis as unknown as PrefetchGlobals;
    const calls = globals.__kwGets.calls.map((call) => [...call]);
    const written = globals.__kwMeter.n;
    const meta = await ctx.storage.get("keyword-cache-meta") as { rowGen?: number } | undefined;
    return { calls, written, gen: meta?.rowGen ?? 0 };
  });
}

async function runAlarms(state: DurableObjectStub<BotState>, max: number): Promise<boolean> {
  return await runInDurableObject(state, async (instance: BotState) => {
    for (let step = 0; step < max; step += 1) {
      await instance.alarm();
      if ((await instance.keywordCacheStats()).rowChunksLoaded === 64) return true;
    }
    return false;
  });
}

async function expectAuditMatches(state: DurableObjectStub<BotState>, message: string): Promise<void> {
  const audit = await state.auditKeywordSelect(query(message, "g"));
  expect(audit.memory.length).toBeGreaterThan(0);
  expect(audit.memory).toEqual(audit.sql);
  expect(audit.replies).toEqual(audit.sqlReplies);
}

describe("keyword chunk prefetch", () => {
  it("prefetches every row chunk two at a time", async () => {
    const prefix = "pa";
    const state: DurableObjectStub<BotState> = env.BOT_STATE.get(
      env.BOT_STATE.idFromName(`prefetch-a-${crypto.randomUUID()}`),
    );
    await state.putKeywords(rows(prefix, 48));
    await finish(state);
    await spyGets(state);
    await installMeter(state);
    await state.measureColdRequest(query("", null), 1);
    const cold = await state.keywordCacheStats();
    expect(cold.rowChunksLoaded).toBe(0);
    expect(cold.rowChunks).toBe(64);

    expect(await runAlarms(state, 40)).toBe(true);

    const { calls, written, gen } = await readSpy(state);
    const rowKeys = calls.flat().filter((key) => key.startsWith("keyword-rows-"));
    const expected = new Set(Array.from({ length: 64 }, (_, id) => `keyword-rows-${gen}-${id}`));
    expect(new Set(rowKeys)).toEqual(expected);
    for (const call of calls) {
      expect(call.filter((key) => key.startsWith("keyword-rows-")).length).toBeLessThanOrEqual(2);
    }
    expect(written).toBe(0);
    await expectAuditMatches(state, `zz${prefix}7anchorzz`);
  });

  it("keeps replies equal to sql while prefetch runs", async () => {
    const prefix = "pb";
    const state: DurableObjectStub<BotState> = env.BOT_STATE.get(
      env.BOT_STATE.idFromName(`prefetch-b-${crypto.randomUUID()}`),
    );
    await state.putKeywords(rows(prefix, 48));
    await finish(state);
    await state.measureColdRequest(query("", null), 1);

    await runInDurableObject(state, async (instance: BotState) => {
      await instance.alarm();
    });
    await expectAuditMatches(state, `zz${prefix}7anchorzz`);

    expect(await runAlarms(state, 40)).toBe(true);
    await expectAuditMatches(state, `zz${prefix}7anchorzz`);
  });

  it("prefetch and compaction together leave every chunk and meta whole", async () => {
    const prefix = "pc";
    const state: DurableObjectStub<BotState> = env.BOT_STATE.get(
      env.BOT_STATE.idFromName(`prefetch-c-${crypto.randomUUID()}`),
    );
    const base = rows(prefix, 48);
    await state.putKeywords(base);
    await finish(state);
    // 40 put ops, over the 32-op delta limit, and row 47 is in the delta.
    await state.putKeywords(base.slice(8));
    await state.measureColdRequest(query("", null), 1);

    await runInDurableObject(state, async (instance: BotState) => {
      for (let round = 0; round < 80; round += 1) {
        await Promise.all([
          instance.alarm(),
          instance.alarm(),
          instance.compactKeywordCache(),
          instance.compactKeywordCache(),
        ]);
      }
    });
    await finish(state);
    const meta = await stored(state);
    expect(meta.chunks).toBe(64);
    expect(meta.keys).toBe(64);
    expect((await state.keywordCacheStats()).rowChunksLoaded).toBe(64);
    await expectAuditMatches(state, `zz${prefix}47anchorzz`);
  });
});
