// shortcut: 字數用 JS length，非 BMP 會和 Python len 差，遇到 emoji 再改 code point。

export const PROBE_MESSAGE_LIMIT = 300;
export const NAME_PREFIX = "愛醬";

const UNKNOWN_REPLIES = [
  "(?)",
  "愛醬不是很懂你說什麼",
  "對不起...愛醬聽不懂",
  "愛醬問號",
  "愛醬沉默",
  "愛醬不知道要說什麼",
  "愛醬再努力學習喔 請多教教愛醬",
] as const;

export interface KeywordRow {
  id: string | null;
  keyword: string;
  reply: string;
  anchor: string;
}

export interface KeywordRng {
  choice<T>(items: readonly T[]): T;
  uniform(low: number, high: number): number;
}

export type RngOp =
  | { op: "choice"; index: number }
  | { op: "uniform"; hex: string };

export interface KeywordSelect {
  message: string;
  scopeId: string | null;
  allReply: boolean;
  excludeUrl: boolean;
  stripName: boolean;
  rng: RngOp[];
}

export interface KeywordSelectResult {
  replies: string[] | null;
  candidates: number;
}

export function anchorOf(keyword: string): string {
  let best = "";
  for (const piece of keyword.split("**")) {
    if (piece.length > best.length) best = piece;
  }
  return best;
}

export function excludeKeywordUrls(
  allReply: boolean,
  inGroup: boolean,
  allImages: boolean,
): boolean {
  return allReply && inGroup && !allImages;
}

export function normalizeKeywordMessage(message: string, stripName: boolean): string {
  let text = stripEdges(
    message.replaceAll('"', "＂").replaceAll("'", "’").replaceAll(";", "；").toLowerCase(),
    " \n",
  );
  if (stripName && text !== NAME_PREFIX && text.startsWith(NAME_PREFIX)) {
    text = stripEdges(text.slice(NAME_PREFIX.length), " \n　");
  }
  return text;
}

export function probeNeedles(message: string, lengths: readonly number[]): string[] {
  const subs = new Set<string>([""]);
  const n = message.length;
  for (const length of lengths) {
    if (!length || length > n) continue;
    for (let i = 0; i <= n - length; i += 1) {
      subs.add(message.slice(i, i + length));
    }
  }
  return [...subs];
}

export function playRng(script: readonly RngOp[]): KeywordRng & { finish(): void } {
  let index = 0;
  return {
    choice(items) {
      const step = script[index];
      index += 1;
      if (step === undefined || step.op !== "choice") {
        throw new TypeError("rng script missing choice");
      }
      const item = items[step.index];
      if (item === undefined) throw new TypeError("rng choice index out of range");
      return item;
    },
    uniform() {
      const step = script[index];
      index += 1;
      if (step === undefined || step.op !== "uniform") {
        throw new TypeError("rng script missing uniform");
      }
      return floatFromHex(step.hex);
    },
    finish() {
      if (index !== script.length) throw new TypeError("rng script not exhausted");
    },
  };
}

export function selectKeywordReplies(
  rows: readonly KeywordRow[],
  query: KeywordSelect,
): KeywordSelectResult {
  const rng = playRng(query.rng);
  const message = normalizeKeywordMessage(query.message, query.stripName);
  const winner = message === "" ? null : matchKeyword(message, rows, query, rng);
  const replies = winner === null
    ? (query.allReply && message !== "" ? [rng.choice(UNKNOWN_REPLIES)] : null)
    : shapeKeywordReply(winner, message, rng);
  rng.finish();
  return { replies, candidates: rows.length };
}

export function matchKeyword(
  message: string,
  rows: readonly KeywordRow[],
  flags: { allReply: boolean; excludeUrl: boolean },
  rng: KeywordRng,
): string | null {
  const keys: Array<[string, string]> = [];
  const exact: string[] = [];

  for (const row of rows) {
    let reply = row.reply;
    if (reply.startsWith("@")) {
      if (flags.allReply) continue;
      reply = reply.slice(1);
    }
    if (flags.excludeUrl && reply.includes("https:")) continue;

    if (row.keyword === message) {
      if (flags.allReply) exact.push(reply);
      else return reply;
    } else if (row.keyword.replaceAll("**", "") === message) {
      exact.push(reply);
    } else if (!flags.allReply || reply.length > 1) {
      keys.push([row.keyword, reply]);
    }
  }

  if (exact.length > 0) return rng.choice(exact);

  let bestLevel = -99;
  const byLevel = new Map<number, string[]>();
  for (const [keyword, reply] of keys) {
    if (!wildcardMatch(keyword, message)) continue;
    const level = keywordLevel(keyword);
    const bucket = byLevel.get(level);
    if (bucket === undefined) byLevel.set(level, [reply]);
    else bucket.push(reply);
    if (level > bestLevel) bestLevel = level;
  }
  const winners = byLevel.get(bestLevel);
  if (winners === undefined) return null;
  return rng.choice(winners);
}

