import {
  inspectSql,
  migrateSql,
  type SchemaSnapshot,
} from "./schema";
import { parseSettingsPatch, type SettingsKey, type SettingsPatch, type SettingsView } from "./settings";
import {
  anchorOf,
  normalizeKeywordMessage,
  probeNeedles,
  PROBE_MESSAGE_LIMIT,
  selectKeywordReplies as selectFromRows,
  type KeywordRow,
  type KeywordSelect,
  type KeywordSelectResult,
} from "./keywords";

const CACHE_META_KEY = "keyword-probe-cache-meta";
const CHUNK_MAX_BYTES = 1_000_000;

export interface BotRepository {
  migrate(): Promise<void>;
  getSettings(key: SettingsKey): Promise<SettingsView>;
  upsertSettings(key: SettingsKey, patch: SettingsPatch): Promise<void>;
  countSettings(key: SettingsKey): Promise<number>;
  inspectSchema(): Promise<SchemaSnapshot>;
  putKeywords(rows: KeywordSeed[]): Promise<void>;
  deleteKeyword(id: string, keyword: string): Promise<void>;
  anchorLengths(): Promise<number[]>;
  selectKeywordReplies(query: KeywordSelect): Promise<KeywordSelectResult>;
  measureKeywordSelect(query: KeywordSelect, rounds: number): Promise<KeywordMeasure>;
  profileKeywordSelect(query: KeywordSelect): Promise<KeywordProfile>;
  measureColdRequest(query: KeywordSelect, rounds: number): Promise<ColdKeywordMeasure>;
}

