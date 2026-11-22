import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { COLD_BOT_STATE, keywordBlobEntries } from "../src/blob-store";
import type { BotState } from "../src/bot-state";
import { keywordChunk } from "../src/keyword-rows";
import type { KeywordSelect } from "../src/keywords";

function rowKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => key.startsWith("keyword-rows-"));
}

function expectedChunks(anchors: readonly string[]): Set<string> {
  return new Set(anchors.map((anchor) => `keyword-rows-1-${keywordChunk(anchor)}`));
}

const NOW = "2024-05-01 00:00:00";

describe("keyword base blob", () => {
  const stub = env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE));

  beforeEach(async () => {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      await _instance.migrate();
    });
    await reset(stub);
  });

  it("serves get, list, and replies from the base blob alone", async () => {
    await putBase([{ id: "C1", keyword: "kbase", reply: "base" }, { id: null, keyword: "gonly", reply: "global" }]);
    await reset(stub);
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "kbase" })).toBe("base");
    expect(await stub.getKeyword({ scopeId: null, keyword: "gonly" })).toBe("global");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "gonly" })).toBeNull();
    expect(await stub.listKeywords("C1")).toEqual(["kbase"]);
    expect(await stub.listKeywords(null)).toEqual(["gonly"]);
    expect(replies(await stub.selectKeywordReplies(query("kbase", "C1")))).toEqual(["base"]);
  });

  it("keeps an overlay row when there is no base blob", async () => {
    expect(await stub.upsertKeyword(write("C1", "knew", "new", false))).toBe("written");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "knew" })).toBe("new");
    expect(await stub.listKeywords("C1")).toEqual(["knew"]);
    expect(replies(await stub.selectKeywordReplies(query("knew", "C1")))).toEqual(["new"]);
    expect(await stub.upsertKeyword(write("C1", "knew", "extra", true))).toBe("written");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "knew" })).toBe("extra__new");
    expect(await stub.deleteKeyword({ scopeId: "C1", author: "U1", keyword: "knew" })).toBe("deleted");
    expect(await stub.deleteKeyword({ scopeId: "C1", author: "U1", keyword: "knew" })).toBe("missing");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "knew" })).toBeNull();
  });

  it("lets an overlay override the base and a tombstone remove it", async () => {
    await putBase([
      { id: "C1", keyword: "k", reply: "old" },
      { id: "C1", keyword: "gone", reply: "x" },
      { id: "C1", keyword: "grow", reply: "old" },
    ]);
    await reset(stub);

    expect(await stub.upsertKeyword(write("C1", "k", "changed", false))).toBe("written");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "k" })).toBe("changed");
    expect(replies(await stub.selectKeywordReplies(query("k", "C1")))).toEqual(["changed"]);
    expect(await stub.upsertKeyword(write("C1", "grow", "extra", true))).toBe("written");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "grow" })).toBe("extra__old");
    expect(await stub.listKeywords("C1")).toHaveLength(3);

    expect(await stub.deleteKeyword({ scopeId: "C1", author: "U1", keyword: "gone" })).toBe("deleted");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "gone" })).toBeNull();
    expect(await stub.listKeywords("C1")).toEqual(["k", "grow"]);

    await reset(stub);
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "gone" })).toBeNull();
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "k" })).toBe("changed");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "grow" })).toBe("extra__old");
    expect(await stub.upsertKeyword(write("C1", "gone", "back", false))).toBe("written");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "gone" })).toBe("back");
  });

  it("keeps a protected base keyword for its author only", async () => {
    await putBase([{ id: "C1", author: "U1", keyword: "pk", reply: "secret##保護" }]);
    await reset(stub);
    expect(await stub.upsertKeyword(write("C1", "pk", "other", false, "U2"))).toBe("protected");
    expect(await stub.deleteKeyword({ scopeId: "C1", author: "U2", keyword: "pk" })).toBe("protected");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "pk" })).toBe("secret##保護");
    expect(await stub.upsertKeyword(write("C1", "pk", "mine", false, "U1"))).toBe("written");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "pk" })).toBe("mine");
    expect(await stub.deleteKeyword({ scopeId: "C1", author: "U1", keyword: "pk" })).toBe("deleted");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "pk" })).toBeNull();
  });

  it("matches the sql corpus for a reply", async () => {
    const rows = [
      { id: "C1", keyword: "exact", reply: "e" },
      { id: "C1", keyword: "other", reply: "o" },
    ];
    await putBase(rows);
    await reset(stub);
    const cold = await stub.selectKeywordReplies(query("exact", "C1"));
    const sqlStub = env.BOT_STATE.get(env.BOT_STATE.idFromName(`sql-${crypto.randomUUID()}`));
    await sqlStub.putKeywords(rows.map((row) => ({ ...row, author: "U1" })));
    const sql = await sqlStub.selectKeywordReplies(query("exact", "C1"));
    expect(cold).toEqual(sql);
  });

  it("loads only the hit chunks on a cold start, once each", async () => {
    const rows = [];
    for (let i = 0; i < 100; i += 1) rows.push({ id: "C1", keyword: `kw${i}`, reply: `r${i}` });
    await putBase(rows);
    await spyGets(stub);
    await reset(stub);
    const first = await readGets(stub);
    expect(first).toBe(3);
    expect(rowKeys(await readGetKeys(stub))).toEqual([]);

    expect(replies(await stub.selectKeywordReplies(query("kw50", "C1")))).toEqual(["r50"]);
    expect(new Set(rowKeys(await readGetKeys(stub)))).toEqual(expectedChunks(["kw5", "kw50"]));
    const afterFirst = await readGets(stub);

    expect(replies(await stub.selectKeywordReplies(query("kw50", "C1")))).toEqual(["r50"]);
    expect(await readGets(stub)).toBe(afterFirst);

    expect(replies(await stub.selectKeywordReplies(query("kw60", "C1")))).toEqual(["r60"]);
    expect(new Set(rowKeys(await readGetKeys(stub)))).toEqual(
      expectedChunks(["kw5", "kw50", "kw6", "kw60"]),
    );

    const meter = await installMeter(stub);
    expect(replies(await stub.selectKeywordReplies(query("kw60", "C1")))).toEqual(["r60"]);
    expect(await readMeter(stub)).toBe(0);
  });

  it("overrides a lazily loaded base chunk without reading it again", async () => {
    await putBase([{ id: "C1", keyword: "kw50", reply: "base" }]);
    await spyGets(stub);
    await reset(stub);
    const before = await readGets(stub);
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "kw50" })).toBe("base");
    const loaded = await readGets(stub);
    expect(loaded).toBe(before + 1);
    const chunks = rowKeys(await readGetKeys(stub));
    expect(chunks).toEqual([`keyword-rows-1-${keywordChunk("kw50")}`]);

    expect(await stub.upsertKeyword(write("C1", "kw50", "changed", false))).toBe("written");
    expect(rowKeys(await readGetKeys(stub))).toEqual(chunks);
    const afterUpsert = await readGets(stub);
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "kw50" })).toBe("changed");
    expect(await readGets(stub)).toBe(afterUpsert);
    expect(await stub.deleteKeyword({ scopeId: "C1", author: "U1", keyword: "kw50" })).toBe("deleted");
    expect(await stub.getKeyword({ scopeId: "C1", keyword: "kw50" })).toBeNull();
    expect(rowKeys(await readGetKeys(stub))).toEqual(chunks);
  });

  async function putBase(
    rows: Array<{ id: string | null; keyword: string; reply: string; author?: string | null }>,
  ): Promise<void> {
    const entries = keywordBlobEntries(rows);
    await runInDurableObject(stub, async (_instance, state) => {
      for (const entry of entries) {
        if (entry.bytes !== undefined) await state.storage.put(entry.key, entry.bytes.buffer);
        else await state.storage.put(entry.key, entry.json);
      }
    });
  }
});

