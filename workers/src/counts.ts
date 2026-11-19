export interface CountSource {
  userId: string | null;
  groupId: string | null;
}

export type CountMessage =
  | { kind: "text"; text: string; source: CountSource }
  | { kind: "sticker"; source: CountSource }
  | { kind: "image"; source: CountSource };

export type CountMap = Record<string, number>;

type OrderEffect = "skip" | "add" | "delete" | "trigger";

const ORDER: Record<string, OrderEffect> = {
  "-s": "skip",
  set: "skip",
  settings: "skip",
  設定: "skip",
  設置: "skip",
  愛醬安靜: "skip",
  愛醬閉嘴: "skip",
  愛醬睡覺: "skip",
  愛醬下線: "skip",
  愛醬講話: "skip",
  愛醬說話: "skip",
  愛醬聊天: "skip",
  愛醬起床: "skip",
  愛醬起來: "skip",
  愛醬上線: "skip",
  log: "skip",
  logs: "skip",
  紀錄: "skip",
  回憶: "skip",
  "-?": "skip",
  "-h": "skip",
  help: "skip",
  說明: "skip",
  指令: "skip",
  命令: "skip",
  "-l": "skip",
  list: "skip",
  列表: "skip",
  "-a": "add",
  add: "add",
  keyword: "add",
  新增: "add",
  關鍵字: "add",
  學習: "add",
  "-a+": "add",
  "add+": "add",
  "keyword+": "add",
  "新增+": "add",
  "關鍵字+": "add",
  "學習+": "add",
  "-d": "delete",
  delete: "delete",
  del: "delete",
  刪除: "delete",
  移除: "delete",
  "-o": "trigger",
  opinion: "trigger",
  意見: "trigger",
  建議: "trigger",
  回報: "trigger",
  檢舉: "trigger",
};

// shortcut: keyword match does not add 觸發, upgrade when keyword replies call touchAndCount
export function messageCountDelta(message: CountMessage): CountMap {
  if (message.source.groupId === null) return {};
  switch (message.kind) {
    case "sticker":
      return { 貼圖: 1 };
    case "image":
      return { 圖片: 1 };
    case "text":
      return textDelta(message.text);
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
}

export function mergeCounts(current: CountMap, delta: CountMap): CountMap {
  const next = { ...current };
  for (const [key, value] of Object.entries(delta)) {
    const prior = next[key];
    next[key] = prior === undefined ? value : prior + value;
  }
  return next;
}

export function parseCountMap(raw: string): CountMap {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("count was not an object");
  }
  const map: CountMap = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new TypeError("count value was not a finite number");
    }
    map[key] = entry;
  }
  return map;
}

export function encodeCountMap(map: CountMap): string {
  return JSON.stringify(map);
}

export function parseCountMessage(value: unknown): CountMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("count message must be an object");
  }
  const record = value as Record<string, unknown>;
  const source = parseSource(record.source);
  if (record.kind === "sticker" || record.kind === "image") {
    return { kind: record.kind, source };
  }
  if (record.kind === "text") {
    if (typeof record.text !== "string") {
      throw new TypeError("text message must include text");
    }
    return { kind: "text", text: record.text, source };
  }
  throw new TypeError("count message kind must be text, sticker, or image");
}

export function parseNow(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("now must be a non-empty string");
  }
  return value;
}

function textDelta(text: string): CountMap {
  if (text.length === 0) return {};
  const normalized = text.replaceAll('"', "\uFF02").replaceAll("'", "\u2019").replaceAll(";", "\uFF1B");
  const parsed = parseOrder(normalized);
  const effect = ORDER[parsed.order];
  switch (effect) {
    case "skip":
      return {};
    case "add":
      return parsed.value === null ? {} : { 調教: 1 };
    case "delete":
      return parsed.key === null ? {} : { 調教: 1 };
    case "trigger":
      return parsed.key === null ? {} : { 觸發: 1 };
    case undefined:
      return mainDelta(normalized);
    default: {
      const unreachable: never = effect;
      return unreachable;
    }
  }
}

function mainDelta(normalized: string): CountMap {
  if (normalized.includes("http:") || normalized.includes("https:")) {
    return { 網頁: 1 };
  }
  const body = stripEnds(normalized.toLowerCase());
  return {
    對話: 1,
    髒話: countOf(body, "幹") + countOf(body, "fuck"),
    字數: [...body].length,
  };
}

function parseOrder(message: string): { order: string; key: string | null; value: string | null } {
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

function countOf(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

function parseSource(value: unknown): CountSource {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("count source must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    userId: parseId(record.userId, "userId"),
    groupId: parseId(record.groupId, "groupId"),
  };
}

function parseId(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string or null`);
  }
  return value.length === 0 ? null : value;
}
