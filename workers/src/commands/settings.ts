import type { SettingsKey, SettingsPatch, SettingsView } from "../settings";

export interface SettingsStore {
  getSettings(key: SettingsKey): Promise<SettingsView>;
  upsertSettings(key: SettingsKey, patch: SettingsPatch): Promise<void>;
  omitSettings(key: SettingsKey, names: readonly string[]): Promise<void>;
}

export interface SettingsCommandInput {
  text: string;
  groupId: string | null;
  userId: string | null;
  epoch: number;
}

export type SettingsCommandResult =
  | { kind: "pass" }
  | { kind: "reply"; messages: readonly string[] };

export type SleepSettlement =
  | { kind: "awake" }
  | { kind: "sleeping" }
  | { kind: "expired"; messages: readonly string[] };

export interface ReplyFlags {
  全回應: boolean;
  全圖片: boolean;
  別理我: boolean;
  個人詞庫: boolean;
}

const SLEEP_USER = "__sleep__";
const PAUSE = "暫停";
const WEEK_HOURS = 24 * 7;

const SETTINGS_ORDERS: Record<string, true> = {
  "-s": true,
  set: true,
  settings: true,
  設定: true,
  設置: true,
};
const SLEEP_ORDERS: Record<string, true> = {
  愛醬安靜: true,
  愛醬閉嘴: true,
  愛醬睡覺: true,
  愛醬下線: true,
};
const WAKE_ORDERS: Record<string, true> = {
  愛醬講話: true,
  愛醬說話: true,
  愛醬聊天: true,
  愛醬起床: true,
  愛醬起來: true,
  愛醬上線: true,
};
const REMOVED: Record<string, true> = {
  過濾髒話: true,
  髒話過濾: true,
};
const TRUE_WORDS: Record<string, true> = {
  "1": true,
  true: true,
  yes: true,
  y: true,
  on: true,
  是: true,
  真: true,
  開: true,
  開啟: true,
  打開: true,
  確定: true,
};
const FALSE_WORDS: Record<string, true> = {
  "0": true,
  false: true,
  no: true,
  n: true,
  否: true,
  假: true,
  關: true,
  關閉: true,
  取消: true,
};

const NO_PERMISSION = "權限不足\nhttps://goo.gl/zTwaL2\n";
const SLEEP_TEXT = "你的好友 愛醬 下線了";
const WAKE_TEXT = "你的好友 愛醬 上線啦！";
const NOT_ASLEEP = "愛醬沒睡 ╮(╯_╰)╭";
const SETTINGS_MENU = [
  "設定=別理我=開/關",
  "設定=個人詞庫=開/關",
  "設定=全回應=開/關",
  "設定=全圖片=開/關(需要全回應)",
  "設定=幫忙愛醬=開/關",
  "",
  "(不輸入值可查看說明)",
].join("\n");

type SettingScope = "group" | "user";

const SETTINGS: Record<string, { scope: SettingScope; help: string }> = {
  全回應: {
    scope: "group",
    help: "開啟後愛醬開頭的對話將從全部的詞庫中產生反應\n「預設:關」",
  },
  全圖片: {
    scope: "group",
    // Python help names 全圖片. The menu and check() require 全回應. Keep the mismatch.
    help: "開啟後全回應的結果包含圖片\n(需要開啟全圖片)\n(注意:圖片沒有任何審核 有可能出現不適圖片 如可接受再開啟)\n「預設:關」",
  },
  幫忙愛醬: {
    scope: "group",
    help: "開啟後會快取群組的對話紀錄\n只用於機器學習\n作者會稍微過目後進行分類丟入程式\n用完後刪除「預設:關」\n使用「設定=幫忙愛醬=開」開啟",
  },
  別理我: {
    scope: "user",
    help: "開啟後愛醬不會在此群組對你產生回應\n(愛醬開頭還是可以強制呼叫)\n「預設:關」",
  },
  個人詞庫: {
    scope: "user",
    help: "開啟後會對你的個人詞庫產生回應\n「預設:關」",
  },
};

export async function applySettingsCommand(
  store: SettingsStore,
  input: SettingsCommandInput,
): Promise<SettingsCommandResult> {
  if (input.groupId === null) return { kind: "pass" };
  if (!Number.isFinite(input.epoch)) throw new TypeError("epoch must be a finite number");
  const parsed = parseOrder(input.text.replaceAll('"', "\uFF02").replaceAll("'", "\u2019").replaceAll(";", "\uFF1B"));
  if (SETTINGS_ORDERS[parsed.order]) {
    return applyPanel(store, input.groupId, input.userId, parsed);
  }
  if (SLEEP_ORDERS[parsed.order]) {
    return applySleep(store, input.groupId, input.epoch, parsed.key);
  }
  if (WAKE_ORDERS[parsed.order]) {
    return applyWake(store, input.groupId);
  }
  return { kind: "pass" };
}

export async function settleSleep(
  store: SettingsStore,
  input: { groupId: string | null; epoch: number },
): Promise<SleepSettlement> {
  if (!Number.isFinite(input.epoch)) throw new TypeError("epoch must be a finite number");
  const key = sleepKey(input.groupId ?? "");
  const until = (await store.getSettings(key)).options[PAUSE];
  if (until === undefined) return { kind: "awake" };
  if (typeof until !== "number" || !Number.isFinite(until)) {
    throw new TypeError("暫停 was not a finite number");
  }
  if (input.epoch > until) {
    await store.omitSettings(key, [PAUSE]);
    return { kind: "expired", messages: [WAKE_TEXT] };
  }
  return { kind: "sleeping" };
}

