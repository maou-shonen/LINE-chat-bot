import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import type { KeywordSelect } from "../src/keywords";

const QUERY: KeywordSelect = {
  message: "zze7anchorzz",
  scopeId: "g",
  allReply: false,
  excludeUrl: false,
  stripName: false,
  rng: [],
};

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

describe("keyword compaction races", () => {
  it("writes every chunk when compact steps are called concurrently", async () => {
    const state: DurableObjectStub<BotState> = env.BOT_STATE.get(
      env.BOT_STATE.idFromName(`race-steps-${crypto.randomUUID()}`),
    );
    await state.putKeywords(rows("a", 48));
    const done = await runInDurableObject(state, async (instance: BotState) => {
      for (let round = 0; round < 500; round += 1) {
        const steps = await Promise.all(
          Array.from({ length: 8 }, () => instance.compactKeywordCache()),
        );
        if (steps.every((step) => step.done)) return true;
      }
      return false;
    });
    expect(done).toBe(true);
    const meta = await stored(state);
    expect(meta.chunks).toBe(64);
    expect(meta.keys).toBe(64);
    const audit = await state.auditKeywordSelect({ ...QUERY, message: "zza7anchorzz" });
    expect(audit.memory.length).toBeGreaterThan(0);
    expect(audit.memory).toEqual(audit.sql);
  });

  it("keeps the cache and job straight while measureColdRequest runs mid-compaction", async () => {
    const state: DurableObjectStub<BotState> = env.BOT_STATE.get(
      env.BOT_STATE.idFromName(`race-measure-${crypto.randomUUID()}`),
    );
    await state.putKeywords(rows("b", 48));
    await finish(state);
    await state.putKeywords(rows("c", 40));
    await state.compactKeywordCache();
    await runInDurableObject(state, async (instance: BotState) => {
      for (let round = 0; round < 50; round += 1) {
        const steps = await Promise.all([
          instance.compactKeywordCache(),
          instance.compactKeywordCache(),
          instance.measureColdRequest(QUERY, 1),
        ]);
        if (steps[0]?.done === true && steps[1]?.done === true) return;
      }
    });
    await finish(state);
    const meta = await stored(state);
    expect(meta.chunks).toBe(64);
    expect(meta.keys).toBe(64);
    const audit = await state.auditKeywordSelect({ ...QUERY, message: "zzc7anchorzz" });
    expect(audit.memory.length).toBeGreaterThan(0);
    expect(audit.memory).toEqual(audit.sql);
  });
});