export function shapeKeywordReply(reply: string, message: string, rng: KeywordRng): string[] {
  const hash = reply.indexOf("##");
  const body = hash === -1 ? reply : reply.slice(0, hash);
  const options = hash === -1 ? "" : reply.slice(hash + 2);
  // shortcut: 百分比、種子、多發、保底不在這支，抽卡 PR 再接。
  if (options.includes("百分比") || options.includes("種子") || options.includes("保底")) {
    throw new TypeError("card draw is not in this port");
  }
  if (!body.includes("__")) return body.split("||");
  if (drawCount(message) > 1) throw new TypeError("card draw is not in this port");
  return weightedPick(body, rng).split("||");
}

function weightedPick(body: string, rng: KeywordRng): string {
  const pool = new Map<string, number>();
  let total = 0;
  for (const raw of body.split("__")) {
    if (raw === "") continue;
    const weighted = parseWeight(raw);
    let text = weighted.text;
    if (text.startsWith("*")) text = text.startsWith("**") ? text.slice(2) : text.slice(1);
    total += weighted.weight;
    pool.set(text, weighted.weight);
  }
  let remain = rng.uniform(0, Math.trunc(total));
  for (const [text, weight] of pool) {
    if (remain > weight) remain -= weight;
    else return text;
  }
  throw new TypeError("weight pool missed");
}

function parseWeight(segment: string): { text: string; weight: number } {
  const index = segment.lastIndexOf("%");
  const suffix = segment.slice(index + 1).trim();
  if (index > -1 && suffix !== "" && Number.isFinite(Number(suffix))) {
    return { text: segment.slice(0, index), weight: Number(suffix) };
  }
  return { text: segment, weight: 1 };
}

function drawCount(message: string): number {
  const index = message.lastIndexOf("*");
  if (index === -1) return 1;
  const suffix = message.slice(index + 1);
  if (!/^\d+$/.test(suffix)) return 1;
  const count = Number(suffix);
  if (count > 10000) return 10000;
  if (count < 1) return 1;
  return count;
}

function keywordLevel(keyword: string): number {
  return keyword.length
    - (keyword.split("**").length - 1)
    - (keyword.startsWith("**") ? 2 : 0)
    - (keyword.endsWith("**") ? 2 : 0);
}

function wildcardMatch(keyword: string, message: string): boolean {
  const pieces = keyword.split("**");
  let kn = -1;
  for (const piece of pieces) {
    if (piece !== "") {
      const found = message.indexOf(piece);
      if (found > kn) kn = found;
      else return false;
    }
    // Python rechecks the pin on every piece, including empty ones.
    const first = pieces[0] ?? "";
    const last = pieces[pieces.length - 1] ?? "";
    if (first !== "" && message[0] !== keyword[0]) return false;
    if (last !== "" && message[message.length - 1] !== keyword[keyword.length - 1]) return false;
  }
  return true;
}

function stripEdges(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start] ?? "")) start += 1;
  while (end > start && chars.includes(text[end - 1] ?? "")) end -= 1;
  return text.slice(start, end);
}

function floatFromHex(hex: string): number {
  const text = hex.trim();
  if (/^[+-]?0x0\.0p\+0$/i.test(text)) return 0;
  const match = /^([+-]?)0x([0-9a-f])\.([0-9a-f]*)p([+-]?\d+)$/i.exec(text);
  if (match === null) throw new TypeError("bad float hex");
  const sign = match[1] === "-" ? -1 : 1;
  const frac = (match[3] ?? "").padEnd(13, "0").slice(0, 13);
  const bits = Number.parseInt(`${match[2] ?? "0"}${frac}`, 16);
  const exp = Number(match[4]);
  return sign * bits * 2 ** (exp - 52);
}
