import {
  inspectSql,
  migrateSql,
  type SchemaSnapshot,
} from "./schema";
import { parseSettingsPatch, type SettingsKey, type SettingsPatch, type SettingsView } from "./settings";
import {
  encodeCountMap,
  mergeCounts,
  parseCountMap,
  type CountMap,
  type CountSource,
} from "./counts";
import { ahoHits, buildAho, decodeAho, encodeAho, startAhoBuild, stepAhoBuild, type AhoBuild, type AhoMachine } from "./aho";
import { Hydrator } from "./hydrate";
import { NO_PHASES, PhaseTimer } from "./phases";
import { EXPORT_TABLES, type ExportPage, type ExportTable } from "./export-tables";
import { renderReply } from "./gacha";
import {
  anchorOf,
  matchKeyword,
  normalizeKeywordMessage,
  playRng,
  selectKeywordReplies as selectFromRows,
  selectKeywordRepliesOpen,
  type KeywordRow,
  type KeywordSelect,
  type KeywordSelectResult,
} from "./keywords";
import { BLOB_CHUNK_BYTES, KEYWORD_CACHE_META_KEY, KEYWORD_CACHE_VERSION, ahoChunkKey, rowChunkKey } from "./blob-store";
import {
  applyOverlayOp,
  applyRowDelta,
  decodeKeywordTable,
  deleteKeywordRow,
  emptyKeywordTable,
  encodeKeywordRows,
  findKeywordRow,
  KEYWORD_CHUNK_COUNT,
  keywordChunk,
  listKeywordTexts,
  matchingRows,
  registerChunk,
  rowsForHits,
  snapshotRows,
  startChunkEncodeJob,
  stepChunkEncodeJob,
  upsertKeywordRow,
  visitKeywordRows,
  type ChunkEncodeJob,
  type ChunkedKeywordTable,
  type KeywordMatchRows,
  type KeywordStore,
  type KeywordTable,
  type RowDeltaOp,
} from "./keyword-rows";

const EXPORT_SQL: Record<ExportTable, { from: string; columns: string }> = {
  user: { from: "user", columns: "id, name, create_on, update_on" },
  group: {
    from: '"group"',
    columns: "id, _id, _count, _setting, _admin, create_on, update_on",
  },
  group_user: { from: "group_user", columns: "gid, uid, _count, _setting" },
  user_settings: { from: "user_settings", columns: "group_id, user_id, options" },
  user_keyword: { from: "user_keyword", columns: "id, author, keyword, reply, anchor" },
  keywords_logs: { from: "keywords_logs", columns: "_id, id, keyword, reply, create_on" },
  keyword_tombstone: { from: "keyword_tombstone", columns: "id, keyword" },
  group_user_tombstone: { from: "group_user_tombstone", columns: "gid, uid" },
};

const DELTA_META_KEY = "keyword-row-delta-meta";
const COMPACT_BUDGET_MS = 1;
export const KEYWORD_DELTA_LIMIT = 32;
const STORE_SLICE_BYTES = 200_000;

export interface BotRepository {
  migrate(): Promise<void>;
  getSettings(key: SettingsKey): Promise<SettingsView>;
  upsertSettings(key: SettingsKey, patch: SettingsPatch): Promise<void>;
  omitSettings(key: SettingsKey, names: readonly string[]): Promise<void>;
  countSettings(key: SettingsKey): Promise<number>;
  inspectSchema(): Promise<SchemaSnapshot>;
  putKeywords(rows: KeywordSeed[]): Promise<void>;
  deleteKeyword(id: string, keyword: string): Promise<void>;
  deleteKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus>;
  anchorLengths(): Promise<number[]>;
  selectKeywordReplies(query: KeywordSelect): Promise<KeywordSelectResult>;
  measureKeywordSelect(query: KeywordSelect, rounds: number): Promise<KeywordMeasure>;
  profileKeywordSelect(query: KeywordSelect): Promise<KeywordProfile>;
  measureColdRequest(query: KeywordSelect, rounds: number): Promise<ColdKeywordMeasure>;
  keywordCacheStats(): Promise<KeywordCacheStats>;
  auditKeywordSelect(query: KeywordSelect): Promise<KeywordAudit>;
  compactKeywordCache(): Promise<KeywordCompact>;
  measureKeywordWrite(sample: KeywordWriteSample): Promise<KeywordWriteMeasure>;
  touchAndCount(input: TouchAndCount): Promise<void>;
  inspectTouch(): Promise<TouchRows>;
  upsertKeyword(input: KeywordWrite): Promise<KeywordWriteStatus>;
  deleteKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus>;
  getKeyword(input: KeywordLookup): Promise<string | null>;
  listKeywords(scopeId: string | null): Promise<string[]>;
  inspectKeywords(): Promise<KeywordSnapshot>;
  exportPage(table: ExportTable, after: number, limit: number): Promise<ExportPage>;
  keywordRows(query: KeywordSelect): Promise<KeywordRow[]>;
  keywordMatches(query: KeywordSelect): Promise<KeywordMatchRows>;
  measureKeywordRender(query: KeywordSelect, rounds: number): Promise<KeywordMeasure>;
  measureColdRender(query: KeywordSelect, rounds: number): Promise<ColdKeywordMeasure>;
  userName(id: string): Promise<string | null>;
  setUserName(id: string, name: string): Promise<void>;
  readGroupWeights(groupId: string): Promise<CountMap>;
  writeGroupWeight(groupId: string, key: string, value: number): Promise<void>;
  listGroupUsers(groupId: string): Promise<GroupUserRow[]>;
  deleteGroupUsers(groupId: string, userId: string | null): Promise<void>;
  fixtureSlices(): Promise<FixtureSlices>;
  pumpHydration(): Promise<boolean>;
}

export class SqliteBotRepository implements BotRepository {
  private readonly cold: Hydrator;
  private readonly coldMode: boolean;
  private readonly rowSliceBytes: number;

  constructor(
    private readonly storage: DurableObjectStorage,
    hydrate = false,
    private readonly timing = false,
  ) {
    this.cold = new Hydrator(storage, hydrate);
    this.coldMode = hydrate;
    this.rowSliceBytes = hydrate ? BLOB_CHUNK_BYTES : STORE_SLICE_BYTES;
  }

  private probeCache: ProbeCache | null = null;
  private cacheStats: KeywordCacheStats = {
    buildMs: 0, bytes: 0, chunks: 0, anchors: 0, rowBytes: 0, rowChunks: 0,
  };
  private rowsRead = 0;
  private compactJob: CompactJob | null = null;

  private phases(): PhaseTimer {
    return this.timing ? new PhaseTimer(true) : NO_PHASES;
  }

  async migrate(): Promise<void> {
    const phases = this.phases();
    phases.start("sql");
    this.storage.transactionSync(() => {
      migrateSql(this.storage.sql);
    });
    phases.end("sql");
    phases.flush("migrate");
  }

  async getSettings(key: SettingsKey): Promise<SettingsView> {
    const phases = this.phases();
    phases.start("hydrate");
    await this.cold.beforeSettings(key);
    phases.end("hydrate");
    phases.start("sql");
    const current = readOptions(this.storage.sql, key);
    phases.end("sql");
    phases.flush("settings");
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
    await this.cold.beforeSettings(key);
    this.storage.transactionSync(() => {
      const current = readOptions(this.storage.sql, key);
      const next = { ...(current?.options ?? {}), ...patch };
      writeOptions(this.storage.sql, key, current, next);
    });
  }

