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
import { BLOB_CHUNK_BYTES } from "./blob-store";
import {
  applyOverlayOp,
  applyRowDelta,
  decodeKeywordTable,
  deleteKeywordRow,
  emptyKeywordTable,
  findKeywordRow,
  listKeywordTexts,
  rowsForHits,
  snapshotRows,
  startEncodeJob,
  stepEncodeJob,
  upsertKeywordRow,
  visitKeywordRows,
  type EncodeJob,
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
};

const CACHE_META_KEY = "keyword-probe-cache-meta";
const ROW_META_KEY = "keyword-row-cache-meta";
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

  constructor(private readonly storage: DurableObjectStorage, hydrate = false) {
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

  async migrate(): Promise<void> {
    this.storage.transactionSync(() => {
      migrateSql(this.storage.sql);
    });
  }

  async getSettings(key: SettingsKey): Promise<SettingsView> {
    await this.cold.beforeSettings(key);
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
    await this.cold.beforeTouch(input.source.groupId, input.source.userId);
    this.storage.transactionSync(() => {
      writeTouch(this.storage.sql, input);
    });
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
    if (job.phase === "encode") {
      const done = stepEncodeJob(job.encode, COMPACT_BUDGET_MS);
      if (done) {
        job.anchors = job.encode.groups.map((group) => group.anchor).filter((anchor) => anchor !== "");
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
    return { done: false, ms: performance.now() - started, phase: job.phase };
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
    const message = normalizeKeywordMessage(query.message, query.stripName);
    if (message === "") return [];
    const cache = await this.readyCache(false);
    return this.rowsFor(message, query, probeHits(cache, message));
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
      const raw = await this.readRawCache();
      const rowRaw = await this.readRawRows();
      const delta = await this.readDeltaOps();
      const decodeStart = performance.now();
      this.installCache(raw, rowRaw, delta);
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
      const raw = await this.readRawCache();
      const rowRaw = await this.readRawRows();
      const delta = await this.readDeltaOps();
      const decodeStart = performance.now();
      this.installCache(raw, rowRaw, delta);
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
    const rows = this.rowsFor(message, query, hits);
    const selected = selectFromRows(rows, query);
    return { replies: selected.replies, candidates: rows.length };
  }

  async auditKeywordSelect(query: KeywordSelect): Promise<KeywordAudit> {
    const message = normalizeKeywordMessage(query.message, query.stripName);
    const cache = await this.readyCache(false);
    const hits = message === "" ? [] : probeHits(cache, message);
    const memory = message === "" ? [] : rowsForHits(cache.table, message, query, hits);
    const sql = message === "" ? [] : rowsForSelect(this.storage.sql, message, query, hits);
    return {
      memory: memory.map(rowTag),
      sql: sql.map(rowTag),
      replies: selectKeywordRepliesOpen(memory, query).replies,
      sqlReplies: selectKeywordRepliesOpen(sql, query).replies,
    };
  }

  private rowsFor(message: string, query: KeywordSelect, hits: readonly string[]): KeywordRow[] {
    this.rowsRead = 0;
    return rowsForHits(this.probeCache?.table ?? emptyKeywordTable(), message, query, hits);
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
    const raw = await this.readRawCache();
    const rowRaw = await this.readRawRows();
    const delta = await this.readDeltaOps();
    return this.installCache(raw, rowRaw, delta);
  }

  private installCache(
    raw: RawProbeCache | null,
    rowRaw: RawProbeCache | null,
    delta: readonly RowDeltaOp[],
  ): ProbeCache {
    const machine = raw === null ? buildAho([]) : decodeAho(raw.bytes);
    const base = rowRaw === null ? null : decodeKeywordTable(rowRaw.bytes);
    let table: KeywordStore;
    const pending = new Set<string>();
    if (base === null) {
      const loaded = loadKeywordTable(this.storage.sql);
      table = loaded;
      if (raw === null) {
        for (const row of loaded.rows) {
          if (row !== null && row.anchor !== "") pending.add(row.anchor);
        }
      }
    } else if (delta.length === 0) {
      table = base;
    } else {
      table = applyRowDelta(base, delta);
      for (const op of delta) {
        if (op.op === "put") {
          const anchor = anchorOf(op.keyword);
          if (anchor !== "") pending.add(anchor);
        }
      }
    }
    this.probeCache = { machine, anchors: null, table, pending, deltaOps: delta.length };
    return this.probeCache;
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
    return {
      encode: startEncodeJob(cache.table),
      aho: null,
      anchors: [],
      phase: "encode",
      storeAt: 0,
      storedRows: false,
      deltaBase: metaChunkCount(await this.storage.get(DELTA_META_KEY)),
      deltaOpsAtStart: cache.deltaOps,
      deletedTo: 0,
      ahoBytes: null as Uint8Array | null,
      commitAt: 0,
      rowDeletedTo: 0,
      flipped: false,
      oldAhoGen: 0,
      oldAhoChunks: 0,
      oldRowGen: 0,
      oldRowChunks: 0,
    };
  }

  private async storeCompactSlice(cache: ProbeCache, job: CompactJob, budgetMs: number): Promise<boolean> {
    const started = performance.now();
    const bytes = job.encode.bytes;
    const machine = job.aho?.machine ?? null;
    if (bytes === null || machine === null) throw new Error("compact store started early");
    const rowMeta = parseMeta(await this.storage.get(ROW_META_KEY));
    const nextGen = (rowMeta?.gen ?? 0) + 1;
    if (!job.storedRows) {
      const index = Math.floor(job.storeAt / this.rowSliceBytes);
      const end = Math.min(bytes.byteLength, job.storeAt + this.rowSliceBytes);
      const slice = bytes.slice(job.storeAt, end);
      await this.storage.put(rowChunkKey(nextGen, index), slice.buffer);
      job.storeAt = end;
      if (job.storeAt < bytes.byteLength) return false;
      job.storedRows = true;
      job.storeAt = 0;
    }
    if (job.deletedTo < job.deltaBase) {
      const end = Math.min(job.deltaBase, job.deletedTo + 2);
      for (let i = job.deletedTo; i < end; i += 1) await this.storage.delete(deltaChunkKey(i));
      job.deletedTo = end;
      if (job.deletedTo < job.deltaBase || performance.now() - started >= budgetMs) return false;
    }
    if (job.ahoBytes === null) {
      job.ahoBytes = encodeAho(machine);
      return false;
    }
    const encoded = job.ahoBytes;
    const ahoMeta = parseMeta(await this.storage.get(CACHE_META_KEY));
    const ahoGen = (ahoMeta?.gen ?? 0) + 1;
    const ahoParts = splitChunks(encoded, this.rowSliceBytes);
    if (!job.flipped && job.commitAt < ahoParts.length) {
      const chunk = ahoParts[job.commitAt] ?? new Uint8Array();
      await this.storage.put(chunkKey(ahoGen, job.commitAt), chunk.buffer);
      job.commitAt += 1;
      return false;
    }
    const rowChunks = Math.ceil(bytes.byteLength / this.rowSliceBytes);
    if (!job.flipped) {
      job.oldAhoGen = ahoMeta?.gen ?? 0;
      job.oldAhoChunks = ahoMeta?.chunks ?? 0;
      job.oldRowGen = rowMeta?.gen ?? 0;
      job.oldRowChunks = rowMeta?.chunks ?? 0;
      await this.storage.put(CACHE_META_KEY, {
        chunks: ahoParts.length,
        anchors: job.anchors.length,
        bytes: encoded.byteLength,
        gen: ahoGen,
      });
      await this.storage.put(ROW_META_KEY, {
        chunks: rowChunks,
        anchors: 0,
        bytes: bytes.byteLength,
        gen: nextGen,
      });
      job.flipped = true;
      cache.deltaOps = Math.max(0, cache.deltaOps - job.deltaOpsAtStart);
      return false;
    }
    if (job.rowDeletedTo < job.oldAhoChunks + job.oldRowChunks) {
      const index = job.rowDeletedTo;
      if (index < job.oldAhoChunks) await this.storage.delete(chunkKey(job.oldAhoGen, index));
      else await this.storage.delete(rowChunkKey(job.oldRowGen, index - job.oldAhoChunks));
      job.rowDeletedTo += 1;
      return false;
    }
    const built = new Set(job.anchors);
    for (const anchor of cache.pending) {
      if (built.has(anchor)) cache.pending.delete(anchor);
    }
    if (cache.table.kind !== "map") cache.table = decodeKeywordTable(bytes);
    this.cacheStats = {
      buildMs: this.cacheStats.buildMs,
      bytes: encoded.byteLength,
      chunks: ahoParts.length,
      anchors: job.anchors.length,
      rowBytes: bytes.byteLength,
      rowChunks: rowChunks,
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
    const count = metaChunkCount(await this.storage.get(DELTA_META_KEY));
    const ops: RowDeltaOp[] = [];
    for (let i = 0; i < count; i += 1) {
      const value = await this.storage.get(deltaChunkKey(i));
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!isDeltaOp(item)) continue;
        ops.push(item);
      }
    }
    return ops;
  }

  private async readRawCache(): Promise<RawProbeCache | null> {
    const meta = parseMeta(await this.storage.get(CACHE_META_KEY));
    if (meta === null) return null;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < meta.chunks; i += 1) {
      const part = asBytes(await this.storage.get(chunkKey(meta.gen, i)));
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
      const part = asBytes(await this.storage.get(rowChunkKey(meta.gen, i)));
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

  async upsertKeyword(input: KeywordWrite): Promise<KeywordWriteStatus> {
    const cache = await this.readyCache(false);
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
    return findKeywordRow(cache.table, input.scopeId, input.keyword)?.reply ?? null;
  }

  async listKeywords(scopeId: string | null): Promise<string[]> {
    if (this.coldMode) {
      const cache = await this.readyCache(false);
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
    await this.cold.beforeUser(id);
    const row = this.storage.sql.exec("SELECT name FROM user WHERE id = ?", id).toArray()[0];
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
    if (userId === null) {
      this.storage.sql.exec("DELETE FROM group_user WHERE gid = ?", groupId);
      return;
    }
    this.storage.sql.exec("DELETE FROM group_user WHERE gid = ? AND uid = ?", groupId, userId);
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
  anchors: Set<string> | null;
  table: KeywordStore;
  pending: Set<string>;
  deltaOps: number;
}

interface CompactJob {
  encode: EncodeJob;
  aho: AhoBuild | null;
  anchors: string[];
  phase: "encode" | "aho" | "store";
  storeAt: number;
  storedRows: boolean;
  deltaBase: number;
  deltaOpsAtStart: number;
  deletedTo: number;
  ahoBytes: Uint8Array | null;
  commitAt: number;
  rowDeletedTo: number;
  flipped: boolean;
  oldAhoGen: number;
  oldAhoChunks: number;
  oldRowGen: number;
  oldRowChunks: number;
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

function parseMeta(value: unknown): { chunks: number; anchors: number; bytes: number; gen: number } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("chunks" in value) || !("anchors" in value) || !("bytes" in value)) return null;
  const chunks = value.chunks;
  const anchors = value.anchors;
  const bytes = value.bytes;
  if (typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 0) return null;
  if (typeof anchors !== "number" || !Number.isInteger(anchors) || anchors < 0) return null;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) return null;
  const gen = "gen" in value && typeof value.gen === "number" && Number.isInteger(value.gen) && value.gen >= 0
    ? value.gen
    : 0;
  return { chunks, anchors, bytes, gen };
}

function metaChunkCount(value: unknown): number {
  return parseMeta(value)?.chunks ?? 0;
}

function chunkKey(gen: number, index: number): string {
  return `keyword-probe-cache-${gen}-${index}`;
}

function rowChunkKey(gen: number, index: number): string {
  return `keyword-row-cache-${gen}-${index}`;
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
  const hits = ahoHits(cache.machine, message);
  if (cache.pending.size === 0) return hits;
  const seen = new Set(hits);
  for (const anchor of cache.pending) {
    if (anchor !== "" && !seen.has(anchor) && message.includes(anchor)) {
      seen.add(anchor);
      hits.push(anchor);
    }
  }
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
