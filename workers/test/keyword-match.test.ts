import { describe, expect, it } from "vitest";
import { anchorOf, matchKeyword, type KeywordRow } from "../src/keywords";
import {
  applyRowDelta,
  decodeKeywordTable,
  encodeKeywordRows,
  matchingRows,
  rowsForHits,
} from "../src/keyword-rows";

const FIRST = { choice: <T>(items: readonly T[]): T => items[0] as T, uniform: () => 0 };

describe("matching row prefilter", () => {
  const rows: KeywordRow[] = [
    keyword("exact", "e0"),
    keyword("a**b", "ab-reply"),
    keyword("pre**", "pre-reply"),
    keyword("**suf", "suf-reply"),
    keyword("**both**", "both-reply"),
    keyword("😀**", "emoji-reply"),
    keyword("url**", "https://example.invalid"),
    keyword("@at**", "@secret"),
    keyword("small**", "😀"),
    keyword("longkeyword**", "long"),
  ];
  const table = decodeKeywordTable(encodeKeywordRows(rows, rows.map((_, index) => index)));
  const hits = ["", ...new Set(rows.map((row) => row.anchor))];
  const overlay = applyRowDelta(table, [
    { op: "put", id: "C", keyword: "exact", reply: "changed" },
    { op: "put", id: "C", keyword: "newword**", reply: "new" },
  ]);
  const overlayHits = [...hits, "newword"];

  for (const message of ["exact", "ab", "preYY", "xxbothyy", "😀qq", "urlyy", "atzz", "smallqq", "zzz", "newwordxx"]) {
    for (const allReply of [false, true]) {
      for (const excludeUrl of [false, true]) {
        it(`keeps the winner for ${JSON.stringify(message)} allReply=${allReply} excludeUrl=${excludeUrl}`, () => {
          const query = {
            message,
            scopeId: null,
            allReply,
            excludeUrl,
            stripName: false,
            rng: [],
          };
          for (const [name, target, list] of [
            ["stored", table, hits],
            ["overlay", overlay, overlayHits],
          ] as const) {
            const full = rowsForHits(target, message, query, list);
            const filtered = matchingRows(target, message, query, list);
            expect(filtered.candidates, name).toBeGreaterThanOrEqual(filtered.rows.length);
            const expected = matchKeyword(message, full, { allReply, excludeUrl }, FIRST);
            const actual = matchKeyword(message, filtered.rows, { allReply, excludeUrl }, FIRST);
            expect(actual, name).toBe(expected);
          }
        });
      }
    }
  }
});

function keyword(keywordText: string, reply: string): KeywordRow {
  return { id: "C", keyword: keywordText, reply, anchor: anchorOf(keywordText), author: null };
}
