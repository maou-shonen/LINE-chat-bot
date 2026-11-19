import {
  inspectSql,
  migrateSql,
  type SchemaSnapshot,
} from "./schema";
import { parseSettingsPatch, type SettingsKey, type SettingsPatch, type SettingsView } from "./settings";
import { ahoHits, buildAho, decodeAho, encodeAho, type AhoMachine } from "./aho";
import {
  anchorOf,
  normalizeKeywordMessage,
  selectKeywordReplies as selectFromRows,
  selectKeywordRepliesOpen,
  type KeywordRow,
  type KeywordSelect,
  type KeywordSelectResult,
} from "./keywords";
import {
  decodeKeywordTable,
  deleteKeywordRow,
  emptyKeywordTable,
  encodeKeywordTable,
  materializeKeywordTable,
  rowsForHits,
  upsertKeywordRow,
  type KeywordStore,
  type KeywordTable,
} from "./keyword-rows";

const CACHE_META_KEY = "keyword-probe-cache-meta";
const ROW_META_KEY = "keyword-row-cache-meta";
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
  keywordCacheStats(): Promise<KeywordCacheStats>;
  auditKeywordSelect(query: KeywordSelect): Promise<KeywordAudit>;
}

export class SqliteBotRepository implements BotRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  private probeCache: ProbeCache | null = null;
  private cacheStats: KeywordCacheStats = {
    buildMs: 0, bytes: 0, chunks: 0, anchors: 0, rowBytes: 0, rowChunks: 0,
  };
  private rowsRead = 0;

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
    const cache = await this.readyCache(true);
    const table = this.keepMutable(cache);
    let dirty = false;
    this.storage.transactionSync(() => {
      for (const row of rows) {
        writeKeyword(this.storage.sql, row);
        upsertKeywordRow(table, row);
        if (addCachedAnchor(cache, anchorOf(row.keyword))) dirty = true;
      }
    });
    if (rows.length > 0) await this.persistProbeCache(dirty);
  }

  async deleteKeyword(id: string, keyword: string): Promise<void> {
    const cache = await this.readyCache(true);
    const table = this.keepMutable(cache);
    const anchor = anchorOf(keyword);
    this.storage.sql.exec(
      "DELETE FROM user_keyword WHERE id = ? AND keyword = ?",
      id,
      keyword,
    );
    deleteKeywordRow(table, id, keyword);
    const anchorsDirty = dropCachedAnchor(this.storage.sql, cache, anchor);
    await this.persistProbeCache(anchorsDirty);
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
    const cache = await this.readyCache(false);
    const scanStart = performance.now();
    const hits = message === "" ? [] : ahoHits(cache.machine, message);
    const scanMs = performance.now() - scanStart;
    const fetchStart = performance.now();
    const rows = this.rowsFor(message, query, hits);
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
      rowsRead: this.rowsRead,
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
      const rowRaw = await this.readRawRows();
      if (raw === null || rowRaw === null) throw new Error("probe cache blob is missing");
      const decodeStart = performance.now();
      const machine = decodeAho(raw.bytes);
      const table = decodeKeywordTable(rowRaw.bytes);
      const decoded = performance.now();
      this.probeCache = { machine, anchors: null, table };
      const result = await this.runSelect(query);
      requestMs.push(performance.now() - decodeStart);
      decodeMs.push(decoded - decodeStart);
      replies = result.replies;
      candidates = result.candidates;
      anchors = raw.anchors;
      bytes = raw.stored + rowRaw.stored;
      chunks = raw.chunks + rowRaw.chunks;
    }
    return { decodeMs, requestMs, replies, candidates, anchors, bytes, chunks };
  }

  async keywordCacheStats(): Promise<KeywordCacheStats> {
    return this.cacheStats;
  }

  private async runSelect(query: KeywordSelect): Promise<KeywordSelectResult> {
    const message = normalizeKeywordMessage(query.message, query.stripName);
    if (message === "") return selectFromRows([], query);
    const cache = await this.readyCache(false);
    const hits = ahoHits(cache.machine, message);
    const rows = this.rowsFor(message, query, hits);
    const selected = selectFromRows(rows, query);
    return { replies: selected.replies, candidates: rows.length };
  }

  async auditKeywordSelect(query: KeywordSelect): Promise<KeywordAudit> {
    const message = normalizeKeywordMessage(query.message, query.stripName);
    const cache = await this.readyCache(false);
    const hits = message === "" ? [] : ahoHits(cache.machine, message);
    const memory = message === "" ? [] : rowsForHits(cache.table, message, query, hits);
    const sql = message === "" ? [] : rowsForSelect(this.storage.sql, message, query, hits);
    return {
      memory: memory.map(rowTag),
      sql: sql.map(rowTag),
      replies: selectKeywordRepliesOpen(memory, query).replies,
      sqlReplies: selectKeywordRepliesOpen(sql, query).replies,
    };
  }

  private keepMutable(cache: ProbeCache): KeywordTable {
    if (cache.table.kind === "stored") cache.table = materializeKeywordTable(cache.table);
    return cache.table;
  }

  private rowsFor(message: string, query: KeywordSelect, hits: readonly string[]): KeywordRow[] {
    this.rowsRead = 0;
    return rowsForHits(this.probeCache?.table ?? emptyKeywordTable(), message, query, hits);
  }

  private async readyCache(needAnchors: boolean): Promise<ProbeCache> {
    if (this.probeCache === null) {
      const raw = await this.readRawCache();
      const rowRaw = await this.readRawRows();
      const table = rowRaw === null ? loadKeywordTable(this.storage.sql) : decodeKeywordTable(rowRaw.bytes);
      this.probeCache = raw === null
        ? { machine: buildAho([]), anchors: new Set(), table }
        : { machine: decodeAho(raw.bytes), anchors: null, table };
    }
    if (needAnchors && this.probeCache.anchors === null) {
      this.probeCache.anchors = loadAnchors(this.storage.sql);
    }
    return this.probeCache;
  }

  private async persistProbeCache(anchorsDirty: boolean): Promise<void> {
    const cache = this.probeCache;
    if (cache === null || cache.anchors === null) {
      throw new Error("probe cache anchors are missing");
    }
    const anchors = cache.anchors;
    let buildMs = this.cacheStats.buildMs;
    let bytes = this.cacheStats.bytes;
    let chunks = this.cacheStats.chunks;
    if (anchorsDirty) {
      const started = performance.now();
      cache.machine = buildAho(anchors);
      const encoded = encodeAho(cache.machine);
      const parts = splitChunks(encoded);
      const previous = metaChunkCount(await this.storage.get(CACHE_META_KEY));
      await this.storage.put(CACHE_META_KEY, {
        chunks: parts.length,
        anchors: anchors.size,
        bytes: encoded.byteLength,
      });
      for (let i = 0; i < parts.length; i += 1) {
        const chunk = parts[i] ?? new Uint8Array();
        await this.storage.put(chunkKey(i), chunk.buffer);
      }
      for (let i = parts.length; i < previous; i += 1) {
        await this.storage.delete(chunkKey(i));
      }
      buildMs = performance.now() - started;
      bytes = encoded.byteLength;
      chunks = parts.length;
    }
    if (cache.table.kind !== "map") throw new Error("row table is still stored");
    const encodedRows = encodeKeywordTable(cache.table);
    const rowParts = splitChunks(encodedRows);
    const previousRows = metaChunkCount(await this.storage.get(ROW_META_KEY));
    await this.storage.put(ROW_META_KEY, {
      chunks: rowParts.length,
      anchors: 0,
      bytes: encodedRows.byteLength,
    });
    for (let i = 0; i < rowParts.length; i += 1) {
      const chunk = rowParts[i] ?? new Uint8Array();
      await this.storage.put(rowChunkKey(i), chunk.buffer);
    }
    for (let i = rowParts.length; i < previousRows; i += 1) {
      await this.storage.delete(rowChunkKey(i));
    }
    this.cacheStats = {
      buildMs,
      bytes,
      chunks,
      anchors: anchors.size,
      rowBytes: encodedRows.byteLength,
      rowChunks: rowParts.length,
    };
  }

  private async readRawCache(): Promise<RawProbeCache | null> {
    const meta = parseMeta(await this.storage.get(CACHE_META_KEY));
    if (meta === null) return null;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < meta.chunks; i += 1) {
      const part = asBytes(await this.storage.get(chunkKey(i)));
      if (part === null) return null;
      parts.push(part);
    }
    const bytes = new Uint8Array(meta.bytes);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    if (at !== meta.bytes) return null;
    return { bytes, anchors: meta.anchors, stored: meta.bytes, chunks: meta.chunks };
  }

  private async readRawRows(): Promise<RawProbeCache | null> {
    const meta = parseMeta(await this.storage.get(ROW_META_KEY));
    if (meta === null) return null;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < meta.chunks; i += 1) {
      const part = asBytes(await this.storage.get(rowChunkKey(i)));
      if (part === null) return null;
      parts.push(part);
    }
    const bytes = new Uint8Array(meta.bytes);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    if (at !== meta.bytes) return null;
    return { bytes, anchors: 0, stored: meta.bytes, chunks: meta.chunks };
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
  rowsRead: number;
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

