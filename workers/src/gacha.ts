export interface Rng {
  uniform(low: number, high: number): number;
  choice<T>(items: readonly T[]): T;
  sample<T>(items: readonly T[], k: number): readonly T[];
}

export interface RandomOrgRequest {
  url: string;
  timeoutMs: number;
}

export interface RenderReplyInput {
  reply: string;
  message: string;
  userId: string;
  now: Date;
  rng: Rng;
  randomOrg?: (request: RandomOrgRequest) => string;
}

const EPOCH_2017 = Date.UTC(2017, 0, 1);
const DRAW_CAP = 10_000;
const RANDOM_ORG_TIMEOUT_MS = 3000;

const DIGIT_BLOCKS = [
  48, 1632, 1776, 1984, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 3558, 3664, 3792, 3872,
  4160, 4240, 6112, 6160, 6470, 6608, 6784, 6800, 6992, 7088, 7232, 7248, 42528, 43216, 43264, 43472,
  43504, 43600, 44016, 65296, 66720, 68912, 69734, 69872, 69942, 70096, 70384, 70736, 70864, 71248,
  71360, 71472, 71904, 72016, 72784, 73040, 73120, 73552, 92768, 92864, 93008, 120782, 120792, 120802,
  120812, 120822, 123200, 123632, 124144, 125264, 130032,
] as const;

// Python str.isdigit is true here, but int() rejects them.
const NON_DECIMAL: ReadonlyArray<readonly [number, number]> = [
  [178, 179],
  [185, 185],
  [4969, 4977],
  [6618, 6618],
  [8304, 8304],
  [8308, 8313],
  [8320, 8329],
  [9312, 9320],
  [9332, 9340],
  [9352, 9360],
  [9450, 9450],
  [9461, 9469],
  [9471, 9471],
  [10102, 10110],
  [10112, 10120],
  [10122, 10130],
  [68160, 68163],
  [69216, 69224],
  [69714, 69722],
  [127232, 127242],
];

const FLOAT_RE =
  /^(?:(?:\d+_)*\d+(?:\.(?:\d+_)*\d*)?|\.(?:\d+_)*\d+)(?:[eE][+-]?(?:\d+_)*\d+)?$/;

export function randomOrgUrl(reply: string, message: string): string | null {
  const hash = reply.indexOf("##");
  const body = hash === -1 ? reply : reply.slice(0, hash);
  if (!body.includes("__")) return null;
  const count = drawCount(message);
  if (count <= 1) return null;
  let total = 0;
  for (const segment of body.split("__")) {
    if (segment === "") continue;
    let msg = segment;
    const pct = msg.lastIndexOf("%");
    if (pct !== -1) {
      const parsed = pythonFloat(msg.slice(pct + 1));
      if (parsed !== null) msg = msg.slice(0, pct);
      total += parsed ?? 1;
    } else {
      total += 1;
    }
  }
  const max = truncInt(total);
  return (
    `https://www.random.org/integers/?num=${count}&min=0&max=${max}` +
    "&col=1&base=10&format=plain&rnd=new"
  );
}