  async omitSettings(key: SettingsKey, names: readonly string[]): Promise<void> {
    await this.cold.beforeSettings(key);
    this.storage.transactionSync(() => {
      const current = readOptions(this.storage.sql, key);
      if (current === null) return;
      const next = { ...current.options };
      for (const name of names) delete next[name];
      writeOptions(this.storage.sql, key, current, next);
    });
  }

  async countSettings(key: SettingsKey): Promise<number> {
    await this.cold.beforeSettings(key);
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

  async touchAndCount(input: TouchAndCount): Promise<void> {
    const phases = this.phases();
    phases.start("hydrate");
    await this.cold.beforeTouch(input.source.groupId, input.source.userId);
    phases.end("hydrate");
    phases.start("sql");
    this.storage.transactionSync(() => {
      writeTouch(this.storage.sql, input);
    });
    phases.end("sql");
    phases.flush("touch");
  }

  async pumpHydration(): Promise<boolean> {
    return this.cold.pump();
  }

  async inspectTouch(): Promise<TouchRows> {
    return readTouch(this.storage.sql);
  }

  async putKeywords(rows: KeywordSeed[]): Promise<void> {
    if (rows.length === 0) return;
    const cache = await this.readyCache(false);
    await this.ensureChunksForAnchors(cache.table, rows.map((row) => anchorOf(row.keyword)));
    const ops: RowDeltaOp[] = [];
    this.storage.transactionSync(() => {
      for (const row of rows) {
        writeKeyword(this.storage.sql, row);
        const op: RowDeltaOp = { op: "put", id: row.id, keyword: row.keyword, reply: row.reply };
        ops.push(op);
        this.applyOp(cache, op);
        if (!anchorUsedByOther(this.storage.sql, anchorOf(row.keyword), row.id, row.keyword)) {
          cache.pending.add(anchorOf(row.keyword));
        }
      }
    });
    await this.appendDelta(ops);
    await this.nudgeCompact();
  }

  async deleteKeyword(id: string, keyword: string): Promise<void>;
  async deleteKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus>;
  async deleteKeyword(
    idOrInput: string | KeywordDelete,
    keyword?: string,
  ): Promise<void | KeywordDeleteStatus> {
    if (typeof idOrInput !== "string") return this.deleteStoredKeyword(idOrInput);
    const id = idOrInput;
    if (keyword === undefined) throw new TypeError("keyword is missing");
    const cache = await this.readyCache(false);
    const anchor = anchorOf(keyword);
    await this.ensureChunksForAnchors(cache.table, [anchor]);
    this.storage.sql.exec(
      "DELETE FROM user_keyword WHERE id = ? AND keyword = ?",
      id,
      keyword,
    );
    const op: RowDeltaOp = { op: "del", id, keyword, reply: "" };
    this.applyOp(cache, op);
    if (!anchorUsed(this.storage.sql, anchor)) cache.pending.delete(anchor);
    await this.appendDelta([op]);
    await this.nudgeCompact();
  }

  async compactKeywordCache(): Promise<KeywordCompact> {
    const started = performance.now();
    const cache = await this.readyCache(false);
    if (this.compactJob === null) {
      if (!this.needsCompact(cache)) {
        return { done: true, ms: performance.now() - started, phase: "idle" };
      }
      this.compactJob = await this.beginCompact();
    }
    const job = this.compactJob;
    if (job.phase === "load") {
      const base = cache.table.kind === "overlay" ? cache.table.base : cache.table;
      if (base.kind === "chunked") {
        const batch: number[] = [];
        while (job.loadAt < base.chunkCount && batch.length < 4) {
          if (!base.loaded.has(job.loadAt)) batch.push(job.loadAt);
          job.loadAt += 1;
        }
        await this.loadChunks(base, batch);
        if (job.loadAt < base.chunkCount) {
          return { done: false, ms: performance.now() - started, phase: "load" };
        }
      }
      job.phase = "encode";
      return { done: false, ms: performance.now() - started, phase: "encode" };
    }
    if (job.phase === "encode") {
      const done = stepChunkEncodeJob(job.encode, COMPACT_BUDGET_MS);
      if (done) {
        job.anchors = job.encode.anchors;
        job.phase = "aho";
        job.aho = startAhoBuild(job.anchors);
        return { done: false, ms: performance.now() - started, phase: "aho" };
      }
    }
    const elapsed = () => performance.now() - started;
    if (job.phase === "aho" && job.aho !== null && elapsed() < COMPACT_BUDGET_MS) {
      const done = stepAhoBuild(job.aho, COMPACT_BUDGET_MS - elapsed());
      if (done && job.aho.machine !== null) {
        cache.machine = job.aho.machine;
        cache.hitsMessage = null;
        cache.hits = null;
        job.base = {
          kind: "chunked",
          gen: job.rowGen,
          rowCount: job.encode.rowCount,
          chunkCount: KEYWORD_CHUNK_COUNT,
          emptyAnchor: job.encode.hasEmptyAnchor,
          lengths: job.encode.lengths,
          loaded: new Map(),
          rowIndex: new Map(),
        };
        job.phase = "store";
        return { done: false, ms: performance.now() - started, phase: "store" };
      }
    }
    if (job.phase === "store" && elapsed() < COMPACT_BUDGET_MS) {
      const done = await this.storeCompactSlice(cache, job, COMPACT_BUDGET_MS - elapsed());
      if (done) {
        this.compactJob = null;
        const more = this.needsCompact(cache);
        return { done: !more, ms: performance.now() - started, phase: more ? "again" : "done" };
      }
    }
    return { done: false, ms: performance.now() - started, phase: job.phase === "encode" ? `encode:${job.encode.phase}` : job.phase };
  }

  async measureKeywordWrite(sample: KeywordWriteSample): Promise<KeywordWriteMeasure> {
    let loadMs = 0;
    if (sample.cold) {
      this.probeCache = null;
      this.compactJob = null;
      const loaded = performance.now();
      await this.readyCache(false);
      loadMs = performance.now() - loaded;
    }
    const started = performance.now();
    if (sample.op === "delete") await this.deleteKeyword(sample.id, sample.keyword);
    else await this.putKeywords([{ id: sample.id, author: "bench", keyword: sample.keyword, reply: sample.reply }]);
    return { cpuMs: performance.now() - started, loadMs };
  }

  async anchorLengths(): Promise<number[]> {
    if (!this.coldMode) return anchorLengthList(this.storage.sql);
    const cache = await this.readyCache(false);
    await this.ensureAllChunks(cache.table);
    const lengths = new Set<number>();
    for (const row of snapshotRows(cache.table)) {
      if (row.anchor !== "") lengths.add([...row.anchor].length);
    }
    return [...lengths].sort((left, right) => left - right);
  }

  async selectKeywordReplies(query: KeywordSelect): Promise<KeywordSelectResult> {
    return this.runSelect(query);
  }

  async keywordRows(query: KeywordSelect): Promise<KeywordRow[]> {
    const phases = this.phases();
    phases.start("normalize");
    const message = query.preNormalized === true
      ? query.message
      : normalizeKeywordMessage(query.message, query.stripName);
    phases.end("normalize");
    if (message === "") {
      phases.flush("keywordRows");
      return [];
    }
    phases.count("chars", message.length);
    phases.start("cache");
    const cache = await this.readyCache(false);
    phases.end("cache");
    phases.start("probe");
    const hits = probeHits(cache, message);
    phases.end("probe");
    phases.count("hits", hits.length);
    phases.start("rows");
    const rows = await this.rowsFor(message, query, hits, phases);
    phases.end("rows");
    phases.flush("keywordRows");
    return rows;
  }

  async keywordMatches(query: KeywordSelect): Promise<KeywordMatchRows> {
    const phases = this.phases();
    phases.start("normalize");
    const message = query.preNormalized === true
      ? query.message
      : normalizeKeywordMessage(query.message, query.stripName);
    phases.end("normalize");
    if (message === "") {
      phases.flush("keywordMatches");
      return { rows: [], candidates: 0 };
    }
    phases.count("chars", message.length);
    phases.start("cache");
    const cache = await this.readyCache(false);
    phases.end("cache");
    phases.start("probe");
    const hits = probeHits(cache, message);
    phases.end("probe");
    phases.count("hits", hits.length);
    phases.start("chunks");
    await this.ensureChunksForQuery(cache.table, message, hits, query.allReply, phases);
    phases.end("chunks");
    phases.start("rows");
    const result = matchingRows(cache.table, message, query, hits);
    phases.end("rows");
    phases.count("candidates", result.candidates);
    phases.count("matched", result.rows.length);
    phases.flush("keywordMatches");
    return result;
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
    const hits = message === "" ? [] : probeHits(cache, message);
    const scanMs = performance.now() - scanStart;
    const fetchStart = performance.now();
    const rows = await this.rowsFor(message, query, hits);
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

  async measureKeywordRender(query: KeywordSelect, rounds: number): Promise<KeywordMeasure> {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) {
      throw new TypeError("rounds out of range");
    }
    const samplesMs: number[] = [];
    let replies: string[] | null = null;
    let candidates = 0;
    for (let i = 0; i < rounds; i += 1) {
      const start = performance.now();
      const rendered = await this.renderFromRows(query);
      samplesMs.push(performance.now() - start);
      replies = rendered.replies;
      candidates = rendered.candidates;
    }
    return { samplesMs, replies, candidates };
  }

  async measureColdRender(query: KeywordSelect, rounds: number): Promise<ColdKeywordMeasure> {
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
      this.compactJob = null;
      const loaded = await this.loadCold(NO_PHASES);
      const decodeStart = performance.now();
      await this.installCache(loaded.meta, loaded.aho, loaded.delta);
      const decoded = performance.now();
      const rendered = await this.renderFromRows(query);
      requestMs.push(performance.now() - decodeStart);
      decodeMs.push(decoded - decodeStart);
      replies = rendered.replies;
      candidates = rendered.candidates;
      anchors = this.cacheStats.anchors;
      bytes = this.cacheStats.bytes + this.cacheStats.rowBytes;
      chunks = this.cacheStats.chunks + this.cacheStats.rowChunks;
    }
    return { decodeMs, requestMs, replies, candidates, anchors, bytes, chunks };
  }

