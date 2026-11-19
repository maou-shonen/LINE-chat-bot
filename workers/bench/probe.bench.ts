import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import type { KeywordSelect } from "../src/keywords";
import { KEYWORD_DELTA_LIMIT } from "../src/repository";
import { commonChars, commonWeights } from "./char-freq";

const ROW_COUNT = 50_929;
const DISTINCT = 24_711;
const CJK_LEN1 = 851;
const ASCII_LEN1 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_.,!?@#%&*+/=~()[]{}<>|;`";
const ALPHABET = 8192;
const CJK = 0x4e00;
const SEED = 1;
const ROUNDS = 21;
const PADDED = [24, 300, 1000] as const;
const SENTINEL = "zzsentinel";
const WORD_ALPHABET = commonChars.slice(0, 400);

// Lengths 1–12 are the production distinct-anchor counts.
// Lengths above 12 are not in the aggregate. 13–65 plus 128 is the shortest
// 54-length set that still ends at 128. Counts decrease, and they sum to 499.
const HISTOGRAM: Array<[number, number]> = [
  [1, 939], [2, 7861], [3, 5229], [4, 4176], [5, 2373], [6, 1328],
  [7, 791], [8, 570], [9, 381], [10, 247], [11, 180], [12, 137],
  [13, 82], [14, 67], [15, 55], [16, 46], [17, 38], [18, 31], [19, 26],
  [20, 21], [21, 18], [22, 15], [23, 13], [24, 11], [25, 9], [26, 8],
  [27, 5], [28, 5], [29, 4], [30, 3], [31, 3], [32, 2], [33, 2], [34, 2], [35, 2],
  [36, 1], [37, 1], [38, 1], [39, 1], [40, 1], [41, 1], [42, 1], [43, 1], [44, 1],
  [45, 1], [46, 1], [47, 1], [48, 1], [49, 1], [50, 1], [51, 1], [52, 1], [53, 1],
  [54, 1], [55, 1], [56, 1], [57, 1], [58, 1], [59, 1], [60, 1], [61, 1], [62, 1],
  [63, 1], [64, 1], [65, 1], [128, 1],
];

const weightTotal = commonWeights.reduce((sum, weight) => sum + weight, 0);
const cumulative: number[] = [];
{
  let acc = 0;
  for (const weight of commonWeights) {
    acc += weight;
    cumulative.push(acc);
  }
}

