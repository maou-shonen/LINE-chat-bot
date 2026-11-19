import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import { parseCountMessage } from "../src/counts";

const NOW = "2023-11-14 22:13:20";
const LATER = "2023-11-14 22:13:21";

describe("message counts", () => {
  it("matches the fixture slices for text, sticker, image, and url", async () => {
    const state = freshState();
    await state.recordMessage(
      { kind: "text", text: "q".repeat(301), source: { userId: "U_own", groupId: "C_plain" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "sticker", source: { userId: "U_stat", groupId: "C_stats" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "image", source: { userId: "U_own", groupId: "C_img" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "text", text: "look http://example.com/ here", source: { userId: "U_own", groupId: "C_url" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "text", text: "look http://evil.invalid/ here", source: { userId: "U_own", groupId: "C_url" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "image", source: { userId: "U_dm", groupId: null } },
      NOW,
    );
    await state.recordMessage(
      { kind: "text", text: "http://example.com/x", source: { userId: "U_dm", groupId: null } },
      NOW,
    );

    const rows = await state.inspectTouch();
    expect(rows.counts["C_plain\0U_own"]).toEqual({ 對話: 1, 髒話: 0, 字數: 301 });
    expect(rows.counts["C_stats\0U_stat"]).toEqual({ 貼圖: 1 });
    expect(rows.counts["C_img\0U_own"]).toEqual({ 圖片: 1 });
    expect(rows.counts["C_url\0U_own"]).toEqual({ 網頁: 2 });
    expect(rows.counts["\0U_dm"]).toBeUndefined();
    expect(rows.users.map((user) => user.id).sort()).toEqual(["U_dm", "U_own", "U_stat"]);
    expect(rows.users.every((user) => user.name === null)).toBe(true);
  });

  it("creates each row once and adds the next count onto the same keys", async () => {
    const state = freshState();
    const source = { userId: "U1", groupId: "C1" };
    await state.recordMessage({ kind: "text", text: "hi", source }, NOW);
    await state.recordMessage({ kind: "sticker", source }, LATER);
    await state.recordMessage({ kind: "text", text: "hi", source }, LATER);

    const rows = await state.inspectTouch();
    expect(rows.users).toEqual([
      { id: "U1", name: null, createOn: NOW, updateOn: LATER },
    ]);
    expect(rows.groups).toEqual([{ id: "C1", createOn: NOW, updateOn: LATER }]);
    expect(rows.counts["C1\0U1"]).toEqual({ 對話: 2, 髒話: 0, 字數: 4, 貼圖: 1 });
  });

  it("counts train and trigger, and does not count command text as dialogue", async () => {
    const state = freshState();
    const source = { userId: "U1", groupId: "C1" };
    await state.recordMessage({ kind: "text", text: "學習=a=b", source }, NOW);
    await state.recordMessage({ kind: "text", text: "學習", source }, NOW);
    await state.recordMessage({ kind: "text", text: "刪除", source }, NOW);
    await state.recordMessage({ kind: "text", text: "刪除=foo", source }, NOW);
    await state.recordMessage({ kind: "text", text: "意見=hi", source }, NOW);
    await state.recordMessage({ kind: "text", text: "設定", source }, NOW);
    await state.recordMessage({ kind: "text", text: " 學習=a=b", source }, NOW);

    expect((await state.inspectTouch()).counts["C1\0U1"]).toEqual({
      調教: 2,
      觸發: 1,
      對話: 1,
      髒話: 0,
      字數: 6,
    });
  });

  it("keeps url checks before lowercasing and counts code points", async () => {
    const state = freshState();
    await state.recordMessage(
      { kind: "text", text: "See HTTP://X", source: { userId: "U1", groupId: "C1" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "text", text: "https://example.com", source: { userId: "U1", groupId: "C2" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "text", text: "幹 http://x", source: { userId: "U1", groupId: "C3" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "text", text: "a😀Fuck", source: { userId: "U1", groupId: "C4" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "text", text: "", source: { userId: "U1", groupId: "C5" } },
      NOW,
    );
    await state.recordMessage(
      { kind: "sticker", source: { userId: null, groupId: "C6" } },
      NOW,
    );

    const counts = (await state.inspectTouch()).counts;
    expect(counts["C1\0U1"]).toEqual({ 對話: 1, 髒話: 0, 字數: 12 });
    expect(counts["C2\0U1"]).toEqual({ 網頁: 1 });
    expect(counts["C3\0U1"]).toEqual({ 網頁: 1 });
    expect(counts["C4\0U1"]).toEqual({ 對話: 1, 髒話: 1, 字數: 6 });
    expect(counts["C5\0U1"]).toEqual({});
    expect(counts["C6\0"]).toEqual({ 貼圖: 1 });
  });

  it("counts the word constructor as chat, not the inherited property", async () => {
    const state = freshState();
    await state.recordMessage(
      { kind: "text", text: "constructor", source: { userId: "U1", groupId: "C1" } },
      NOW,
    );
    expect((await state.inspectTouch()).counts["C1\0U1"]).toEqual({ 對話: 1, 髒話: 0, 字數: 11 });
  });

  it("rejects a message that is not text, sticker, or image", () => {
    expect(() =>
      parseCountMessage({ kind: "postback", source: { userId: "U1", groupId: "C1" } }),
    ).toThrow(/kind/);
  });
});

function freshState(): DurableObjectStub<BotState> {
  const id = env.BOT_STATE.idFromName(`counts-${crypto.randomUUID()}`);
  return env.BOT_STATE.get(id);
}