  private async renderFromRows(query: KeywordSelect): Promise<KeywordSelectResult> {
    const rows = await this.keywordRows(query);
    const message = normalizeKeywordMessage(query.message, query.stripName);
    const rng = playRng(query.rng);
    const winner = message === "" ? null : matchKeyword(message, rows, query, rng);
    const replies = winner === null
      ? null
      : renderReply({
        reply: winner,
        message,
        userId: "",
        now: new Date(0),
        rng,
      });
    rng.finish();
    return { replies, candidates: rows.length };
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
      this.compactJob = null;
      const loaded = await this.loadCold(NO_PHASES);
      const decodeStart = performance.now();
      await this.installCache(loaded.meta, loaded.aho, loaded.delta);
      const decoded = performance.now();
      const result = await this.runSelect(query);
      requestMs.push(performance.now() - decodeStart);
      decodeMs.push(decoded - decodeStart);
      replies = result.replies;
      candidates = result.candidates;
      anchors = this.cacheStats.anchors;
      bytes = this.cacheStats.bytes + this.cacheStats.rowBytes;
      chunks = this.cacheStats.chunks + this.cacheStats.rowChunks;
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
    const hits = probeHits(cache, message);
    const rows = await this.rowsFor(message, query, hits);
    const selected = selectFromRows(rows, query);
    return { replies: selected.replies, candidates: rows.length };
  }

  async auditKeywordSelect(query: KeywordSelect): Promise<KeywordAudit> {
    const message = normalizeKeywordMessage(query.message, query.stripName);
    const cache = await this.readyCache(false);
    const hits = message === "" ? [] : probeHits(cache, message);
    if (message !== "") await this.ensureChunksForQuery(cache.table, message, hits, query.allReply);
    const memory = message === "" ? [] : rowsForHits(cache.table, message, query, hits);
    const sql = message === "" ? [] : rowsForSelect(this.storage.sql, message, query, hits);
    return {
      memory: memory.map(rowTag),
      sql: sql.map(rowTag),
      replies: selectKeywordRepliesOpen(memory, query).replies,
      sqlReplies: selectKeywordRepliesOpen(sql, query).replies,
    };
  }

  private async rowsFor(
    message: string,
    query: KeywordSelect,
    hits: readonly string[],
    phases: PhaseTimer = NO_PHASES,
  ): Promise<KeywordRow[]> {
    const cache = await this.readyCache(false);
    await this.ensureChunksForQuery(cache.table, message, hits, query.allReply, phases);
    this.rowsRead = 0;
    const rows = rowsForHits(cache.table, message, query, hits);
    phases.count("candidates", rows.length);
    return rows;
  }

  private logicalKeyword(
    cache: ProbeCache,
    scopeId: string | null,
    keyword: string,
    sqlRow: KeywordExisting | null,
  ): { author: string | null; reply: string } | null {
    if (!this.coldMode) return sqlRow;
    const row = findKeywordRow(cache.table, scopeId, keyword);
    if (row === null) return null;
    return { author: sqlRow?.author ?? row.author, reply: row.reply };
  }

  private async noteKeywordOps(cache: ProbeCache, ops: RowDeltaOp[]): Promise<void> {
    for (const op of ops) {
      this.applyOp(cache, op);
      const anchor = anchorOf(op.keyword);
      if (op.op === "del") {
        if (!anchorUsed(this.storage.sql, anchor)) cache.pending.delete(anchor);
      } else if (!anchorUsedByOther(this.storage.sql, anchor, op.id, op.keyword)) {
        cache.pending.add(anchor);
      }
    }
    await this.appendDelta(ops);
    await this.nudgeCompact();
  }

  private applyOp(cache: ProbeCache, op: RowDeltaOp): void {
    cache.hitsMessage = null;
    cache.hits = null;
    if (cache.table.kind === "map") {
      if (op.op === "del") deleteKeywordRow(cache.table, op.id, op.keyword);
      else upsertKeywordRow(cache.table, op);
      return;
    }
    const overlay = cache.table.kind === "overlay"
      ? cache.table
      : applyRowDelta(cache.table, []);
    applyOverlayOp(overlay, op);
    cache.table = overlay;
  }

  private async readyCache(_needAnchors: boolean): Promise<ProbeCache> {
    if (this.probeCache !== null) return this.probeCache;
    const phases = this.phases();
    const loaded = await this.loadCold(phases);
    const cache = await this.installCache(loaded.meta, loaded.aho, loaded.delta, phases);
    phases.flush("cacheLoad");
    return cache;
  }

  private async loadCold(
    phases: PhaseTimer,
  ): Promise<{ meta: KeywordMeta | null; aho: Uint8Array | null; delta: RowDeltaOp[] }> {
    phases.start("coldGet");
    const values = await this.storage.get([KEYWORD_CACHE_META_KEY, DELTA_META_KEY]);
    phases.end("coldGet");
    const meta = parseKeywordMeta(values.get(KEYWORD_CACHE_META_KEY));
    const deltaValue = values.get(DELTA_META_KEY);
    let aho: Uint8Array | null = null;
    if (meta !== null) {
      phases.start("ahoGet");
      aho = await this.readAho(meta, phases);
      phases.end("ahoGet");
      phases.count("ahoChunks", meta.ahoChunks);
      phases.count("ahoBytes", meta.ahoBytes);
    }
    phases.start("deltaGet");
    const delta = await this.readDeltaOpsFrom(deltaValue, phases);
    phases.end("deltaGet");
    phases.count("deltaOps", delta.length);
    return { meta, aho, delta };
  }