export interface KeywordCacheStats {
  buildMs: number;
  bytes: number;
  chunks: number;
  anchors: number;
  rowBytes: number;
  rowChunks: number;
}

export interface KeywordAudit {
  memory: string[];
  sql: string[];
  replies: string[] | null;
  sqlReplies: string[] | null;
}

interface ProbeCache {
  machine: AhoMachine;
  anchors: Set<string> | null;
  table: KeywordStore;
}

interface RawProbeCache {
  bytes: Uint8Array;
  anchors: number;
  stored: number;
  chunks: number;
}

function addCachedAnchor(cache: ProbeCache, anchor: string): boolean {
  const anchors = cache.anchors;
  if (anchors === null || anchor === "" || anchors.has(anchor)) return false;
  anchors.add(anchor);
  return true;
}

function dropCachedAnchor(sql: SqlStorage, cache: ProbeCache, anchor: string): boolean {
  const anchors = cache.anchors;
  if (anchors === null || anchor === "" || !anchors.has(anchor)) return false;
  const left = sql.exec(
    "SELECT 1 AS n FROM user_keyword WHERE anchor = ? LIMIT 1",
    anchor,
  ).toArray()[0];
  if (left !== undefined) return false;
  anchors.delete(anchor);
  return true;
}

function loadAnchors(sql: SqlStorage): Set<string> {
  const anchors = new Set<string>();
  for (const row of sqlRows(sql, "SELECT DISTINCT anchor FROM user_keyword")) {
    const anchor = row.anchor;
    if (typeof anchor === "string" && anchor !== "") anchors.add(anchor);
  }
  return anchors;
}

