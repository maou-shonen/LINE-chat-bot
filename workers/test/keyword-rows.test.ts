import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import type { KeywordSelect, RngOp } from "../src/keywords";

describe("keyword row cache", () => {
  it("matches sql while a compact step is in progress", async () => {
    const id = env.BOT_STATE.idFromName(`mid-${crypto.randomUUID()}`);
    const state: DurableObjectStub<BotState> = env.BOT_STATE.get(id);
    const batch = [];
    for (let i = 0; i < 4000; i += 1) {
      batch.push({ id: "g", author: "U", keyword: `hold${i}anchor`, reply: "r" });
    }
    await state.putKeywords(batch);
    const mid = await state.compactKeywordCache();
    expect(mid.done).toBe(false);
    expect(mid.ms).toBeLessThan(5);
    await state.putKeywords([{ id: "g", author: "U", keyword: "duringcompact", reply: "d" }]);
    const query: KeywordSelect = {
      message: "zzduringcompactzz",
      scopeId: "g",
      allReply: false,
      excludeUrl: false,
      stripName: false,
      rng: [],
    };
    const live = await state.auditKeywordSelect(query);
    expect(live.memory).toEqual(live.sql);
    expect(live.replies).toEqual(live.sqlReplies);
    await state.measureColdRequest(query, 1);
    const cold = await state.auditKeywordSelect(query);
    expect(cold.memory).toEqual(cold.sql);
    expect(cold.replies).toEqual(cold.sqlReplies);
    for (;;) {
      const step = await state.compactKeywordCache();
      expect(step.ms).toBeLessThan(5);
      if (step.done) break;
    }
    const after = await state.auditKeywordSelect(query);
    expect(after.memory).toEqual(after.sql);
    expect(after.replies).toEqual(after.sqlReplies);
  });

  it("matches the sql candidate order and the fixed-rng reply", async () => {
    const id = env.BOT_STATE.idFromName(`rows-${crypto.randomUUID()}`);
    const state: DurableObjectStub<BotState> = env.BOT_STATE.get(id);
    const random = mulberry32(46);
    const scopes = ["group", "person"];
    const rows = [];
    for (let i = 0; i < 48; i += 1) {
      const anchor = token(random, 1 + Math.floor(random() * 6));
      const keyword = shapeKeyword(random, anchor);
      rows.push({
        id: scopes[Math.floor(random() * scopes.length)] ?? "group",
        author: "U",
        keyword,
        reply: shapeReply(random, i),
      });
    }
    await state.putKeywords(rows);
    await state.deleteKeyword({
      scopeId: rows[3]?.id ?? "group",
      author: "U",
      keyword: rows[3]?.keyword ?? "",
    });
    await state.putKeywords([{
      id: rows[5]?.id ?? "group",
      author: "U",
      keyword: rows[5]?.keyword ?? "x",
      reply: "@updated",
    }]);

    await state.putKeywords([{ id: "group", author: "U", keyword: "ab**😀😀", reply: "emoji-anchor" }]);
    const byCodePoint = await state.auditKeywordSelect({
      message: "zzabzz",
      scopeId: "group",
      allReply: false,
      excludeUrl: false,
      stripName: false,
      rng: [],
    });
    expect(byCodePoint.memory.join("\n")).toContain("ab**😀😀");
    expect(byCodePoint.sql.join("\n")).toContain("ab**😀😀");
    const utf16WouldHit = await state.auditKeywordSelect({
      message: "😀😀",
      scopeId: "group",
      allReply: false,
      excludeUrl: false,
      stripName: false,
      rng: [],
    });
    expect(utf16WouldHit.memory.join("\n")).not.toContain("ab**😀😀");
    expect(utf16WouldHit.sql).toEqual(utf16WouldHit.memory);
    for (;;) {
      const step = await state.compactKeywordCache();
      if (step.done) break;
    }
    await state.putKeywords([{ id: "group", author: "U", keyword: "pendinganchor", reply: "pending" }]);
    await state.deleteKeyword({
      scopeId: "group",
      author: "U",
      keyword: rows[7]?.keyword ?? "x",
    });
    const pending = await state.auditKeywordSelect({
      message: "zzpendinganchorzz",
      scopeId: "group",
      allReply: false,
      excludeUrl: false,
      stripName: false,
      rng: [],
    });
    expect(pending.memory).toEqual(pending.sql);
    expect(pending.replies).toEqual(pending.sqlReplies);
    await state.measureColdRequest({
      message: "zzpendinganchorzz",
      scopeId: "group",
      allReply: false,
      excludeUrl: false,
      stripName: false,
      rng: [],
    }, 1);
    const afterCold = await state.auditKeywordSelect({
      message: "zzpendinganchorzz",
      scopeId: "group",
      allReply: false,
      excludeUrl: false,
      stripName: false,
      rng: [],
    });
    expect(afterCold.memory).toEqual(afterCold.sql);
    expect(afterCold.replies).toEqual(afterCold.sqlReplies);

    await state.measureColdRequest({
      message: "x",
      scopeId: null,
      allReply: false,
      excludeUrl: false,
      stripName: false,
      rng: [],
    }, 1);
    for (const message of messages(random, rows.map((row) => row.keyword))) {
      for (const scopeId of [null, "group", "person"] as const) {
        for (const allReply of [false, true]) {
          const query: KeywordSelect = {
            message,
            scopeId,
            allReply,
            excludeUrl: allReply && scopeId === "group",
            stripName: false,
            rng: script(random),
          };
          const audit = await state.auditKeywordSelect(query);
          expect(audit.memory).toEqual(audit.sql);
          expect(audit.replies).toEqual(audit.sqlReplies);
        }
      }
    }
  });
});