  private async installCache(
    meta: KeywordMeta | null,
    aho: Uint8Array | null,
    delta: readonly RowDeltaOp[],
    phases: PhaseTimer = NO_PHASES,
  ): Promise<ProbeCache> {
    phases.start("ahoDecode");
    const machine = aho === null ? buildAho([]) : decodeAho(aho);
    phases.end("ahoDecode");
    let table: KeywordStore;
    const pending = new Set<string>();
    if (meta === null) {
      const loaded = loadKeywordTable(this.storage.sql);
      table = loaded;
      for (const row of loaded.rows) {
        if (row !== null && row.anchor !== "") pending.add(row.anchor);
      }
      this.cacheStats = {
        buildMs: this.cacheStats.buildMs, bytes: 0, chunks: 0, anchors: 0, rowBytes: 0, rowChunks: 0,
      };
    } else {
      const base: ChunkedKeywordTable = {
        kind: "chunked",
        gen: meta.rowGen,
        rowCount: meta.rowCount,
        chunkCount: meta.rowChunks,
        emptyAnchor: meta.emptyAnchor,
        lengths: meta.lengths,
        loaded: new Map(),
        rowIndex: new Map(),
      };
      if (delta.length === 0) {
        table = base;
      } else {
        phases.start("deltaAnchors");
        await this.ensureChunks(base, delta.map((op) => anchorOf(op.keyword)), phases);
        phases.end("deltaAnchors");
        phases.start("deltaApply");
        table = applyRowDelta(base, delta);
        phases.end("deltaApply");
        for (const op of delta) {
          if (op.op === "put") {
            const anchor = anchorOf(op.keyword);
            if (anchor !== "") pending.add(anchor);
          }
        }
      }
      this.cacheStats = {
        buildMs: this.cacheStats.buildMs,
        bytes: meta.ahoBytes,
        chunks: meta.ahoChunks,
        anchors: meta.anchors,
        rowBytes: meta.rowBytes,
        rowChunks: meta.rowChunks,
      };
    }
    this.probeCache = {
      machine,
      meta,
      table,
      pending,
      deltaOps: delta.length,
      hitsMessage: null,
      hits: null,
    };
    return this.probeCache;
  }

  private async ensureChunksForAnchors(
    table: KeywordStore,
    anchors: Iterable<string>,
    phases: PhaseTimer = NO_PHASES,
  ): Promise<void> {
    const base = table.kind === "overlay" ? table.base : table;
    if (base.kind === "chunked") await this.ensureChunks(base, anchors, phases);
  }

  private async ensureChunksForQuery(
    table: KeywordStore,
    message: string,
    hits: readonly string[],
    allReply = false,
    phases: PhaseTimer = NO_PHASES,
  ): Promise<void> {
    const anchors = [...hits];
    if (message !== "" && !allReply) anchors.push(anchorOf(message));
    await this.ensureChunksForAnchors(table, anchors, phases);
  }

  private async ensureChunks(
    base: ChunkedKeywordTable,
    anchors: Iterable<string>,
    phases: PhaseTimer = NO_PHASES,
  ): Promise<void> {
    const ids = new Set<number>();
    for (const anchor of anchors) {
      if (anchor === "" && !base.emptyAnchor) continue;
      ids.add(keywordChunk(anchor, base.chunkCount));
    }
    const missing = [...ids].filter((id) => !base.loaded.has(id));
    phases.count("chunksMissing", missing.length);
    await this.loadChunks(base, missing, phases);
  }

  private async ensureAllChunks(table: KeywordStore): Promise<void> {
    const base = table.kind === "overlay" ? table.base : table;
    if (base.kind !== "chunked") return;
    const missing: number[] = [];
    for (let id = 0; id < base.chunkCount; id += 1) {
      if (!base.loaded.has(id)) missing.push(id);
    }
    await this.loadChunks(base, missing);
  }

  private async loadChunks(
    base: ChunkedKeywordTable,
    ids: readonly number[],
    phases: PhaseTimer = NO_PHASES,
  ): Promise<void> {
    if (ids.length === 0) return;
    const keys = ids.map((id) => rowChunkKey(base.gen, id));
    const getStart = phases.enabled ? performance.now() : 0;
    const batches: Array<Promise<Map<string, unknown>>> = [];
    for (let at = 0; at < keys.length; at += 16) {
      batches.push(this.storage.get(keys.slice(at, at + 16)));
    }
    const values = new Map((await Promise.all(batches)).flatMap((batch) => [...batch]));
    if (phases.enabled) phases.add("chunkGet", performance.now() - getStart);
    for (let i = 0; i < ids.length; i += 1) {
      const raw = asBytes(values.get(keys[i] ?? ""));
      if (raw === null) {
        const meta = await this.readMeta();
        const genKeys = await this.storage.list({ prefix: `keyword-rows-${base.gen}-` });
        const metaKeys = meta === null ? null : await this.storage.list({ prefix: `keyword-rows-${meta.rowGen}-` });
        throw new TypeError(
          `keyword row chunk was missing gen=${base.gen} id=${ids[i]} chunks=${base.chunkCount} metaGen=${meta?.rowGen} metaChunks=${meta?.rowChunks} genKeys=${genKeys.size} metaKeys=${metaKeys?.size}`,
        );
      }
      phases.count("chunkBytes", raw.byteLength);
      const decodeStart = phases.enabled ? performance.now() : 0;
      const chunk = decodeKeywordTable(raw);
      if (phases.enabled) phases.add("chunkDecode", performance.now() - decodeStart);
      registerChunk(base, ids[i] as number, chunk);
    }
  }

  private needsCompact(cache: ProbeCache): boolean {
    return cache.pending.size >= KEYWORD_DELTA_LIMIT || cache.deltaOps >= KEYWORD_DELTA_LIMIT;
  }

  private async nudgeCompact(): Promise<void> {
    const cache = this.probeCache;
    if (cache === null || (!this.compactJob && !this.needsCompact(cache))) return;
    await this.compactKeywordCache();
    if (this.compactJob !== null || (this.probeCache !== null && this.needsCompact(this.probeCache))) {
      await this.storage.setAlarm(Date.now() + 10);
    }
  }

  private async beginCompact(): Promise<CompactJob> {
    const cache = this.probeCache;
    if (cache === null) throw new Error("probe cache is missing");
    const oldMeta = await this.readMeta();
    return {
      encode: startChunkEncodeJob(cache.table),
      aho: null,
      anchors: [],
      phase: "load",
      loadAt: 0,
      base: null,
      deltaBase: metaChunkCount(await this.storage.get(DELTA_META_KEY)),
      deltaOpsAtStart: cache.deltaOps,
      deletedTo: 0,
      ahoBytes: null,
      ahoParts: [],
      ahoAt: 0,
      rowAt: 0,
      rowBytes: 0,
      ahoGen: (oldMeta?.ahoGen ?? 0) + 1,
      rowGen: (oldMeta?.rowGen ?? 0) + 1,
      oldMeta,
      flipped: false,
      oldDeletedTo: 0,
    };
  }

