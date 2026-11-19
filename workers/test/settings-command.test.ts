import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import {
  applySettingsCommand,
  readReplyFlags,
  settleSleep,
  type SettingsCommandInput,
  type SettingsCommandResult,
} from "../src/commands/settings";

const EPOCH = 1700000000;
const MENU = [
  "設定=別理我=開/關",
  "設定=個人詞庫=開/關",
  "設定=全回應=開/關",
  "設定=全圖片=開/關(需要全回應)",
  "設定=幫忙愛醬=開/關",
  "",
  "(不輸入值可查看說明)",
].join("\n");
const EMPTY_SHOW = "目前的設定\n<群組>\n無 (預設)\n<群組中的你>\n無 (預設)";
const ASLEEP_12H = "你的好友 愛醬 下線了\n(2023-11-15 10:13)";
const ASLEEP_1H = "你的好友 愛醬 下線了\n(2023-11-14 23:13)";
const ASLEEP_7D = "你的好友 愛醬 下線了\n(2023-11-21 22:13)";
const AWAKE = "你的好友 愛醬 上線啦！";
const NOT_ASLEEP = "愛醬沒睡 ╮(╯_╰)╭";

describe("settings commands", () => {
  it("shows the panel for every alias and does not store a row", async () => {
    const state = freshState();
    for (const text of ["設定", "設置", "set", "settings", "-s", "Settings"]) {
      expect(await command(state, text)).toEqual({ kind: "reply", messages: [MENU, EMPTY_SHOW] });
    }
    expect(await state.countSettings({ groupId: "C1", userId: "" })).toBe(0);
    expect(await state.countSettings({ groupId: "C1", userId: "U1" })).toBe(0);
  });

  it("stores group flags without creating the user row, and shows them in write order", async () => {
    const state = freshState();
    expect(await command(state, "設定=全回應=開")).toEqual({ kind: "reply", messages: ["設定完成"] });
    expect(await command(state, "設定=全圖片=開")).toEqual({ kind: "reply", messages: ["設定完成"] });
    expect(await command(state, "設定")).toEqual({
      kind: "reply",
      messages: [MENU, "目前的設定\n<群組>\n全回應 = 開啟\n全圖片 = 開啟\n<群組中的你>\n無 (預設)"],
    });
    expect(await state.getSettings({ groupId: "C1", userId: "" })).toEqual({
      groupId: "C1",
      userId: "",
      options: { 全回應: true, 全圖片: true },
      stored: true,
    });
    expect(await state.countSettings({ groupId: "C1", userId: "U1" })).toBe(0);
  });

  it("keeps insertion order when a later key sorts earlier", async () => {
    const state = freshState();
    await command(state, "設定=幫忙愛醬=開");
    await command(state, "設定=全回應=開");
    const shown = reply(await command(state, "設定"));
    expect(shown[1]).toBe("目前的設定\n<群組>\n幫忙愛醬 = 開啟\n全回應 = 開啟\n<群組中的你>\n無 (預設)");
  });

  it("stores false, then replaces it, and rejects an unknown word without writing", async () => {
    const state = freshState();
    for (const word of ["0", "false", "no", "n", "否", "假", "關", "關閉", "取消"]) {
      expect(await command(state, `設定=全回應=${word}`)).toEqual({ kind: "reply", messages: ["設定完成"] });
      expect((await state.getSettings({ groupId: "C1", userId: "" })).options["全回應"]).toBe(false);
    }
    for (const word of ["1", "true", "yes", "y", "on", "是", "真", "開", "開啟", "打開", "確定"]) {
      expect(await command(state, `set=全回應=${word}`)).toEqual({ kind: "reply", messages: ["設定完成"] });
      expect((await state.getSettings({ groupId: "C1", userId: "" })).options["全回應"]).toBe(true);
    }
    expect(await command(state, "設定=全回應=ON")).toEqual({
      kind: "reply",
      messages: ["設定錯誤 <無法辨識: ON>"],
    });
    expect((await state.getSettings({ groupId: "C1", userId: "" })).options["全回應"]).toBe(true);
    expect(await state.countSettings({ groupId: "C1", userId: "" })).toBe(1);
  });

  it("returns the Python help text, including the 全圖片 mismatch", async () => {
    const state = freshState();
    expect(await command(state, "設定=全回應")).toEqual({
      kind: "reply",
      messages: ["開啟後愛醬開頭的對話將從全部的詞庫中產生反應\n「預設:關」"],
    });
    expect(await command(state, "設定=全圖片")).toEqual({
      kind: "reply",
      messages: [
        "開啟後全回應的結果包含圖片\n(需要開啟全圖片)\n(注意:圖片沒有任何審核 有可能出現不適圖片 如可接受再開啟)\n「預設:關」",
      ],
    });
    expect(await command(state, "設定=幫忙愛醬")).toEqual({
      kind: "reply",
      messages: [
        "開啟後會快取群組的對話紀錄\n只用於機器學習\n作者會稍微過目後進行分類丟入程式\n用完後刪除「預設:關」\n使用「設定=幫忙愛醬=開」開啟",
      ],
    });
    expect(await command(state, "設定=別理我")).toEqual({
      kind: "reply",
      messages: ["開啟後愛醬不會在此群組對你產生回應\n(愛醬開頭還是可以強制呼叫)\n「預設:關」"],
    });
    expect(await command(state, "設定=個人詞庫")).toEqual({
      kind: "reply",
      messages: ["開啟後會對你的個人詞庫產生回應\n「預設:關」"],
    });
    expect(await state.countSettings({ groupId: "C1", userId: "" })).toBe(0);
  });

  it("stores user flags on the speaker and refuses them without a user id", async () => {
    const state = freshState();
    expect(await command(state, "設定=別理我=開")).toEqual({ kind: "reply", messages: ["設定完成"] });
    expect(await command(state, "設定=個人詞庫=關", { groupId: "C1", userId: "U1" })).toEqual({
      kind: "reply",
      messages: ["設定完成"],
    });
    expect(await state.getSettings({ groupId: "C1", userId: "U1" })).toEqual({
      groupId: "C1",
      userId: "U1",
      options: { 別理我: true, 個人詞庫: false },
      stored: true,
    });
    expect(await state.countSettings({ groupId: "C1", userId: "" })).toBe(0);
    expect(await command(state, "設定=別理我=開", { groupId: "C1", userId: null })).toEqual({
      kind: "reply",
      messages: ["權限不足\nhttps://goo.gl/zTwaL2\n"],
    });
    expect(await command(state, "設定=全回應=開", { groupId: "C1", userId: null })).toEqual({
      kind: "reply",
      messages: ["設定完成"],
    });
  });

  it("rejects unknown and removed keys without writing", async () => {
    const state = freshState();
    expect(await command(state, "設定=不存在的鍵=開")).toEqual({ kind: "reply", messages: ["沒有此設定喔"] });
    expect(await command(state, "設定=過濾髒話")).toEqual({ kind: "reply", messages: ["這設定已經移除了"] });
    expect(await command(state, "設定=髒話過濾=開")).toEqual({ kind: "reply", messages: ["這設定已經移除了"] });
    expect(await state.countSettings({ groupId: "C1", userId: "" })).toBe(0);
  });

  it("does not claim direct messages, spaced orders, or unrelated text", async () => {
    const state = freshState();
    expect(await command(state, "設定", { groupId: null, userId: "U_dmset" })).toEqual({ kind: "pass" });
    expect(await command(state, " 設定")).toEqual({ kind: "pass" });
    expect(await command(state, "網頁設定")).toEqual({ kind: "pass" });
    expect(await command(state, "愛醬安靜", { groupId: null, userId: "U1" })).toEqual({ kind: "pass" });
    expect(await state.countSettings({ groupId: "C1", userId: "__sleep__" })).toBe(0);
  });

  it("sleeps for 12 hours, clamps 0 and 999, and accepts every sleep alias", async () => {
    const state = freshState();
    for (const text of ["愛醬安靜", "愛醬閉嘴", "愛醬睡覺", "愛醬下線", "愛醬安靜=abc", "愛醬安靜="]) {
      expect(await command(state, text)).toEqual({ kind: "reply", messages: [ASLEEP_12H] });
    }
    expect(await state.getSettings({ groupId: "C1", userId: "__sleep__" })).toEqual({
      groupId: "C1",
      userId: "__sleep__",
      options: { 暫停: 1700043200 },
      stored: true,
    });
    expect(await command(state, "愛醬安靜=1")).toEqual({ kind: "reply", messages: [ASLEEP_1H] });
    expect(await command(state, "愛醬安靜=0")).toEqual({ kind: "reply", messages: [ASLEEP_1H] });
    expect(await command(state, "愛醬安靜=999")).toEqual({ kind: "reply", messages: [ASLEEP_7D] });
    expect(await command(state, "愛醬安靜= 2 ")).toEqual({
      kind: "reply",
      messages: ["你的好友 愛醬 下線了\n(2023-11-15 00:13)"],
    });
    expect((await state.getSettings({ groupId: "C1", userId: "__sleep__" })).options["暫停"]).toBe(1700007200);
  });

  it("wakes once, keeps unrelated sleep keys, and says it was not asleep after that", async () => {
    const state = freshState();
    for (const text of ["愛醬講話", "愛醬說話", "愛醬聊天", "愛醬起床", "愛醬起來", "愛醬上線"]) {
      expect(await command(state, text)).toEqual({ kind: "reply", messages: [NOT_ASLEEP] });
    }
    await state.upsertSettings({ groupId: "C1", userId: "__sleep__" }, { 暫停: 1, 其他: true });
    expect(await command(state, "愛醬起床")).toEqual({ kind: "reply", messages: [AWAKE] });
    expect(await state.getSettings({ groupId: "C1", userId: "__sleep__" })).toEqual({
      groupId: "C1",
      userId: "__sleep__",
      options: { 其他: true },
      stored: true,
    });
    expect(await command(state, "愛醬講話")).toEqual({ kind: "reply", messages: [NOT_ASLEEP] });
  });

  it("deletes the sleep row when 暫停 was the only key", async () => {
    const state = freshState();
    await command(state, "愛醬安靜");
    expect(await command(state, "愛醬講話")).toEqual({ kind: "reply", messages: [AWAKE] });
    expect(await state.countSettings({ groupId: "C1", userId: "__sleep__" })).toBe(0);
    expect((await state.getSettings({ groupId: "C1", userId: "__sleep__" })).stored).toBe(false);
  });

  it("does not clear sleep from a normal message, and expires only after the deadline", async () => {
    const state = freshState();
    await command(state, "愛醬安靜");
    expect(await command(state, "hello")).toEqual({ kind: "pass" });
    expect(await settleSleep(state, { groupId: "C1", epoch: 1700043200 })).toEqual({ kind: "sleeping" });
    expect(await state.countSettings({ groupId: "C1", userId: "__sleep__" })).toBe(1);
    expect(await settleSleep(state, { groupId: "C1", epoch: 1700043201 })).toEqual({
      kind: "expired",
      messages: [AWAKE],
    });
    expect(await state.countSettings({ groupId: "C1", userId: "__sleep__" })).toBe(0);
    expect(await settleSleep(state, { groupId: "C1", epoch: 1700043201 })).toEqual({ kind: "awake" });
  });

  it("reads the four flags main() uses, defaulting to false", async () => {
    const state = freshState();
    expect(await readReplyFlags(state, { groupId: "C1", userId: "U1" })).toEqual({
      全回應: false,
      全圖片: false,
      別理我: false,
      個人詞庫: false,
    });
    await command(state, "設定=全回應=開");
    await command(state, "設定=全圖片=關");
    await command(state, "設定=別理我=開");
    expect(await readReplyFlags(state, { groupId: "C1", userId: "U1" })).toEqual({
      全回應: true,
      全圖片: false,
      別理我: true,
      個人詞庫: false,
    });
    expect(await readReplyFlags(state, { groupId: "C1", userId: "U2" })).toEqual({
      全回應: true,
      全圖片: false,
      別理我: false,
      個人詞庫: false,
    });
    expect(await state.countSettings({ groupId: "C1", userId: "U2" })).toBe(0);
  });
});

function freshState(): DurableObjectStub<BotState> {
  const id = env.BOT_STATE.idFromName(`settings-cmd-${crypto.randomUUID()}`);
  return env.BOT_STATE.get(id);
}

function command(
  state: DurableObjectStub<BotState>,
  text: string,
  source: { groupId: string | null; userId: string | null } = { groupId: "C1", userId: "U1" },
  epoch = EPOCH,
): Promise<SettingsCommandResult> {
  const input: SettingsCommandInput = { text, epoch, groupId: source.groupId, userId: source.userId };
  return applySettingsCommand(state, input);
}

function reply(result: SettingsCommandResult): readonly string[] {
  if (result.kind !== "reply") throw new Error("expected a reply");
  return result.messages;
}