function messages(random: () => number, keywords: string[]): string[] {
  const made = ["", "   ", keywords[0] ?? "x", `qq${keywords[7] ?? "x"}zz`];
  for (let i = 0; i < 6; i += 1) {
    const long = i % 2 === 0;
    let text = "";
    const n = long ? 320 + Math.floor(random() * 40) : 8 + Math.floor(random() * 40);
    for (let j = 0; j < n; j += 1) text += token(random, 1);
    if (random() < 0.7) {
      const keyword = keywords[Math.floor(random() * keywords.length)] ?? "x";
      const at = Math.floor(random() * text.length);
      text = `${text.slice(0, at)}${keyword.replaceAll("**", "")}${text.slice(at)}`;
    }
    made.push(text);
  }
  return made;
}

function shapeKeyword(random: () => number, anchor: string): string {
  const kind = Math.floor(random() * 5);
  if (kind === 0) return anchor;
  if (kind === 1) return `${anchor}**`;
  if (kind === 2) return `**${anchor}`;
  if (kind === 3) return `**${anchor}**`;
  return `${anchor.slice(0, 1)}**${anchor.slice(1)}`;
}

function shapeReply(random: () => number, index: number): string {
  const kind = Math.floor(random() * 5);
  if (kind === 0) return `@secret${index}`;
  if (kind === 1) return `https://example.test/${index}`;
  if (kind === 2) return `a${index}||b${index}`;
  if (kind === 3) return `left%2__right%1`;
  return `plain${index}-${Math.floor(random() * 9)}`;
}

function script(random: () => number): RngOp[] {
  return [
    { op: "choice", index: 0 },
    { op: "uniform", hex: "0x1.0000000000000p-2" },
    { op: "choice", index: 0 },
  ];
}

function token(random: () => number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(0x4e00 + Math.floor(random() * 80));
  }
  return text;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = state + 0x6d2b79f5 | 0;
    let next = Math.imul(state ^ state >>> 15, 1 | state);
    next = next + Math.imul(next ^ next >>> 7, 61 | next) ^ next;
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}