  private async storeCompactSlice(cache: ProbeCache, job: CompactJob, budgetMs: number): Promise<boolean> {
    const started = performance.now();
    const machine = job.aho?.machine ?? null;
    if (machine === null) throw new Error("compact store started early");
    if (job.ahoBytes === null) {
      job.ahoBytes = encodeAho(machine);
      job.ahoParts = splitChunks(job.ahoBytes, this.rowSliceBytes);
      return false;
    }
    if (job.ahoAt < job.ahoParts.length) {
      const part = job.ahoParts[job.ahoAt] ?? new Uint8Array();
      await this.storage.put(ahoChunkKey(job.ahoGen, job.ahoAt), part.buffer);
      job.ahoAt += 1;
      return false;
    }
    if (job.rowAt < KEYWORD_CHUNK_COUNT) {
      const part = job.encode.bytes[job.rowAt] ?? encodeKeywordRows([], []);
      await this.storage.put(rowChunkKey(job.rowGen, job.rowAt), part.buffer);
      if (job.base === null) throw new Error("compact base was missing");
      registerChunk(job.base, job.rowAt, decodeKeywordTable(part));
      job.rowBytes += part.byteLength;
      job.rowAt += 1;
      return false;
    }
    if (job.deletedTo < job.deltaBase) {
      const end = Math.min(job.deltaBase, job.deletedTo + 2);
      for (let i = job.deletedTo; i < end; i += 1) await this.storage.delete(deltaChunkKey(i));
      job.deletedTo = end;
      if (job.deletedTo < job.deltaBase || performance.now() - started >= budgetMs) return false;
    }
    if (!job.flipped) {
      if (job.rowAt !== KEYWORD_CHUNK_COUNT || job.base === null || job.base.loaded.size !== KEYWORD_CHUNK_COUNT) {
        throw new Error(`compact chunk count mismatch rowAt=${job.rowAt} loaded=${job.base?.loaded.size}`);
      }
      const meta: KeywordMeta = {
        version: KEYWORD_CACHE_VERSION,
        ahoGen: job.ahoGen,
        ahoChunks: job.ahoParts.length,
        ahoBytes: job.ahoBytes.byteLength,
        rowGen: job.rowGen,
        rowChunks: KEYWORD_CHUNK_COUNT,
        rowBytes: job.rowBytes,
        rowCount: job.encode.rowCount,
        anchors: job.anchors.length,
        emptyAnchor: job.encode.hasEmptyAnchor,
        lengths: job.encode.lengths,
      };
      await this.storage.put(KEYWORD_CACHE_META_KEY, meta);
      job.flipped = true;
      cache.meta = meta;
      cache.deltaOps = Math.max(0, cache.deltaOps - job.deltaOpsAtStart);
      return false;
    }
    const oldChunks = (job.oldMeta?.ahoChunks ?? 0) + (job.oldMeta?.rowChunks ?? 0);
    if (job.oldDeletedTo < oldChunks) {
      const index = job.oldDeletedTo;
      const oldMeta = job.oldMeta;
      if (oldMeta !== null) {
        if (index < oldMeta.ahoChunks) await this.storage.delete(ahoChunkKey(oldMeta.ahoGen, index));
        else await this.storage.delete(rowChunkKey(oldMeta.rowGen, index - oldMeta.ahoChunks));
      }
      job.oldDeletedTo += 1;
      return false;
    }
    const base = job.base;
    if (base === null) throw new Error("compact base was missing");
    const built = new Set(job.anchors);
    for (const anchor of cache.pending) {
      if (built.has(anchor)) cache.pending.delete(anchor);
    }
    cache.hitsMessage = null;
    cache.hits = null;
    if (cache.deltaOps === 0) {
      cache.table = base;
    }
    // With remaining deltas the old overlay already reflects every write;
    // the next compaction folds them into a fresh base.
    this.cacheStats = {
      buildMs: this.cacheStats.buildMs,
      bytes: job.ahoBytes.byteLength,
      chunks: job.ahoParts.length,
      anchors: job.anchors.length,
      rowBytes: job.rowBytes,
      rowChunks: KEYWORD_CHUNK_COUNT,
    };
    return true;
  }

  private async appendDelta(ops: RowDeltaOp[]): Promise<void> {
    const count = metaChunkCount(await this.storage.get(DELTA_META_KEY));
    await this.storage.put(deltaChunkKey(count), ops);
    await this.storage.put(DELTA_META_KEY, { chunks: count + 1, anchors: 0, bytes: 0 });
    const cache = this.probeCache;
    if (cache !== null) cache.deltaOps += ops.length;
  }

  private async readDeltaOps(): Promise<RowDeltaOp[]> {
    return this.readDeltaOpsFrom(await this.storage.get(DELTA_META_KEY));
  }

  private async readDeltaOpsFrom(value: unknown, phases?: PhaseTimer): Promise<RowDeltaOp[]> {
    const count = metaChunkCount(value);
    phases?.count("deltaChunks", count);
    const ops: RowDeltaOp[] = [];
    for (let i = 0; i < count; i += 1) {
      phases?.start("deltaChunkGet");
      const chunk = await this.storage.get(deltaChunkKey(i));
      phases?.end("deltaChunkGet");
      if (!Array.isArray(chunk)) continue;
      for (const item of chunk) {
        if (!isDeltaOp(item)) continue;
        ops.push(item);
      }
    }
    return ops;
  }

  private async readMeta(): Promise<KeywordMeta | null> {
    return parseKeywordMeta(await this.storage.get(KEYWORD_CACHE_META_KEY));
  }

  private async readAho(meta: KeywordMeta, phases?: PhaseTimer): Promise<Uint8Array> {
    const keys: string[] = [];
    for (let i = 0; i < meta.ahoChunks; i += 1) keys.push(ahoChunkKey(meta.ahoGen, i));
    const getStart = phases?.enabled === true ? performance.now() : 0;
    const values = await this.storage.get(keys);
    if (phases?.enabled === true) phases.add("ahoChunkGet", performance.now() - getStart);
    const parts: Uint8Array[] = [];
    for (const key of keys) {
      const part = asBytes(values.get(key));
      if (part === null) throw new TypeError("keyword automaton chunk was missing");
      parts.push(part);
    }
    if (parts.length === 1) {
      const only = parts[0] as Uint8Array;
      if (only.byteLength !== meta.ahoBytes) throw new TypeError("keyword automaton size mismatch");
      return only;
    }
    const bytes = new Uint8Array(meta.ahoBytes);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    if (at !== meta.ahoBytes) throw new TypeError("keyword automaton size mismatch");
    return bytes;
  }

  async upsertKeyword(input: KeywordWrite): Promise<KeywordWriteStatus> {
    const cache = await this.readyCache(false);
    await this.ensureChunksForAnchors(cache.table, [anchorOf(input.keyword)]);
    const sqlRow = readKeywordRow(this.storage.sql, input.scopeId, input.keyword);
    const existing = this.logicalKeyword(cache, input.scopeId, input.keyword, sqlRow);
    let status: KeywordWriteStatus = "written";
    let wrote: RowDeltaOp | null = null;
    this.storage.transactionSync(() => {
      if (existing !== null && isProtectedReply(existing.reply) && existing.author !== input.author) {
        status = "protected";
        return;
      }
      const anchor = anchorOf(input.keyword);
      const reply = existing !== null && input.plus ? `${input.reply}__${existing.reply}` : input.reply;
      if (sqlRow === null) {
        this.storage.sql.exec(
          "INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)",
          input.scopeId,
          input.author,
          input.keyword,
          reply,
          anchor,
        );
      } else {
        this.storage.sql.exec(
          "UPDATE user_keyword SET author = ?, reply = ?, anchor = ? WHERE _id = ?",
          input.author,
          reply,
          anchor,
          sqlRow.id,
        );
      }
      if (input.scopeId !== null) {
        this.storage.sql.exec(
          "INSERT INTO keywords_logs (_id, id, keyword, reply, create_on) VALUES (?, ?, ?, ?, ?)",
          crypto.randomUUID(),
          input.scopeId,
          input.keyword,
          input.reply,
          input.now,
        );
      }
      if (this.coldMode) {
        this.storage.sql.exec(
          "DELETE FROM keyword_tombstone WHERE id = ? AND keyword = ?",
          input.scopeId ?? "",
          input.keyword,
        );
      }
      wrote = { op: "put", id: input.scopeId ?? "", keyword: input.keyword, reply };
    });
    if (wrote !== null) await this.noteKeywordOps(cache, [wrote]);
    return status;
  }

