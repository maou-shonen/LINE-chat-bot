import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import {
  selectKeywordReplies,
  type KeywordRow,
  type KeywordSelect,
  type RngOp,
} from "../src/keywords";

describe("keyword replies", () => {
  it("prefers the exact reply and does not draw", () => {
    const rows = [keyword("z**", "fuzzy"), keyword("zz", "exact")];
    expect(selectKeywordReplies(rows, query("zz")).replies).toEqual(["exact"]);
  });

  it("matches trailing, leading, both, and middle wildcards", () => {
    expect(selectKeywordReplies([keyword("pre**", "WV")], query("preYY", choice)).replies).toEqual(["WV"]);
    expect(selectKeywordReplies([keyword("pre**", "WV")], query("xxpreYY")).replies).toBeNull();
    expect(selectKeywordReplies([keyword("**suf", "WS")], query("xxsuf", choice)).replies).toEqual(["WS"]);
    expect(selectKeywordReplies([keyword("**suf", "WS")], query("sufxx")).replies).toBeNull();
    expect(selectKeywordReplies([keyword("**both**", "WB")], query("xxbothyy", choice)).replies).toEqual(["WB"]);
    expect(selectKeywordReplies([keyword("a**b", "AB")], query("axxb", choice)).replies).toEqual(["AB"]);
    expect(selectKeywordReplies([keyword("a**b", "AB")], query("zaxxb")).replies).toBeNull();
  });

  it("keeps the longer wildcard", () => {
    const rows = [keyword("ab**cd", "low"), keyword("abx**cd", "high")];
    expect(selectKeywordReplies(rows, query("abXqqcd", choice)).replies).toEqual(["high"]);
  });

  it("skips an @ reply in all-reply mode and says it does not know the word", () => {
    const rows = [keyword("atall", "@secret"), keyword("sharedx", "shared")];
    const miss = selectKeywordReplies(rows, query("愛醬atall", {
      allReply: true,
      stripName: true,
      rng: [{ op: "choice", index: 1 }],
    }));
    expect(miss.replies).toEqual(["愛醬不是很懂你說什麼"]);
    const hit = selectKeywordReplies(rows, query("愛醬sharedx", {
      allReply: true,
      stripName: true,
      rng: choice.rng,
    }));
    expect(hit.replies).toEqual(["shared"]);
  });

  it("splits on bars and draws the weighted reply from the fixture hex", () => {
    expect(selectKeywordReplies([keyword("md", "k1||k2")], query("md")).replies).toEqual(["k1", "k2"]);
    const drawn = selectKeywordReplies([keyword("wtp", "a%2__b%1")], query("wtp", {
      rng: [{ op: "uniform", hex: "0x1.9cc4575a93046p-2" }],
    }));
    expect(drawn.replies).toEqual(["a"]);
  });

  it("hits a long message through the anchor set and misses when the anchor is absent", async () => {
    const id = env.BOT_STATE.idFromName(`kw-${crypto.randomUUID()}`);
    const state: DurableObjectStub<BotState> = env.BOT_STATE.get(id);
    await state.putKeywords([
      { id: "C", author: "U", keyword: "qqlonganchor**", reply: "hitlong" },
      { id: "C", author: "U", keyword: "short", reply: "no" },
      { id: "OTHER", author: "U", keyword: "qqlonganchor**", reply: "other" },
    ]);
    const hit = await state.selectKeywordReplies(query(`${"q".repeat(220)}qqlonganchor${"q".repeat(90)}`, {
      ...choice,
      scopeId: null,
    }));
    expect(hit.replies).toEqual(["hitlong"]);
    const miss = await state.selectKeywordReplies(query("q".repeat(320), { scopeId: null }));
    expect(miss.replies).toBeNull();
    const scoped = await state.selectKeywordReplies(query("short", { scopeId: "C" }));
    expect(scoped.replies).toEqual(["no"]);
  });
});

const choice = { rng: [{ op: "choice", index: 0 }] satisfies RngOp[] };

function keyword(keywordText: string, reply: string): KeywordRow {
  return { id: "C", keyword: keywordText, reply, anchor: "" };
}

function query(message: string, extra: Partial<KeywordSelect> = {}): KeywordSelect {
  return {
    message,
    scopeId: "C",
    allReply: false,
    excludeUrl: false,
    stripName: false,
    rng: [],
    ...extra,
  };
}