export function renderReply(input: RenderReplyInput): string[] {
  const opt = new Map<string, string>();
  let body = input.reply;
  const hash = body.indexOf("##");
  if (hash !== -1) {
    for (const segment of body.split("##")) {
      const eq = segment.indexOf("=");
      if (eq !== -1) opt.set(segment.slice(0, eq), segment.slice(eq + 1));
    }
    body = body.slice(0, hash);
  }
  if (!body.includes("__")) return splitPipes([body]);

  const pool = new Map<string, { weight: number; minimum: boolean }>();
  const minimumPool: string[] = [];
  let total = 0;
  let integral = true;
  for (const segment of body.split("__")) {
    if (segment === "") continue;
    let msg = segment;
    let weight = 1;
    let explicit = false;
    const pct = msg.lastIndexOf("%");
    if (pct !== -1) {
      const parsed = pythonFloat(msg.slice(pct + 1));
      if (parsed !== null) {
        weight = parsed;
        explicit = true;
        msg = msg.slice(0, pct);
      }
    }
    let minimum = false;
    let inPool = false;
    if (msg.startsWith("*")) {
      minimum = true;
      inPool = msg.startsWith("**");
      msg = inPool ? msg.slice(2) : msg.slice(1);
    }
    if (explicit) integral = false;
    // shortcut: a sum above 2^53 is not an exact integer. Upgrade if one pool can hold that much weight.
    total += weight;
    pool.set(msg, { weight, minimum });
    if (minimum && inPool) minimumPool.push(msg);
  }

  const percentRaw = opt.get("百分比") ?? "0";
  if (pyIsDigit(percentRaw)) {
    let number = parsePythonInt(percentRaw);
    if (number > 0) {
      if (number > pool.size) number = pool.size;
      const names = input.rng.sample([...pool.keys()], number);
      const lines: string[] = [];
      let remain = 100;
      let seen = 0;
      for (const msg of names) {
        seen += 1;
        let ratio: number;
        if (seen >= number || seen >= names.length) {
          ratio = remain;
          remain = 0;
        } else {
          ratio = input.rng.uniform(0, remain);
          remain -= ratio;
        }
        lines.push(`${msg}（${formatRatio(ratio)}％）`);
        if (remain <= 0) break;
      }
      return [lines.join("\n")];
    }
  }

  const count = drawCount(input.message);
  let seeded = false;
  let seedRoll = 0;
  const seedRaw = opt.get("種子");
  if (count === 1 && seedRaw !== undefined && pyIsDigit(seedRaw)) {
    const hours = parsePythonInt(seedRaw);
    if (hours > 0) {
      seeded = true;
      seedRoll = seededRoll(input.userId, input.now, hours, total, integral);
    }
  }
  const rolls = seeded ? null : randomRolls(input, count, total);
  const pityRaw = opt.get("保底");
  const minimumIndex = pityRaw === undefined ? 10 : parsePythonInt(pityRaw);

  let minimumCount = 0;
  const tallies = new Map<string, number>();
  const images: string[] = [];
  for (let i = 0; i < count; i++) {
    let roll = seeded ? seedRoll : readRoll(rolls, i);
    for (const [msg, slot] of pool) {
      if (roll > slot.weight) {
        roll -= slot.weight;
        continue;
      }
      minimumCount = slot.minimum ? 0 : minimumCount + 1;
      let chosen = msg;
      if (minimumCount >= minimumIndex && minimumPool.length > 0) {
        minimumCount = 0;
        chosen = input.rng.choice(minimumPool);
      }
      if (chosen.startsWith("https:")) images.push(chosen);
      else tallies.set(chosen, (tallies.get(chosen) ?? 0) + 1);
      break;
    }
  }

  let parts: string[];
  if (tallies.size > 0) {
    parts =
      count === 1
        ? [...tallies.keys()]
        : [[...tallies].map(([msg, n]) => `${msg} x ${n}`).join("\n")];
  } else {
    parts = [];
  }
  parts.push(...images.slice(0, 5));
  return splitPipes(parts);
}

function randomRolls(input: RenderReplyInput, count: number, total: number): Array<number | string> {
  try {
    if (count > 1) {
      const max = truncInt(total);
      const url =
        `https://www.random.org/integers/?num=${count}&min=0&max=${max}` +
        "&col=1&base=10&format=plain&rnd=new";
      if (input.randomOrg === undefined) throw new Error("random.org");
      const text = input.randomOrg({ url, timeoutMs: RANDOM_ORG_TIMEOUT_MS });
      if (text.includes("Error") || text.includes("<!DOCTYPE html>")) throw new Error("random.org");
      return text.split("\n").slice(0, -1);
    }
    throw new Error("single");
  } catch {
    const max = truncInt(total);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(input.rng.uniform(0, max));
    return out;
  }
}

function readRoll(rolls: Array<number | string> | null, index: number): number {
  const cell = rolls?.[index];
  if (typeof cell === "number") return cell;
  if (typeof cell === "string") {
    const value = pythonFloat(cell);
    if (value === null) throw new Error("invalid roll");
    return value;
  }
  throw new Error("missing roll");
}

function seededRoll(
  userId: string,
  now: Date,
  hours: number,
  total: number,
  integral: boolean,
): number {
  const days = Math.floor((now.getTime() - EPOCH_2017) / 86_400_000);
  const seedTime = Math.trunc((days * 24) / hours);
  // WebCrypto has no MD5. The seed is the integer value of this digest.
  const hex = md5Hex(new TextEncoder().encode(`${userId}${String(seedTime)}`));
  const n = BigInt(`0x${hex}`);
  if (integral) {
    const mod = BigInt(truncInt(total));
    if (mod === 0n) throw new Error("modulo by zero");
    return Number(n % mod);
  }
  return floatMod(n, total);
}

function drawCount(message: string): number {
  const star = message.lastIndexOf("*");
  if (star < 0) return 1;
  const suffix = message.slice(star + 1);
  if (!pyIsDigit(suffix)) return 1;
  const n = parsePythonInt(suffix);
  if (n > DRAW_CAP) return DRAW_CAP;
  if (n < 1) return 1;
  return n;
}

function splitPipes(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    for (const piece of part.split("||")) out.push(piece);
  }
  return out;
}

function formatRatio(n: number): string {
  if (Number.isNaN(n)) return padRatio("nan");
  if (n === Infinity) return padRatio("inf");
  if (n === -Infinity) return padRatio("-inf");
  // shortcut: |n| >= 1e21 makes JS toFixed switch to exponent form. Percentage ratios stay near 0..100.
  return padRatio(n.toFixed(2));
}

function padRatio(body: string): string {
  return body.length < 3 ? body.padStart(3, " ") : body;
}