export class SqliteBotRepository implements BotRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  private probeCache: ProbeCache | null = null;

  async migrate(): Promise<void> {
    this.storage.transactionSync(() => {
      migrateSql(this.storage.sql);
    });
  }

  async getSettings(key: SettingsKey): Promise<SettingsView> {
    const current = readOptions(this.storage.sql, key);
    if (current === null) {
      return { groupId: key.groupId, userId: key.userId, options: {}, stored: false };
    }
    return {
      groupId: key.groupId,
      userId: key.userId,
      options: current.options,
      stored: true,
    };
  }

  async upsertSettings(key: SettingsKey, patch: SettingsPatch): Promise<void> {
    this.storage.transactionSync(() => {
      const current = readOptions(this.storage.sql, key);
      const next = { ...(current?.options ?? {}), ...patch };
      if (Object.keys(next).length === 0) {
        if (current !== null) {
          this.storage.sql.exec(
            "DELETE FROM user_settings WHERE group_id = ? AND user_id = ?",
            key.groupId,
            key.userId,
          );
        }
        return;
      }
      const encoded = JSON.stringify(next);
      if (current === null) {
        this.storage.sql.exec(
          "INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)",
          key.groupId,
          key.userId,
          encoded,
        );
        return;
      }
      if (current.raw === encoded) return;
      this.storage.sql.exec(
        "UPDATE user_settings SET options = ? WHERE group_id = ? AND user_id = ?",
        encoded,
        key.groupId,
        key.userId,
      );
    });
  }

  async countSettings(key: SettingsKey): Promise<number> {
    const row = this.storage.sql
      .exec(
        "SELECT COUNT(*) AS n FROM user_settings WHERE group_id = ? AND user_id = ?",
        key.groupId,
        key.userId,
      )
      .one();
    const record = asRecord(row);
    const n = record.n;
    if (typeof n !== "number") throw new TypeError("count was not a number");
    return n;
  }

  async inspectSchema(): Promise<SchemaSnapshot> {
    return inspectSql(this.storage.sql);
  }

  async putKeywords(rows: KeywordSeed[]): Promise<void> {
    const cache = await this.readyCache();
    this.storage.transactionSync(() => {
      for (const row of rows) {
        writeKeyword(this.storage.sql, row);
        addCachedAnchor(cache, anchorOf(row.keyword));
      }
    });
    await this.persistProbeCache();
  }

  async deleteKeyword(id: string, keyword: string): Promise<void> {
    const cache = await this.readyCache();
    const anchor = anchorOf(keyword);
    this.storage.sql.exec(
      "DELETE FROM user_keyword WHERE id = ? AND keyword = ?",
      id,
      keyword,
    );
    dropCachedAnchor(this.storage.sql, cache, anchor);
    await this.persistProbeCache();
  }

  async anchorLengths(): Promise<number[]> {
    return anchorLengthList(this.storage.sql);
  }

  async selectKeywordReplies(query: KeywordSelect): Promise<KeywordSelectResult> {
    return this.runSelect(query);
  }

  async measureKeywordSelect(query: KeywordSelect, rounds: number): Promise<KeywordMeasure> {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) {
      throw new TypeError("rounds out of range");
    }
    const samplesMs: number[] = [];
    let replies: string[] | null = null;
    let candidates = 0;
    for (let i = 0; i < rounds; i += 1) {
      const start = performance.now();
      const result = await this.runSelect(query);
      samplesMs.push(performance.now() - start);
      replies = result.replies;
      candidates = result.candidates;
    }
    return { samplesMs, replies, candidates };
  }

  async profileKeywordSelect(query: KeywordSelect): Promise<KeywordProfile> {
    const message = normalizeKeywordMessage(query.message, query.stripName);
    const cache = await this.readyCache();
    const scanStart = performance.now();
    const hits = message === ""
      ? []
      : message.length <= PROBE_MESSAGE_LIMIT
        ? probeNeedles(message, cache.lengths)
        : slideHits(cache, message);
    const scanMs = performance.now() - scanStart;
    const fetchStart = performance.now();
    const rows = message === "" ? [] : fetchByAnchors(this.storage.sql, hits, query.scopeId);
    const fetchMs = performance.now() - fetchStart;
    const matchStart = performance.now();
    const selected = selectFromRows(rows, query);
    return {
      probeMs: scanMs + fetchMs,
      scanMs,
      fetchMs,
      matchMs: performance.now() - matchStart,
      candidates: rows.length,
      replies: selected.replies,
    };
  }

  async measureColdRequest(query: KeywordSelect, rounds: number): Promise<ColdKeywordMeasure> {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) {
      throw new TypeError("rounds out of range");
    }
    const decodeMs: number[] = [];
    const requestMs: number[] = [];
    let replies: string[] | null = null;
    let candidates = 0;
    let anchors = 0;
    let bytes = 0;
    let chunks = 0;
    for (let i = 0; i < rounds; i += 1) {
      this.probeCache = null;
      const raw = await this.readRawCache();
      if (raw === null) throw new Error("probe cache blob is missing");
      const decodeStart = performance.now();
      const cache = decodeProbeCache(raw);
      const decoded = performance.now();
      this.probeCache = cache;
      const result = await this.runSelect(query);
      requestMs.push(performance.now() - decodeStart);
      decodeMs.push(decoded - decodeStart);
      replies = result.replies;
      candidates = result.candidates;
      anchors = cache.anchors.size;
      bytes = raw.bytes;
      chunks = raw.chunks.length;
    }
    return { decodeMs, requestMs, replies, candidates, anchors, bytes, chunks };
  }

  private async runSelect(query: KeywordSelect): Promise<KeywordSelectResult> {
    const message = normalizeKeywordMessage(query.message, query.stripName);
    if (message === "") return selectFromRows([], query);
    const cache = await this.readyCache();
    const rows = probeKeywordRows(this.storage.sql, message, query.scopeId, cache);
    const selected = selectFromRows(rows, query);
    return { replies: selected.replies, candidates: rows.length };
  }

  private async readyCache(): Promise<ProbeCache> {
    if (this.probeCache !== null) return this.probeCache;
    const raw = await this.readRawCache();
    const cache = raw === null ? emptyProbeCache() : decodeProbeCache(raw);
    this.probeCache = cache;
    return cache;
  }

  private async persistProbeCache(): Promise<void> {
    const cache = this.probeCache ?? emptyProbeCache();
    const chunks = encodeChunks([...cache.anchors]);
    const previous = metaChunkCount(await this.storage.get(CACHE_META_KEY));
    await this.storage.put(CACHE_META_KEY, { chunks: chunks.length, lengths: cache.lengths });
    for (let i = 0; i < chunks.length; i += 1) {
      await this.storage.put(chunkKey(i), chunks[i]);
    }
    for (let i = chunks.length; i < previous; i += 1) {
      await this.storage.delete(chunkKey(i));
    }
  }

  private async readRawCache(): Promise<RawProbeCache | null> {
    const meta = parseMeta(await this.storage.get(CACHE_META_KEY));
    if (meta === null) return null;
    const chunks: string[] = [];
    let bytes = 0;
    for (let i = 0; i < meta.chunks; i += 1) {
      const value = await this.storage.get(chunkKey(i));
      if (typeof value !== "string") return null;
      chunks.push(value);
      bytes += value.length;
    }
    return { chunks, lengths: meta.lengths, bytes };
  }
}