it("measures probe plus match at production anchor shape", async () => {
  const id = env.BOT_STATE.idFromName(`probe-bench-${crypto.randomUUID()}`);
  const state: DurableObjectStub<BotState> = env.BOT_STATE.get(id);
  const shape = await loadRows(state);
  const freqMessage = weightedText(5000, mulberry32(2));
  const uniformMessage = uniformText(5000, mulberry32(3));

  const samples = new Map<string, number[]>();
  const seen = new Map<string, { replies: string[] | null; candidates: number }>();
  for (const label of labels()) samples.set(label, []);

  for (let round = 0; round < ROUNDS; round += 1) {
    for (const label of labels()) {
      const result = await state.measureKeywordSelect(queryFor(label, freqMessage, uniformMessage), 1);
      samples.get(label)?.push(result.samplesMs[0] ?? Number.NaN);
      seen.set(label, { replies: result.replies, candidates: result.candidates });
    }
  }

  const profiles = [];
  for (const label of labels()) {
    profiles.push({
      label,
      ...(await state.profileKeywordSelect(queryFor(label, freqMessage, uniformMessage))),
    });
  }

  const cold: Record<string, ReturnType<typeof coldReport>> = {};
  for (const label of labels()) {
    cold[label] = coldReport(await state.measureColdRequest(queryFor(label, freqMessage, uniformMessage), ROUNDS));
  }
  const cache = await state.keywordCacheStats();
  const lengths = await state.anchorLengths();
  const report = {
    rows: ROW_COUNT,
    seed: SEED,
    rounds: ROUNDS,
    shape,
    anchorLengths: lengths,
    hot: labels().map((label) => summarize(label, samples.get(label) ?? [], seen.get(label))),
    profile: profiles,
    cold,
    cache,
  };
  console.log(`CACHE ${cache.buildMs.toFixed(2)}ms bytes=${cache.bytes} chunks=${cache.chunks} anchors=${cache.anchors} rowBytes=${cache.rowBytes} rowChunks=${cache.rowChunks}`);
  const freqQuery = queryFor("freq5000", freqMessage, uniformMessage);
  const selectHot: number[] = [];
  const renderHot: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const selected = await state.measureKeywordSelect(freqQuery, 1);
    const rendered = await state.measureKeywordRender(freqQuery, 1);
    selectHot.push(selected.samplesMs[0] ?? Number.NaN);
    renderHot.push(rendered.samplesMs[0] ?? Number.NaN);
    if (JSON.stringify(rendered.replies) !== JSON.stringify(selected.replies)) {
      throw new Error(`render replies diverged ${JSON.stringify(rendered.replies)} vs ${JSON.stringify(selected.replies)}`);
    }
  }
  const renderCold = coldReport(await state.measureColdRender(freqQuery, ROUNDS));
  const selectSide = summarize("select", selectHot, undefined);
  const renderSide = summarize("render", renderHot, undefined);
  console.log(`RENDER freq5000 hot p50=${renderSide.p50.toFixed(2)} p95=${renderSide.p95.toFixed(2)} max=${renderSide.max.toFixed(2)} select p95=${selectSide.p95.toFixed(2)}`);
  console.log(`RENDER freq5000 cold request p95=${renderCold.request.p95.toFixed(2)} max=${renderCold.request.max.toFixed(2)} replies=${JSON.stringify(renderCold.request.replies)}`);
  expect(renderSide.p95).toBeLessThan(10);
  expect(renderCold.request.p95).toBeLessThan(10);
  expect(renderCold.request.replies).not.toBeNull();

  for (const item of report.hot) console.log(`HOT ${item.label} p50=${item.p50.toFixed(2)} p95=${item.p95.toFixed(2)} max=${item.max.toFixed(2)}`);
  for (const item of profiles) {
    console.log(`PROFILE ${item.label} scan=${item.scanMs.toFixed(2)} fetch=${item.fetchMs.toFixed(2)} match=${item.matchMs.toFixed(2)} rowsRead=${item.rowsRead}`);
  }
  for (const [label, item] of Object.entries(cold)) {
    console.log(`COLD ${label} decode p95=${item.decode.p95.toFixed(2)} request p95=${item.request.p95.toFixed(2)} maxReq=${item.request.max.toFixed(2)}`);
  }

  expect(shape.distinct).toBe(DISTINCT);
  expect(shape.lengths).toHaveLength(66);
  expect(shape.lengths[0]).toEqual([1, 939]);
  expect(shape.lengths.at(-1)).toEqual([128, 1]);
  expect(shape.cjkLen1).toBe(CJK_LEN1);
  expect(lengths[0]).toBe(1);
  expect(lengths.at(-1)).toBe(128);
  const writes = await measureWrites(state);
  for (const item of writes) {
    console.log(`WRITE ${item.label} p95=${item.p95.toFixed(2)} max=${item.max.toFixed(2)}`);
    expect(item.p95).toBeLessThan(10);
  }

  for (;;) {
    const step = await state.compactKeywordCache();
    if (step.done) break;
  }
  const capWrites: number[] = [];
  for (let i = 0; i < KEYWORD_DELTA_LIMIT + ROUNDS; i += 1) {
    const sample = await state.measureKeywordWrite({
      op: "put",
      id: `cap${i}`,
      keyword: `capanchor${i}qq`,
      reply: "c",
      cold: false,
    });
    if (i >= KEYWORD_DELTA_LIMIT - 1) capWrites.push(sample.cpuMs);
  }
  const capWrite = summarize("cap-write", capWrites, undefined);
  console.log(`WRITE at-cap p95=${capWrite.p95.toFixed(2)} max=${capWrite.max.toFixed(2)}`);
  expect(capWrite.p95).toBeLessThan(10);
  const capHot: number[] = [];
  const capQuery = queryFor("freq5000", freqMessage, uniformMessage);
  for (let i = 0; i < ROUNDS; i += 1) {
    const result = await state.measureKeywordSelect(capQuery, 1);
    capHot.push(result.samplesMs[0] ?? Number.NaN);
  }
  const capHotSummary = summarize("cap-hot", capHot, undefined);
  const capCold = coldReport(await state.measureColdRequest(capQuery, ROUNDS));
  console.log(`READ at-cap hot p95=${capHotSummary.p95.toFixed(2)} cold p95=${capCold.request.p95.toFixed(2)}`);
  expect(capHotSummary.p95).toBeLessThan(10);
  expect(capCold.request.p95).toBeLessThan(10);

  expect(cold.freq5000?.anchors).toBe(DISTINCT);
  expect(cold.uniform5000?.anchors).toBe(DISTINCT);
  for (const item of report.hot) {
    if (item.label === "freq5000" || item.label === "uniform5000") {
      expect(item.replies?.length).toBeGreaterThan(0);
    } else if (item.label !== "zero5000") {
      expect(item.replies).toEqual(["hit"]);
    }
    expect(item.candidates).toBeGreaterThan(0);
  }
}, 300_000);