  private async deleteStoredKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus> {
    const cache = await this.readyCache(false);
    await this.ensureChunksForAnchors(cache.table, [anchorOf(input.keyword)]);
    const sqlRow = readKeywordRow(this.storage.sql, input.scopeId, input.keyword);
    const existing = this.logicalKeyword(cache, input.scopeId, input.keyword, sqlRow);
    let status: KeywordDeleteStatus = "missing";
    let wrote: RowDeltaOp | null = null;
    this.storage.transactionSync(() => {
      if (existing === null) return;
      if (isProtectedReply(existing.reply) && existing.author !== input.author) {
        status = "protected";
        return;
      }
      if (sqlRow !== null) {
        this.storage.sql.exec("DELETE FROM user_keyword WHERE _id = ?", sqlRow.id);
      }
      status = "deleted";
      if (this.coldMode) {
        this.storage.sql.exec(
          "INSERT INTO keyword_tombstone (id, keyword) VALUES (?, ?) ON CONFLICT(id, keyword) DO NOTHING",
          input.scopeId ?? "",
          input.keyword,
        );
      }
      wrote = { op: "del", id: input.scopeId ?? "", keyword: input.keyword, reply: "" };
    });
    if (wrote !== null) await this.noteKeywordOps(cache, [wrote]);
    return status;
  }

  async getKeyword(input: KeywordLookup): Promise<string | null> {
    if (!this.coldMode) {
      return readKeywordRow(this.storage.sql, input.scopeId, input.keyword)?.reply ?? null;
    }
    const cache = await this.readyCache(false);
    await this.ensureChunksForAnchors(cache.table, [anchorOf(input.keyword)]);
    return findKeywordRow(cache.table, input.scopeId, input.keyword)?.reply ?? null;
  }

  async listKeywords(scopeId: string | null): Promise<string[]> {
    if (this.coldMode) {
      const cache = await this.readyCache(false);
      await this.ensureAllChunks(cache.table);
      return listKeywordTexts(cache.table, scopeId);
    }
    const scope = keywordScope(scopeId);
    return this.storage.sql
      .exec(`SELECT keyword FROM user_keyword WHERE ${scope.clause} ORDER BY _id`, ...scope.binds)
      .toArray()
      .map((row) => requiredText(asRecord(row), "keyword"));
  }

  async inspectKeywords(): Promise<KeywordSnapshot> {
    if (!this.coldMode) return readKeywords(this.storage.sql);
    const cache = await this.readyCache(false);
    await this.ensureAllChunks(cache.table);
    const keywords: StoredKeyword[] = [];
    visitKeywordRows(cache.table, (row) => {
      keywords.push({
        scopeId: row.id,
        author: row.author,
        keyword: row.keyword,
        reply: row.reply,
        anchor: row.anchor,
      });
    });
    return { keywords, logs: readKeywordLogs(this.storage.sql) };
  }