interface StoredOptions {
  raw: string;
  options: SettingsPatch;
}

function readOptions(sql: SqlStorage, key: SettingsKey): StoredOptions | null {
  const row = sql
    .exec(
      "SELECT options FROM user_settings WHERE group_id = ? AND user_id = ?",
      key.groupId,
      key.userId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const record = asRecord(row);
  const raw = record.options;
  if (typeof raw !== "string") {
    throw new TypeError("user_settings.options was not text");
  }
  return { raw, options: parseSettingsPatch(JSON.parse(raw)) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sql row was not an object");
  }
  return value as Record<string, unknown>;
}

export interface KeywordSeed {
  id: string;
  author: string;
  keyword: string;
  reply: string;
}

export interface KeywordMeasure {
  samplesMs: number[];
  replies: string[] | null;
  candidates: number;
}

export interface KeywordProfile {
  probeMs: number;
  scanMs: number;
  fetchMs: number;
  matchMs: number;
  candidates: number;
  replies: string[] | null;
}

export interface ColdKeywordMeasure {
  decodeMs: number[];
  requestMs: number[];
  replies: string[] | null;
  candidates: number;
  anchors: number;
  bytes: number;
  chunks: number;
}

interface ProbeCache {
  anchors: Set<string>;
  lengths: number[];
  firsts: Set<string>;
}

interface RawProbeCache {
  chunks: string[];
  lengths: number[];
  bytes: number;
}

function emptyProbeCache(): ProbeCache {
  return { anchors: new Set(), lengths: [], firsts: new Set() };
}

function addCachedAnchor(cache: ProbeCache, anchor: string): void {
  if (anchor === "" || cache.anchors.has(anchor)) return;
  cache.anchors.add(anchor);
  cache.firsts.add(anchor[0] ?? "");
  if (!cache.lengths.includes(anchor.length)) {
    cache.lengths.push(anchor.length);
    cache.lengths.sort((a, b) => a - b);
  }
}

function dropCachedAnchor(sql: SqlStorage, cache: ProbeCache, anchor: string): void {
  if (anchor === "" || !cache.anchors.has(anchor)) return;
  const left = sql.exec(
    "SELECT 1 AS n FROM user_keyword WHERE anchor = ? LIMIT 1",
    anchor,
  ).toArray()[0];
  if (left !== undefined) return;
  cache.anchors.delete(anchor);
  const length = anchor.length;
  const first = anchor[0] ?? "";
  let stillLength = false;
  let stillFirst = false;
  for (const item of cache.anchors) {
    if (item.length === length) stillLength = true;
    if (item.startsWith(first)) stillFirst = true;
    if (stillLength && stillFirst) break;
  }
  if (!stillLength) cache.lengths = cache.lengths.filter((item) => item !== length);
  if (!stillFirst) cache.firsts.delete(first);
}

function probeKeywordRows(
  sql: SqlStorage,
  message: string,
  scopeId: string | null,
  cache: ProbeCache,
): KeywordRow[] {
  const hits = message.length <= PROBE_MESSAGE_LIMIT
    ? probeNeedles(message, cache.lengths)
    : slideHits(cache, message);
  return fetchByAnchors(sql, hits, scopeId);
}

function slideHits(cache: ProbeCache, message: string): string[] {
  const hits = [""];
  const found = new Set<string>();
  const n = message.length;
  for (let i = 0; i < n; i += 1) {
    const ch = message[i] ?? "";
    if (!cache.firsts.has(ch)) continue;
    for (const length of cache.lengths) {
      if (i + length > n) continue;
      const needle = message.slice(i, i + length);
      if (cache.anchors.has(needle) && !found.has(needle)) {
        found.add(needle);
        hits.push(needle);
      }
    }
  }
  return hits;
}

function encodeChunks(anchors: readonly string[]): string[] {
  const chunks: string[] = [];
  let batch: string[] = [];
  let bytes = 2;
  for (const anchor of anchors) {
    const extra = JSON.stringify(anchor).length + (batch.length > 0 ? 1 : 0);
    if (batch.length > 0 && bytes + extra > CHUNK_MAX_BYTES) {
      chunks.push(JSON.stringify(batch));
      batch = [];
      bytes = 2;
    }
    batch.push(anchor);
    bytes += extra;
  }
  chunks.push(JSON.stringify(batch));
  return chunks;
}

function decodeProbeCache(raw: RawProbeCache): ProbeCache {
  const cache = emptyProbeCache();
  cache.lengths = [...raw.lengths];
  for (const chunk of raw.chunks) {
    const parsed: unknown = JSON.parse(chunk);
    if (!Array.isArray(parsed)) throw new TypeError("probe cache chunk was not a list");
    for (const anchor of parsed) {
      if (typeof anchor !== "string") throw new TypeError("probe cache anchor was not text");
      if (anchor === "" || cache.anchors.has(anchor)) continue;
      cache.anchors.add(anchor);
      cache.firsts.add(anchor[0] ?? "");
    }
  }
  return cache;
}

function parseMeta(value: unknown): { chunks: number; lengths: number[] } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("chunks" in value) || !("lengths" in value)) return null;
  const chunks = value.chunks;
  const lengths = value.lengths;
  if (typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 0) return null;
  if (!Array.isArray(lengths)) return null;
  const nums: number[] = [];
  for (const length of lengths) {
    if (typeof length !== "number") return null;
    nums.push(length);
  }
  return { chunks, lengths: nums };
}