function query(message: string, scopeId: string | null): KeywordSelect {
  return { message, scopeId, allReply: false, excludeUrl: false, stripName: false, rng: [] };
}

function replies(result: { replies: string[] | null }): string[] | null {
  return result.replies;
}

function write(scopeId: string, keyword: string, reply: string, plus: boolean, author = "U1") {
  return { scopeId, author, keyword, reply, plus, now: NOW };
}

async function reset(stub: DurableObjectStub<BotState>): Promise<void> {
  await stub.measureColdRequest(query("", null), 1);
}

async function spyGets(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const box = { n: 0, keys: [] as string[] };
    (globalThis as unknown as { __kwGets: typeof box }).__kwGets = box;
    const get = state.storage.get.bind(state.storage);
    state.storage.get = (async (key: string) => {
      box.n += 1;
      box.keys.push(key);
      return get(key);
    }) as typeof state.storage.get;
  });
}

async function readGets(stub: DurableObjectStub<BotState>): Promise<number> {
  return runInDurableObject(
    stub,
    () => (globalThis as unknown as { __kwGets: { n: number } }).__kwGets.n,
  );
}

async function readGetKeys(stub: DurableObjectStub<BotState>): Promise<string[]> {
  return runInDurableObject(
    stub,
    () => (globalThis as unknown as { __kwGets: { keys: string[] } }).__kwGets.keys,
  );
}

async function installMeter(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const box = { n: 0 };
    (globalThis as unknown as { __kwMeter: { n: number } }).__kwMeter = box;
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    state.storage.sql.exec = ((query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...(bindings as never[]));
      box.n += cursor.rowsRead;
      return cursor;
    }) as typeof state.storage.sql.exec;
  });
}

async function readMeter(stub: DurableObjectStub<BotState>): Promise<number> {
  return runInDurableObject(
    stub,
    () => (globalThis as unknown as { __kwMeter: { n: number } }).__kwMeter.n,
  );
}