async function loadRows(state: DurableObjectStub<BotState>): Promise<AnchorShape> {
  const anchors = buildAnchors();
  const reuse = mulberry32(SEED + 1);
  const batch: Array<{ id: string; author: string; keyword: string; reply: string }> = [];
  for (let i = 0; i < ROW_COUNT; i += 1) {
    const anchor = anchors[i < DISTINCT ? i : Math.floor(reuse() * DISTINCT)] ?? SENTINEL;
    const hit = anchor === SENTINEL;
    batch.push({
      id: `k${i}`,
      author: "bench",
      keyword: hit ? `**${SENTINEL}**` : anchor,
      reply: hit ? "hit" : "r",
    });
    if (batch.length === 1000) {
      await state.putKeywords(batch);
      batch.length = 0;
    }
  }
  if (batch.length > 0) await state.putKeywords(batch);
  const steps: number[] = [];
  for (;;) {
    const step = await state.compactKeywordCache();
    steps.push(step.ms);
    if (step.done) break;
    if (steps.length > 5000) throw new Error("compact did not finish");
  }
  const maxStep = Math.max(...steps);
  console.log(`COMPACT steps=${steps.length} max=${maxStep.toFixed(2)}`);
  expect(maxStep).toBeLessThan(5);
  return shapeOf(anchors);
}

function buildAnchors(): string[] {
  if (ASCII_LEN1.length !== 939 - CJK_LEN1) throw new Error("length-1 split is not 851 CJK plus 88 other");
  if (WORD_ALPHABET.length < 89) throw new Error("word alphabet is too small");
  const anchors: string[] = [];
  for (const ch of commonChars.slice(0, CJK_LEN1)) anchors.push(ch);
  for (const ch of ASCII_LEN1) anchors.push(ch);
  let sentinelUsed = false;
  for (const [len, count] of HISTOGRAM) {
    if (len === 1) continue;
    let made = 0;
    if (!sentinelUsed && len === SENTINEL.length) {
      anchors.push(SENTINEL);
      sentinelUsed = true;
      made = 1;
    }
    for (let seq = 0; made < count; seq += 1, made += 1) {
      anchors.push(encodeAnchor(len, seq));
    }
  }
  if (!sentinelUsed) throw new Error("sentinel length missing from the histogram");
  if (anchors.length !== DISTINCT || new Set(anchors).size !== DISTINCT) {
    throw new Error(`anchor set is ${anchors.length}, unique ${new Set(anchors).size}`);
  }
  return anchors;
}

function encodeAnchor(length: number, seq: number): string {
  const base = WORD_ALPHABET.length;
  let x = seq;
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += WORD_ALPHABET[x % base] ?? "";
    x = Math.floor(x / base);
  }
  if (x !== 0 || text.length !== length) throw new Error("anchor encoding overflow");
  return text;
}

function shapeOf(anchors: readonly string[]): AnchorShape {
  const counts = new Map<number, number>();
  let sum = 0;
  let cjkLen1 = 0;
  for (const anchor of anchors) {
    sum += anchor.length;
    counts.set(anchor.length, (counts.get(anchor.length) ?? 0) + 1);
    const cp = anchor.codePointAt(0) ?? 0;
    if (anchor.length === 1 && cp >= 0x4e00 && cp <= 0x9fff) cjkLen1 += 1;
  }
  return {
    rows: ROW_COUNT,
    distinct: anchors.length,
    mean: sum / anchors.length,
    max: 128,
    cjkLen1,
    lengths: [...counts.keys()].sort((a, b) => a - b).map((len) => [len, counts.get(len) ?? 0]),
  };
}

interface AnchorShape {
  rows: number;
  distinct: number;
  mean: number;
  max: number;
  cjkLen1: number;
  lengths: Array<[number, number]>;
}

function labels(): string[] {
  return [...PADDED.map((length) => String(length)), "zero5000", "freq5000", "uniform5000"];
}