function metaChunkCount(value: unknown): number {
  return parseMeta(value)?.chunks ?? 0;
}

function chunkKey(index: number): string {
  return `keyword-probe-cache-${index}`;
}

function anchorLengthList(sql: SqlStorage): number[] {
  return sqlRows(
    sql,
    "SELECT DISTINCT length(anchor) AS n FROM user_keyword WHERE length(anchor) > 0 ORDER BY n",
  ).map((row) => {
    const n = row.n;
    if (typeof n !== "number") throw new TypeError("anchor length was not a number");
    return n;
  });
}

function fetchByAnchors(sql: SqlStorage, hits: readonly string[], scopeId: string | null): KeywordRow[] {
  if (hits.length === 0) return [];
  const payload = JSON.stringify(hits);
  const list = scopeId === null
    ? sqlRows(
      sql,
      "SELECT id, keyword, reply, anchor FROM user_keyword WHERE anchor IN (SELECT value FROM json_each(?)) ORDER BY _id",
      payload,
    )
    : sqlRows(
      sql,
      "SELECT id, keyword, reply, anchor FROM user_keyword WHERE anchor IN (SELECT value FROM json_each(?)) AND id = ? ORDER BY _id",
      payload,
      scopeId,
    );
  return list.map(keywordFrom);
}

function writeKeyword(sql: SqlStorage, row: KeywordSeed): void {
  const anchor = anchorOf(row.keyword);
  const existing = sql.exec(
    "SELECT _id FROM user_keyword WHERE id = ? AND keyword = ?",
    row.id,
    row.keyword,
  ).toArray()[0];
  if (existing === undefined) {
    sql.exec(
      "INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)",
      row.id,
      row.author,
      row.keyword,
      row.reply,
      anchor,
    );
    return;
  }
  sql.exec(
    "UPDATE user_keyword SET reply = ?, anchor = ? WHERE id = ? AND keyword = ?",
    row.reply,
    anchor,
    row.id,
    row.keyword,
  );
}

function keywordFrom(row: Record<string, unknown>): KeywordRow {
  const id = row.id;
  if (id !== null && typeof id !== "string") throw new TypeError("user_keyword.id was not text");
  const keyword = row.keyword;
  const reply = row.reply;
  const anchor = row.anchor;
  if (typeof keyword !== "string" || typeof reply !== "string" || typeof anchor !== "string") {
    throw new TypeError("user_keyword row was not text");
  }
  return { id, keyword, reply, anchor };
}

function sqlRows(
  sql: SqlStorage,
  query: string,
  ...bindings: Array<string | number | null>
): Record<string, unknown>[] {
  return sql.exec(query, ...bindings).toArray().map(asRecord);
}