function truncInt(n: number): number {
  if (!Number.isFinite(n)) throw new Error("invalid int");
  return Math.trunc(n);
}

function floatMod(n: bigint, mod: number): number {
  if (mod === 0) throw new Error("modulo by zero");
  const value = bigintToNumber(n);
  let remainder = value % mod;
  if (remainder !== 0 && mod < 0 !== remainder < 0) remainder += mod;
  return remainder;
}

function bigintToNumber(n: bigint): number {
  const neg = n < 0n;
  const x = neg ? -n : n;
  if (x <= 0x1fffffffffffffn) {
    const small = Number(x);
    return neg ? -small : small;
  }
  const width = x.toString(2).length;
  const shift = BigInt(width - 53);
  const rem = x & ((1n << shift) - 1n);
  let mant = x >> shift;
  const half = 1n << (shift - 1n);
  if (rem > half || (rem === half && (mant & 1n) === 1n)) mant += 1n;
  if (mant >> 53n) {
    const rounded = 2 ** width;
    return neg ? -rounded : rounded;
  }
  const value = Number(mant) * 2 ** Number(shift);
  return neg ? -value : value;
}

function pyStrip(s: string): string {
  return s
    .replace(/^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/, "")
    .replace(/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/, "");
}

function pythonFloat(raw: string): number | null {
  const stripped = pyStrip(raw);
  if (stripped === "") return null;
  let sign = "";
  let body = stripped;
  if (body.startsWith("+") || body.startsWith("-")) {
    sign = body[0] ?? "";
    body = body.slice(1);
  }
  if (body === "") return null;
  const word = body.toLowerCase();
  if (word === "inf" || word === "infinity") {
    return sign === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (word === "nan") return Number.NaN;
  let mapped = "";
  for (const ch of body) {
    if (ch === "_") {
      mapped += "_";
      continue;
    }
    const cp = ch.codePointAt(0);
    if (cp === undefined) return null;
    const digit = decimalDigit(cp);
    if (digit !== null) {
      mapped += String(digit);
      continue;
    }
    if (cp < 128) {
      mapped += ch;
      continue;
    }
    return null;
  }
  if (!FLOAT_RE.test(mapped)) return null;
  const n = Number(sign + mapped.replaceAll("_", ""));
  return Number.isNaN(n) ? null : n;
}

function pyIsDigit(s: string): boolean {
  if (s === "") return false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return false;
    if (decimalDigit(cp) !== null || isNonDecimalDigit(cp)) continue;
    return false;
  }
  return true;
}

function parsePythonInt(raw: string): number {
  const chars = [...raw];
  let i = 0;
  let sign = 1;
  if (chars[0] === "+" || chars[0] === "-") {
    sign = chars[0] === "-" ? -1 : 1;
    i = 1;
  }
  if (i >= chars.length) throw new Error("invalid int");
  let digits = "";
  let prevBreak = true;
  for (; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === undefined) throw new Error("invalid int");
    if (ch === "_") {
      if (prevBreak) throw new Error("invalid int");
      prevBreak = true;
      continue;
    }
    const cp = ch.codePointAt(0);
    if (cp === undefined) throw new Error("invalid int");
    const digit = decimalDigit(cp);
    if (digit === null) throw new Error("invalid int");
    digits += String(digit);
    prevBreak = false;
  }
  if (prevBreak || digits === "") throw new Error("invalid int");
  if (digits.length > 15) return sign < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return sign * Number(digits);
}

function decimalDigit(cp: number): number | null {
  let lo = 0;
  let hi = DIGIT_BLOCKS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = DIGIT_BLOCKS[mid];
    if (start === undefined) return null;
    if (cp < start) hi = mid - 1;
    else if (cp >= start + 10) lo = mid + 1;
    else return cp - start;
  }
  return null;
}

function isNonDecimalDigit(cp: number): boolean {
  let lo = 0;
  let hi = NON_DECIMAL.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = NON_DECIMAL[mid];
    if (range === undefined) return false;
    const start = range[0];
    const end = range[1];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10,
  15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Int32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

function md5Hex(bytes: Uint8Array): string {
  const n = bytes.length;
  const zeros = (56 - ((n + 1) % 64) + 64) % 64;
  const total = n + 1 + zeros + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[n] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = n * 8;
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    const words = new Int32Array(16);
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const word = words[g] ?? 0;
      const shift = SHIFTS[i] ?? 0;
      f = (f + a) | 0;
      f = (f + (K[i] ?? 0)) | 0;
      f = (f + word) | 0;
      const rotated = (f << shift) | (f >>> (32 - shift));
      a = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const hexView = new DataView(out.buffer);
  hexView.setInt32(0, a0, true);
  hexView.setInt32(4, b0, true);
  hexView.setInt32(8, c0, true);
  hexView.setInt32(12, d0, true);
  let hex = "";
  for (const byte of out) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