  async exportPage(table: ExportTable, after: number, limit: number): Promise<ExportPage> {
    const spec = EXPORT_SQL[table];
    const raw = this.storage.sql
      .exec(
        `SELECT rowid AS __row, ${spec.columns} FROM ${spec.from} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        after,
        limit,
      )
      .toArray();
    const rows = raw.map((row) => {
      const copy = { ...row };
      delete copy.__row;
      return copy;
    });
    const last = raw[raw.length - 1]?.__row;
    return { rows, next: raw.length === limit && typeof last === "number" ? last : null };
  }

  async userName(id: string): Promise<string | null> {
    const phases = this.phases();
    phases.start("hydrate");
    await this.cold.beforeUser(id);
    phases.end("hydrate");
    phases.start("sql");
    const row = this.storage.sql.exec("SELECT name FROM user WHERE id = ?", id).toArray()[0];
    phases.end("sql");
    phases.flush("userName");
    if (row === undefined) return null;
    return optionalText(asRecord(row), "name");
  }

  async setUserName(id: string, name: string): Promise<void> {
    await this.cold.beforeUser(id);
    if ((await this.userName(id)) === name) return;
    this.storage.sql.exec("UPDATE user SET name = ? WHERE id = ?", name, id);
  }

  async readGroupWeights(groupId: string): Promise<CountMap> {
    await this.cold.beforeGroup(groupId);
    const row = this.storage.sql.exec(`SELECT _count FROM "group" WHERE id = ?`, groupId).toArray()[0];
    if (row === undefined) return {};
    const raw = asRecord(row)._count;
    if (typeof raw !== "string") throw new TypeError("group._count was not text");
    return parseCountMap(raw);
  }

  async writeGroupWeight(groupId: string, key: string, value: number): Promise<void> {
    await this.cold.beforeGroup(groupId);
    this.storage.transactionSync(() => {
      const current = this.storage.sql.exec(`SELECT _count FROM "group" WHERE id = ?`, groupId).toArray()[0];
      if (current === undefined) return;
      const map = parseCountMap(requiredText(asRecord(current), "_count"));
      map[key] = value;
      this.storage.sql.exec(`UPDATE "group" SET _count = ? WHERE id = ?`, encodeCountMap(map), groupId);
    });
  }

  async listGroupUsers(groupId: string): Promise<GroupUserRow[]> {
    const pending = await this.cold.pendingBlob(groupId);
    const omit = this.cold.omitted(groupId);
    const stored = this.storage.sql
      .exec(
        `SELECT gu.uid AS uid, gu._count AS _count, u.name AS name
         FROM group_user gu LEFT JOIN user u ON u.id = gu.uid
         WHERE gu.gid = ? ORDER BY gu.uid`,
        groupId,
      )
      .toArray()
      .map((row) => {
        const record = asRecord(row);
        const raw = record._count;
        if (typeof raw !== "string") throw new TypeError("group_user._count was not text");
        const uid = record.uid;
        if (typeof uid !== "string") throw new TypeError("group_user.uid was not text");
        return { uid, name: optionalText(record, "name"), counts: parseCountMap(raw) };
      });
    if (pending === null) return stored;
    const seen = new Set(stored.map((row) => row.uid));
    for (const member of pending.users) {
      if (seen.has(member.uid) || omit.has(member.uid)) continue;
      stored.push({ uid: member.uid, name: member.name, counts: parseCountMap(member._count) });
    }
    stored.sort((left, right) => (left.uid < right.uid ? -1 : left.uid > right.uid ? 1 : 0));
    return stored;
  }

  async deleteGroupUsers(groupId: string, userId: string | null): Promise<void> {
    this.cold.noteDelete(groupId, userId);
    this.storage.transactionSync(() => {
      if (userId === null) {
        this.storage.sql.exec("DELETE FROM group_user WHERE gid = ?", groupId);
      } else {
        this.storage.sql.exec("DELETE FROM group_user WHERE gid = ? AND uid = ?", groupId, userId);
      }
      this.storage.sql.exec(
        "INSERT INTO group_user_tombstone (gid, uid) VALUES (?, ?) ON CONFLICT(gid, uid) DO NOTHING",
        groupId,
        userId ?? "",
      );
    });
  }

  async fixtureSlices(): Promise<FixtureSlices> {
    const keywords = this.storage.sql
      .exec("SELECT id, keyword, reply FROM user_keyword ORDER BY _id")
      .toArray()
      .map((row) => {
        const record = asRecord(row);
        return [
          optionalText(record, "id"),
          requiredText(record, "keyword"),
          requiredText(record, "reply"),
        ] as [string | null, string, string];
      });
    const settings = this.storage.sql
      .exec("SELECT group_id, user_id, options FROM user_settings ORDER BY group_id, user_id")
      .toArray()
      .map((row) => {
        const record = asRecord(row);
        return [
          requiredText(record, "group_id"),
          requiredText(record, "user_id"),
          requiredText(record, "options"),
        ] as [string, string, string];
      });
    const counts: Record<string, CountMap> = {};
    for (const row of this.storage.sql.exec("SELECT gid, uid, _count FROM group_user").toArray()) {
      const record = asRecord(row);
      const raw = record._count;
      if (typeof raw !== "string") throw new TypeError("group_user._count was not text");
      counts[`${requiredText(record, "gid")}\0${requiredText(record, "uid")}`] = parseCountMap(raw);
    }
    return { keywords, settings, counts };
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

export interface GroupUserRow {
  uid: string;
  name: string | null;
  counts: CountMap;
}

export interface FixtureSlices {
  keywords: Array<[string | null, string, string]>;
  settings: Array<[string, string, string]>;
  counts: Record<string, CountMap>;
}

function pythonDumps(value: SettingsPatch): string {
  const parts = Object.keys(value).map((key) => `${pyString(key)}: ${pyPrimitive(value[key] ?? null)}`);
  return `{${parts.join(", ")}}`;
}

function pyString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const ch = value[i] ?? "";
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (code < 32 || code > 126) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function pyPrimitive(value: string | number | boolean | null): string {
  if (typeof value === "string") return pyString(value);
  return JSON.stringify(value);
}

function writeOptions(
  sql: SqlStorage,
  key: SettingsKey,
  current: StoredOptions | null,
  next: SettingsPatch,
): void {
  if (Object.keys(next).length === 0) {
    if (current !== null) {
      sql.exec(
        "DELETE FROM user_settings WHERE group_id = ? AND user_id = ?",
        key.groupId,
        key.userId,
      );
    }
    return;
  }
  const encoded = pythonDumps(next);
  if (current === null) {
    sql.exec(
      "INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)",
      key.groupId,
      key.userId,
      encoded,
    );
    return;
  }
  if (current.raw === encoded) return;
  sql.exec(
    "UPDATE user_settings SET options = ? WHERE group_id = ? AND user_id = ?",
    encoded,
    key.groupId,
    key.userId,
  );
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
  meta: KeywordMeta | null;
  table: KeywordStore;
  pending: Set<string>;
  deltaOps: number;
  hitsMessage: string | null;
  hits: string[] | null;
}

interface KeywordMeta {
  version: 4;
  ahoGen: number;
  ahoChunks: number;
  ahoBytes: number;
  rowGen: number;
  rowChunks: number;
  rowBytes: number;
  rowCount: number;
  anchors: number;
  emptyAnchor: boolean;
  lengths: number[];
}

interface CompactJob {
  encode: ChunkEncodeJob;
  aho: AhoBuild | null;
  anchors: string[];
  phase: "load" | "encode" | "aho" | "store";
  loadAt: number;
  base: ChunkedKeywordTable | null;
  deltaBase: number;
  deltaOpsAtStart: number;
  deletedTo: number;
  ahoBytes: Uint8Array | null;
  ahoParts: Uint8Array[];
  ahoAt: number;
  rowAt: number;
  rowBytes: number;
  ahoGen: number;
  rowGen: number;
  oldMeta: KeywordMeta | null;
  flipped: boolean;
  oldDeletedTo: number;
}

export interface KeywordCompact {
  done: boolean;
  ms: number;
  phase: string;
}

export interface KeywordWriteSample {
  op: "put" | "delete";
  id: string;
  keyword: string;
  reply: string;
  cold: boolean;
}

export interface KeywordWriteMeasure {
  cpuMs: number;
  loadMs: number;
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

function splitChunks(bytes: Uint8Array, size: number): Uint8Array[] {
  if (bytes.byteLength === 0) return [bytes];
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += size) {
    chunks.push(bytes.slice(i, i + size));
  }
  return chunks;
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  return null;
}

function parseKeywordMeta(value: unknown): KeywordMeta | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== KEYWORD_CACHE_VERSION) return null;
  const numbers = ["ahoGen", "ahoChunks", "ahoBytes", "rowGen", "rowChunks", "rowBytes", "rowCount", "anchors"];
  for (const name of numbers) {
    const field = record[name];
    if (typeof field !== "number" || !Number.isInteger(field) || field < 0) return null;
  }
  if ((record.ahoChunks as number) < 1 || (record.rowChunks as number) < 1 || (record.rowChunks as number) > 256) {
    return null;
  }
  if (((record.rowChunks as number) & ((record.rowChunks as number) - 1)) !== 0) return null;
  const lengths = record.lengths;
  if (!Array.isArray(lengths) || lengths.some((length) => typeof length !== "number" || !Number.isInteger(length) || length < 1)) {
    return null;
  }
  return {
    version: KEYWORD_CACHE_VERSION,
    ahoGen: record.ahoGen as number,
    ahoChunks: record.ahoChunks as number,
    ahoBytes: record.ahoBytes as number,
    rowGen: record.rowGen as number,
    rowChunks: record.rowChunks as number,
    rowBytes: record.rowBytes as number,
    rowCount: record.rowCount as number,
    anchors: record.anchors as number,
    emptyAnchor: record.emptyAnchor === true,
    lengths: lengths as number[],
  };
}

function metaChunkCount(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 0;
  const chunks = (value as Record<string, unknown>).chunks;
  return typeof chunks === "number" && Number.isInteger(chunks) && chunks >= 0 ? chunks : 0;
}

function deltaChunkKey(index: number): string {
  return `keyword-row-delta-${index}`;
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

function probeHits(cache: ProbeCache, message: string): string[] {
  if (cache.hitsMessage === message && cache.hits !== null) return cache.hits;
  const hits = ahoHits(cache.machine, message);
  if (cache.pending.size === 0) {
    cache.hitsMessage = message;
    cache.hits = hits;
    return hits;
  }
  const seen = new Set(hits);
  for (const anchor of cache.pending) {
    if (anchor !== "" && !seen.has(anchor) && message.includes(anchor)) {
      seen.add(anchor);
      hits.push(anchor);
    }
  }
  cache.hitsMessage = message;
  cache.hits = hits;
  return hits;
}

function anchorUsed(sql: SqlStorage, anchor: string): boolean {
  return sql.exec("SELECT 1 AS n FROM user_keyword WHERE anchor = ? LIMIT 1", anchor).toArray()[0] !== undefined;
}

function anchorUsedByOther(sql: SqlStorage, anchor: string, id: string, keyword: string): boolean {
  return sql.exec(
    "SELECT 1 AS n FROM user_keyword WHERE anchor = ? AND NOT (id = ? AND keyword = ?) LIMIT 1",
    anchor,
    id,
    keyword,
  ).toArray()[0] !== undefined;
}

function isDeltaOp(value: unknown): value is RowDeltaOp {
  if (value === null || typeof value !== "object") return false;
  if (!("op" in value) || !("id" in value) || !("keyword" in value) || !("reply" in value)) return false;
  const op = value.op;
  const id = value.id;
  const keyword = value.keyword;
  const reply = value.reply;
  return (op === "put" || op === "del")
    && typeof id === "string"
    && typeof keyword === "string"
    && typeof reply === "string";
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
  return { id, keyword, reply, anchor, author: null };
}

function sqlRows(
  sql: SqlStorage,
  query: string,
  ...bindings: Array<string | number | null>
): Record<string, unknown>[] {
  return sql.exec(query, ...bindings).toArray().map(asRecord);
}

export interface TouchAndCount {
  source: CountSource;
  now: string;
  delta: CountMap;
}

export interface TouchRows {
  users: Array<{ id: string; name: string | null; createOn: string | null; updateOn: string | null }>;
  groups: Array<{ id: string; createOn: string | null; updateOn: string | null }>;
  counts: Record<string, CountMap>;
}

function writeTouch(sql: SqlStorage, input: TouchAndCount): void {
  const { source, now } = input;
  if (source.userId !== null) {
    sql.exec(
      "INSERT INTO user (id, name, create_on, update_on) VALUES (?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET update_on = excluded.update_on",
      source.userId,
      now,
      now,
    );
  }
  if (source.groupId === null) return;
  sql.exec(
    `INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on) VALUES (?, ?, '{}', '{}', '{}', ?, ?) ON CONFLICT(id) DO UPDATE SET update_on = excluded.update_on`,
    source.groupId,
    crypto.randomUUID(),
    now,
    now,
  );
  const uid = source.userId ?? "";
  const next = encodeCountMap(mergeCounts(readCount(sql, source.groupId, uid), input.delta));
  sql.exec(
    "INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, '{}') ON CONFLICT(gid, uid) DO UPDATE SET _count = excluded._count",
    source.groupId,
    uid,
    next,
  );
  sql.exec(
    "DELETE FROM group_user_tombstone WHERE gid = ? AND (uid = ? OR uid = '')",
    source.groupId,
    uid,
  );
}

function readCount(sql: SqlStorage, gid: string, uid: string): CountMap {
  const row = sql.exec("SELECT _count FROM group_user WHERE gid = ? AND uid = ?", gid, uid).toArray()[0];
  if (row === undefined) return {};
  const raw = asRecord(row)._count;
  if (typeof raw !== "string") throw new TypeError("group_user._count was not text");
  return parseCountMap(raw);
}

function readTouch(sql: SqlStorage): TouchRows {
  const users = sql.exec("SELECT id, name, create_on, update_on FROM user ORDER BY id").toArray().map((row) => {
    const record = asRecord(row);
    return {
      id: requiredText(record, "id"),
      name: optionalText(record, "name"),
      createOn: optionalText(record, "create_on"),
      updateOn: optionalText(record, "update_on"),
    };
  });
  const groups = sql.exec(`SELECT id, create_on, update_on FROM "group" ORDER BY id`).toArray().map((row) => {
    const record = asRecord(row);
    return {
      id: requiredText(record, "id"),
      createOn: optionalText(record, "create_on"),
      updateOn: optionalText(record, "update_on"),
    };
  });
  const counts: Record<string, CountMap> = {};
  for (const row of sql.exec("SELECT gid, uid, _count FROM group_user ORDER BY gid, uid").toArray()) {
    const record = asRecord(row);
    const raw = record._count;
    if (typeof raw !== "string") throw new TypeError("group_user._count was not text");
    counts[`${requiredText(record, "gid")}\0${requiredText(record, "uid")}`] = parseCountMap(raw);
  }
  return { users, groups, counts };
}

function requiredText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`${key} was not text`);
  return value;
}

function optionalText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${key} was not text`);
  return value;
}
export interface KeywordWrite {
  scopeId: string | null;
  author: string | null;
  keyword: string;
  reply: string;
  plus: boolean;
  now: string;
}

