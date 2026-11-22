import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";

const INTERVAL_MS = 60_000;
const WINDOW_MS = 30 * 60_000;

type TrafficBox = { lastTrafficAt: number | null };

function stub(name: string): DurableObjectStub<BotState> {
  return env.BOT_STATE.get(env.BOT_STATE.idFromName(`keepalive-${name}-${crypto.randomUUID()}`));
}

function post(): Request {
  return new Request("https://example.test/ping", { method: "POST" });
}

async function gatedTraffic(
  instance: BotState,
  ctx: DurableObjectState,
  call: () => Promise<void>,
): Promise<{ atReply: { gets: number; sets: number }; sets: number; alarm: number | null; now: number }> {
  const getAlarm = ctx.storage.getAlarm.bind(ctx.storage);
  const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resumed = () => {};
  const resumedP = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  let scheduled = () => {};
  const scheduledP = new Promise<void>((resolve) => {
    scheduled = resolve;
  });
  let gets = 0;
  let sets = 0;
  ctx.storage.getAlarm = async () => {
    gets += 1;
    await gate;
    resumed();
    return await getAlarm();
  };
  ctx.storage.setAlarm = async (at: number) => {
    sets += 1;
    scheduled();
    return setAlarm(at);
  };
  await call();
  const atReply = { gets, sets };
  release();
  await resumedP;
  await scheduledP;
  return { atReply, sets, alarm: await getAlarm(), now: Date.now() };
}

describe("keep-alive alarm", () => {
  it("schedules a keep-alive after the reply when no alarm exists", async () => {
    const state = stub("fetch");
    const seen = await runInDurableObject(state, async (instance, ctx) => {
      await ctx.storage.deleteAlarm();
      let status = 0;
      const traffic = await gatedTraffic(instance, ctx, async () => {
        status = (await instance.fetch(post())).status;
      });
      return { status, ...traffic };
    });
    expect(seen.status).toBe(200);
    expect(seen.atReply).toEqual({ gets: 1, sets: 0 });
    expect(seen.sets).toBe(1);
    expect(seen.alarm).toBeGreaterThanOrEqual(seen.now + INTERVAL_MS - 1000);
    expect(seen.alarm).toBeLessThanOrEqual(seen.now + INTERVAL_MS + 1000);
  });

  it("treats a message RPC as traffic and schedules after it returns", async () => {
    const state = stub("rpc");
    const seen = await runInDurableObject(state, async (instance, ctx) => {
      await ctx.storage.deleteAlarm();
      return await gatedTraffic(instance, ctx, async () => {
        await instance.recordMessage(
          { kind: "sticker", source: { userId: "U1", groupId: null } },
          "2024-01-02 03:04:05",
        );
      });
    });
    expect(seen.atReply).toEqual({ gets: 1, sets: 0 });
    expect(seen.sets).toBe(1);
    expect(seen.alarm).toBeGreaterThanOrEqual(seen.now + INTERVAL_MS - 1000);
  });

  it("does not overwrite an earlier hydration, compaction or prefetch alarm", async () => {
    const state = stub("earlier");
    const earlier = Date.now() + 5_000;
    const seen = await runInDurableObject(state, async (instance, ctx) => {
      await ctx.storage.setAlarm(earlier);
      const getAlarm = ctx.storage.getAlarm.bind(ctx.storage);
      const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let resumed = () => {};
      const resumedP = new Promise<void>((resolve) => {
        resumed = resolve;
      });
      let sets = 0;
      ctx.storage.getAlarm = async () => {
        await gate;
        const at = await getAlarm();
        resumed();
        return at;
      };
      ctx.storage.setAlarm = async (at: number) => {
        sets += 1;
        return setAlarm(at);
      };
      const response = await instance.fetch(post());
      const atReply = sets;
      release();
      await resumedP;
      // The resumed consumer runs before this storage round trip resolves.
      const alarm = await getAlarm();
      return { status: response.status, atReply, sets, alarm };
    });
    expect(seen).toEqual({ status: 200, atReply: 0, sets: 0, alarm: earlier });
  });

  it("renews every interval until the traffic window closes and stops without traffic", async () => {
    const state = stub("renew");
    const seen = await runInDurableObject(state, async (instance, ctx) => {
      const box = instance as unknown as TrafficBox;
      await ctx.storage.deleteAlarm();
      await instance.alarm();
      const coldWake = await ctx.storage.getAlarm();

      box.lastTrafficAt = Date.now() - WINDOW_MS + 5 * 60_000;
      await instance.alarm();
      const first = await ctx.storage.getAlarm();
      const firstAt = Date.now();
      await ctx.storage.deleteAlarm();
      await instance.alarm();
      const second = await ctx.storage.getAlarm();

      await ctx.storage.deleteAlarm();
      box.lastTrafficAt = Date.now() - WINDOW_MS - 1;
      await instance.alarm();
      const expired = await ctx.storage.getAlarm();
      return { coldWake, first, firstAt, second, expired, now: Date.now() };
    });
    expect(seen.coldWake).toBeNull();
    expect(seen.first).not.toBeNull();
    expect(seen.second).not.toBeNull();
    expect(seen.first).toBeGreaterThanOrEqual(seen.firstAt + INTERVAL_MS - 1000);
    expect(seen.first).toBeLessThanOrEqual(seen.now + INTERVAL_MS + 1000);
    expect(seen.second).toBeGreaterThanOrEqual(seen.first ?? 0);
    expect(seen.expired).toBeNull();
  });

  it("a keep-alive alarm writes no rows", async () => {
    const state = stub("rows");
    const written = await runInDurableObject(state, async (instance, ctx) => {
      const box = { n: 0 };
      const exec = ctx.storage.sql.exec.bind(ctx.storage.sql);
      ctx.storage.sql.exec = ((query: string, ...bindings: unknown[]) => {
        const cursor = exec(query, ...(bindings as never[]));
        box.n += cursor.rowsWritten;
        return cursor;
      }) as typeof ctx.storage.sql.exec;
      (instance as unknown as TrafficBox).lastTrafficAt = Date.now();
      await ctx.storage.deleteAlarm();
      await instance.alarm();
      return box.n;
    });
    expect(written).toBe(0);
    expect(await state.keywordCacheStats()).toMatchObject({ rowChunksLoaded: 0 });
  });
});
