import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { COLD_BOT_STATE, keywordBlobEntries } from "../src/blob-store";
import type { BotState } from "../src/bot-state";
import type { KeywordSelect } from "../src/keywords";

const COUNT = 300;
const LENGTH = 5000;

describe("long keyword messages", () => {
  const cold = env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE));

  beforeEach(async () => {
    await runInDurableObject(cold, async (instance, state) => {
      await state.storage.deleteAll();
      await instance.migrate();
    });
  });

  it("returns the same replies as the sql corpus after a lazy reload", async () => {
    const rows = makeRows();
    const entries = keywordBlobEntries(rows);
    await runInDurableObject(cold, async (_instance, state) => {
      for (const entry of entries) {
        if (entry.bytes !== undefined) await state.storage.put(entry.key, entry.bytes.buffer);
        else await state.storage.put(entry.key, entry.json);
      }
    });
    const sql = env.BOT_STATE.get(env.BOT_STATE.idFromName(`long-${crypto.randomUUID()}`));
    await sql.putKeywords(rows.map((row) => ({ ...row, author: "U1" })));

    const query = queryFor(makeMessage());
    const coldResult = await cold.selectKeywordReplies(query);
    const sqlResult = await sql.selectKeywordReplies(query);
    expect(coldResult).toEqual(sqlResult);
    expect(coldResult.replies).not.toBeNull();
    expect(coldResult.candidates).toBeGreaterThan(COUNT - 10);

    await cold.measureColdRequest(queryFor("", []), 1);
    expect(await cold.selectKeywordReplies(query)).toEqual(sqlResult);
    expect(await cold.keywordCacheStats()).toMatchObject({ rowChunks: 8, anchors: COUNT });
  });
});

function makeRows(): Array<{ id: string; keyword: string; reply: string }> {
  const rows = [];
  for (let i = 0; i < COUNT; i += 1) {
    rows.push({ id: "G", keyword: String.fromCharCode(0x4e00 + i), reply: `r${i}` });
  }
  return rows;
}

function makeMessage(): string {
  let text = "";
  for (let i = 0; text.length < LENGTH; i += 1) text += String.fromCharCode(0x4e00 + (i % COUNT));
  return text.slice(0, LENGTH);
}

function queryFor(message: string, rng: KeywordSelect["rng"] = [{ op: "choice", index: 0 }]): KeywordSelect {
  return {
    message,
    scopeId: null,
    allReply: true,
    excludeUrl: false,
    stripName: false,
    rng,
  };
}