export interface KeywordDelete {
  scopeId: string | null;
  author: string | null;
  keyword: string;
}

export interface KeywordLookup {
  scopeId: string | null;
  keyword: string;
}

export type KeywordWriteStatus = "written" | "protected";
export type KeywordDeleteStatus = "deleted" | "missing" | "protected";

export interface StoredKeyword {
  scopeId: string | null;
  author: string | null;
  keyword: string;
  reply: string;
  anchor: string;
}

export interface StoredKeywordLog {
  scopeId: string | null;
  keyword: string | null;
  reply: string | null;
  createOn: string | null;
}

export interface KeywordSnapshot {
  keywords: StoredKeyword[];
  logs: StoredKeywordLog[];
}

export function isProtectedReply(reply: string): boolean {
  const at = reply.lastIndexOf("##");
  return at >= 0 && reply.slice(at).includes("保護");
}

export function parseKeywordWrite(value: unknown): KeywordWrite {
  const record = objectRecord(value, "keyword write");
  return {
    scopeId: optionalId(record.scopeId, "scopeId"),
    author: optionalId(record.author, "author"),
    keyword: requiredString(record.keyword, "keyword"),
    reply: requiredString(record.reply, "reply"),
    plus: requiredBoolean(record.plus),
    now: requiredNow(record.now),
  };
}

export function parseKeywordDelete(value: unknown): KeywordDelete {
  const record = objectRecord(value, "keyword delete");
  return {
    scopeId: optionalId(record.scopeId, "scopeId"),
    author: optionalId(record.author, "author"),
    keyword: requiredString(record.keyword, "keyword"),
  };
}

export function parseKeywordLookup(value: unknown): KeywordLookup {
  const record = objectRecord(value, "keyword lookup");
  return {
    scopeId: optionalId(record.scopeId, "scopeId"),
    keyword: requiredString(record.keyword, "keyword"),
  };
}

export function parseScopeId(value: unknown): string | null {
  return optionalId(value, "scopeId");
}

interface KeywordExisting {
  id: number;
  author: string | null;
  reply: string;
}

function keywordScope(scopeId: string | null): { clause: string; binds: string[] } {
  if (scopeId === null) return { clause: "id IS NULL", binds: [] };
  return { clause: "id = ?", binds: [scopeId] };
}

function readKeywordRow(sql: SqlStorage, scopeId: string | null, keyword: string): KeywordExisting | null {
  const scope = keywordScope(scopeId);
  const row = sql
    .exec(
      `SELECT _id, author, reply FROM user_keyword WHERE ${scope.clause} AND keyword = ? ORDER BY _id LIMIT 1`,
      ...scope.binds,
      keyword,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const record = asRecord(row);
  const id = record._id;
  if (typeof id !== "number") throw new TypeError("user_keyword._id was not a number");
  return { id, author: optionalText(record, "author"), reply: requiredText(record, "reply") };
}

function readKeywords(sql: SqlStorage): KeywordSnapshot {
  const keywords = sql
    .exec("SELECT id, author, keyword, reply, anchor FROM user_keyword ORDER BY _id")
    .toArray()
    .map((row) => {
      const record = asRecord(row);
      return {
        scopeId: optionalText(record, "id"),
        author: optionalText(record, "author"),
        keyword: requiredText(record, "keyword"),
        reply: requiredText(record, "reply"),
        anchor: requiredText(record, "anchor"),
      };
    });
  return { keywords, logs: readKeywordLogs(sql) };
}

function readKeywordLogs(sql: SqlStorage): StoredKeywordLog[] {
  return sql
    .exec("SELECT id, keyword, reply, create_on FROM keywords_logs ORDER BY rowid")
    .toArray()
    .map((row) => {
      const record = asRecord(row);
      return {
        scopeId: optionalText(record, "id"),
        keyword: optionalText(record, "keyword"),
        reply: optionalText(record, "reply"),
        createOn: optionalText(record, "create_on"),
      };
    });
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalId(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string or null`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("plus must be a boolean");
  return value;
}

function requiredNow(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("now must be a non-empty string");
  }
  return value;
}