function queryFor(label: string, freqMessage: string, uniformMessage: string): KeywordSelect {
  const message = label === "freq5000"
    ? freqMessage
    : label === "uniform5000"
      ? uniformMessage
      : label === "zero5000"
        ? "0".repeat(5000)
        : padded(Number(label));
  return {
    message,
    scopeId: null,
    allReply: false,
    excludeUrl: false,
    stripName: false,
    rng: [{ op: "choice", index: 0 }],
  };
}

function coldReport(cold: {
  anchors: number;
  bytes: number;
  chunks: number;
  decodeMs: number[];
  requestMs: number[];
  replies: string[] | null;
  candidates: number;
}) {
  const outcome = { replies: cold.replies, candidates: cold.candidates };
  return {
    anchors: cold.anchors,
    bytes: cold.bytes,
    chunks: cold.chunks,
    decode: summarize("decode", cold.decodeMs, outcome),
    request: summarize("request", cold.requestMs, outcome),
  };
}

function summarize(
  label: string,
  values: readonly number[],
  outcome: { replies: string[] | null; candidates: number } | undefined,
) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    label,
    p50: rank(sorted, 0.5),
    p95: rank(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? Number.NaN,
    min: sorted[0] ?? Number.NaN,
    replies: outcome?.replies ?? null,
    candidates: outcome?.candidates ?? 0,
  };
}

async function measureWrites(state: DurableObjectStub<BotState>) {
  const anchors = buildAnchors();
  const reuse = mulberry32(SEED + 1);
  const existing: Array<{ id: string; keyword: string }> = [];
  for (let i = 0; i < DISTINCT + ROUNDS; i += 1) {
    const anchor = anchors[i < DISTINCT ? i : Math.floor(reuse() * DISTINCT)] ?? SENTINEL;
    if (i >= DISTINCT) existing.push({ id: `k${i}`, keyword: anchor });
  }
  const same = { id: "k0", keyword: anchors[0] ?? "的" };
  const samples: Array<{ label: string; op: "put" | "delete"; id: string; keyword: string; reply: string; cold: boolean }> = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const fresh = `newanchor${round}zz`;
    samples.push(
      { label: "new-hot", op: "put", id: `n${round}`, keyword: fresh, reply: "n", cold: false },
      { label: "new-cold", op: "put", id: `c${round}`, keyword: `${fresh}c`, reply: "n", cold: true },
      { label: "same-hot", op: "put", id: same.id, keyword: same.keyword, reply: `r${round}`, cold: false },
      { label: "same-cold", op: "put", id: same.id, keyword: same.keyword, reply: `c${round}`, cold: true },
      { label: "del-hot", op: "delete", id: existing[round]?.id ?? "", keyword: existing[round]?.keyword ?? "", reply: "", cold: false },
      { label: "del-cold", op: "delete", id: `c${round}`, keyword: `${fresh}c`, reply: "", cold: true },
    );
  }
  const times = new Map<string, number[]>();
  for (const sample of samples) {
    const measured = await state.measureKeywordWrite(sample);
    const list = times.get(sample.label) ?? [];
    list.push(measured.cpuMs);
    times.set(sample.label, list);
    const load = times.get(`${sample.label}-load`) ?? [];
    if (sample.cold) {
      load.push(measured.loadMs);
      times.set(`${sample.label}-load`, load);
    }
  }
  for (const [label, values] of times) {
    if (!label.endsWith("-load")) continue;
    const item = summarize(label, values, undefined);
    console.log(`WRITE ${label} p95=${item.p95.toFixed(2)} max=${item.max.toFixed(2)}`);
  }
  return [...times.entries()]
    .filter(([label]) => !label.endsWith("-load"))
    .map(([label, values]) => summarize(label, values, undefined));
}

function padded(length: number): string {
  const pad = length - SENTINEL.length;
  const left = Math.floor(pad / 2);
  return `${"0".repeat(left)}${SENTINEL}${"0".repeat(pad - left)}`;
}

function weightedText(length: number, random: () => number): string {
  let text = SENTINEL;
  while (text.length < length) text += sampleCommon(random());
  return text.slice(0, length);
}

function sampleCommon(unit: number): string {
  const target = unit * weightTotal;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cumulative[mid] ?? 0) <= target) lo = mid + 1;
    else hi = mid;
  }
  return commonChars[lo] ?? commonChars[0] ?? "";
}

function uniformText(length: number, random: () => number): string {
  let text = SENTINEL;
  while (text.length < length) text += String.fromCharCode(CJK + Math.floor(random() * ALPHABET));
  return text.slice(0, length);
}

function rank(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