function rowsForSelect(
  sql: SqlStorage,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordRow[] {
  if (message !== "" && !query.allReply) {
    const exact = fetchByKeyword(sql, message, query.scopeId);
    for (const row of exact) {
      const reply = row.reply.startsWith("@") ? row.reply.slice(1) : row.reply;
      if (query.excludeUrl && reply.includes("https:")) continue;
      return [row];
    }
  }
  return fetchByAnchors(sql, hits, query.scopeId);
}

function splitChunks(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength === 0) return [bytes];
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK_MAX_BYTES) {
    chunks.push(bytes.slice(i, i + CHUNK_MAX_BYTES));
  }
  return chunks;
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  return null;
}

function parseMeta(value: unknown): { chunks: number; anchors: number; bytes: number } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("chunks" in value) || !("anchors" in value) || !("bytes" in value)) return null;
  const chunks = value.chunks;
  const anchors = value.anchors;
  const bytes = value.bytes;
  if (typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 0) return null;
  if (typeof anchors !== "number" || !Number.isInteger(anchors) || anchors < 0) return null;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) return null;
  return { chunks, anchors, bytes };
}

function metaChunkCount(value: unknown): number {
  return parseMeta(value)?.chunks ?? 0;
}

function chunkKey(index: number): string {
  return `keyword-probe-cache-${index}`;
}

function rowChunkKey(index: number): string {
  return `keyword-row-cache-${index}`;
}

function loadKeywordTable(sql: SqlStorage): KeywordTable {
  const table = emptyKeywordTable();
  for (const row of sqlRows(
    sql,
    "SELECT id, keyword, reply FROM user_keyword ORDER BY _id",
  )) {
    const keyword = row.keyword;
    const reply = row.reply;
    const id = row.id;
    if (typeof keyword !== "string" || typeof reply !== "string") {
      throw new TypeError("user_keyword row was not text");
    }
    if (id !== null && typeof id !== "string") throw new TypeError("user_keyword.id was not text");
    upsertKeywordRow(table, { id, keyword, reply });
  }
  return table;
}

function rowTag(row: KeywordRow): string {
  return `${row.id ?? ""}\t${row.keyword}\t${row.reply}`;
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

function fetchByKeyword(sql: SqlStorage, keyword: string, scopeId: string | null): KeywordRow[] {
  const list = scopeId === null
    ? sqlRows(
      sql,
      "SELECT id, keyword, reply, anchor FROM user_keyword WHERE keyword = ? ORDER BY _id",
      keyword,
    )
    : sqlRows(
      sql,
      "SELECT id, keyword, reply, anchor FROM user_keyword WHERE keyword = ? AND id = ? ORDER BY _id",
      keyword,
      scopeId,
    );
  return list.map(keywordFrom);
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