export async function readReplyFlags(
  store: SettingsStore,
  source: { groupId: string; userId: string | null },
): Promise<ReplyFlags> {
  const group = await store.getSettings(groupKey(source.groupId));
  const user = await store.getSettings(userKey(source.groupId, source.userId ?? ""));
  return {
    全回應: Boolean(group.options["全回應"]),
    全圖片: Boolean(group.options["全圖片"]),
    別理我: Boolean(user.options["別理我"]),
    個人詞庫: Boolean(user.options["個人詞庫"]),
  };
}

async function applyPanel(
  store: SettingsStore,
  groupId: string,
  userId: string | null,
  parsed: ParsedOrder,
): Promise<SettingsCommandResult> {
  if (parsed.key === null) {
    return { kind: "reply", messages: [SETTINGS_MENU, await formatShow(store, groupId, userId)] };
  }
  try {
    if (REMOVED[parsed.key]) {
      return { kind: "reply", messages: ["這設定已經移除了"] };
    }
    const setting = SETTINGS[parsed.key];
    if (setting === undefined) {
      return { kind: "reply", messages: ["沒有此設定喔"] };
    }
    if (parsed.value === null) {
      return { kind: "reply", messages: [setting.help] };
    }
    const value = text2bool(parsed.value);
    if (setting.scope === "user") {
      if (userId === null) return { kind: "reply", messages: [NO_PERMISSION] };
      await store.upsertSettings(userKey(groupId, userId), { [parsed.key]: value });
    } else {
      await store.upsertSettings(groupKey(groupId), { [parsed.key]: value });
    }
    return { kind: "reply", messages: ["設定完成"] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "reply", messages: [`設定錯誤 <${message}>`] };
  }
}

async function applySleep(
  store: SettingsStore,
  groupId: string,
  epoch: number,
  key: string | null,
): Promise<SettingsCommandResult> {
  const until = epoch + 60 * 60 * clampedHours(key);
  await store.upsertSettings(sleepKey(groupId), { [PAUSE]: until });
  return { kind: "reply", messages: [`${SLEEP_TEXT}\n(${formatMinute(until)})`] };
}

async function applyWake(store: SettingsStore, groupId: string): Promise<SettingsCommandResult> {
  const key = sleepKey(groupId);
  if ((await store.getSettings(key)).options[PAUSE] === undefined) {
    return { kind: "reply", messages: [NOT_ASLEEP] };
  }
  await store.omitSettings(key, [PAUSE]);
  return { kind: "reply", messages: [WAKE_TEXT] };
}

async function formatShow(
  store: SettingsStore,
  groupId: string,
  userId: string | null,
): Promise<string> {
  const group = await store.getSettings(groupKey(groupId));
  const user = await store.getSettings(userKey(groupId, userId ?? ""));
  return ["目前的設定", "<群組>", formatBlock(group.options), "<群組中的你>", formatBlock(user.options)].join(
    "\n",
  );
}

function formatBlock(options: SettingsPatch): string {
  const lines = Object.entries(options).map(([key, value]) => `${key} = ${value ? "開啟" : "關閉"}`);
  return lines.length === 0 ? "無 (預設)" : lines.join("\n");
}

function text2bool(value: string): boolean {
  if (TRUE_WORDS[value]) return true;
  if (FALSE_WORDS[value]) return false;
  throw new Error(`無法辨識: ${value}`);
}

function clampedHours(key: string | null): number {
  const hours = asciiHours(key);
  if (hours === null) return 12;
  if (hours > WEEK_HOURS) return WEEK_HOURS;
  if (hours < 1) return 1;
  return hours;
}

// shortcut: ASCII digits only, upgrade if fullwidth hour input must match Python str.isdigit
function asciiHours(key: string | null): number | null {
  if (key === null || !/^[0-9]+$/.test(key)) return null;
  return Number(key);
}

function formatMinute(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function groupKey(groupId: string): SettingsKey {
  return { groupId, userId: "" };
}

function userKey(groupId: string, userId: string): SettingsKey {
  return { groupId, userId };
}

function sleepKey(groupId: string): SettingsKey {
  return { groupId, userId: SLEEP_USER };
}

interface ParsedOrder {
  order: string;
  key: string | null;
  value: string | null;
}

function parseOrder(message: string): ParsedOrder {
  const parts = message.split("=");
  const head = parts[0] ?? "";
  const keyRaw = parts.length > 1 ? stripEnds(parts[1] ?? "") : "";
  const valueRaw = parts.length > 2 ? stripEnds(parts.slice(2).join("=")) : "";
  return {
    order: head.toLowerCase(),
    key: parts.length > 1 && keyRaw.length > 0 ? keyRaw : null,
    value: parts.length > 2 && valueRaw.length > 0 ? valueRaw : null,
  };
}

function stripEnds(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === " " || value[start] === "\n")) start += 1;
  while (end > start && (value[end - 1] === " " || value[end - 1] === "\n")) end -= 1;
  return value.slice(start, end);
}
