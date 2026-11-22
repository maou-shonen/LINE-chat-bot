import { anchorOf, type KeywordRow, type KeywordSelect } from "./keywords";

export interface KeywordTable {
  kind: "map";
  rows: Array<KeywordRow | null>;
  byAnchor: Map<string, number[]>;
  byKeyword: Map<string, number[]>;
  byId: Map<string, Map<string, number>>;
}

export interface StoredKeywordTable {
  kind: "stored";
  groups: Uint32Array;
  groupCount: number;
  keywords: Uint32Array;
  keywordCount: number;
  rowMeta: Uint32Array;
  rowCount: number;
  pool: Uint32Array;
  units: Uint16Array;
}

export interface RowDeltaOp {
  op: "put" | "del";
  id: string;
  keyword: string;
  reply: string;
}

export interface OverlayKeywordTable {
  kind: "overlay";
  base: StoredKeywordTable;
  deleted: Set<number>;
  replaced: Map<number, KeywordRow>;
  appended: Array<KeywordRow | null>;
  keyIndex: Map<string, number>;
}

export type KeywordStore = KeywordTable | StoredKeywordTable | OverlayKeywordTable;

export function emptyKeywordTable(): KeywordTable {
  return { kind: "map", rows: [], byAnchor: new Map(), byKeyword: new Map(), byId: new Map() };
}

export function upsertKeywordRow(
  table: KeywordTable,
  row: { id: string | null; keyword: string; reply: string; author?: string | null },
): void {
  const anchor = anchorOf(row.keyword);
  const stored: KeywordRow = {
    id: row.id,
    keyword: row.keyword,
    reply: row.reply,
    anchor,
    author: row.author ?? null,
  };
  const bucket = idBucket(table, row.id ?? "");
  const index = bucket.get(row.keyword);
  if (index === undefined) {
    const at = table.rows.length;
    table.rows.push(stored);
    bucket.set(row.keyword, at);
    pushIndex(table.byKeyword, row.keyword, at);
    pushIndex(table.byAnchor, anchor, at);
    return;
  }
  table.rows[index] = stored;
}

export function deleteKeywordRow(table: KeywordTable, id: string, keyword: string): void {
  const bucket = table.byId.get(id);
  const index = bucket?.get(keyword);
  if (bucket === undefined || index === undefined) return;
  const row = table.rows[index];
  table.rows[index] = null;
  bucket.delete(keyword);
  if (row === null || row === undefined) return;
  removeIndex(table.byKeyword, row.keyword, index);
  removeIndex(table.byAnchor, row.anchor, index);
}

export function rowsForHits(
  table: KeywordStore,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordRow[] {
  if (table.kind === "stored") return storedRows(table, message, query, hits);
  if (table.kind === "overlay") return overlayRows(table, message, query, hits);
  if (message !== "" && !query.allReply) {
    for (const index of lists(table.byKeyword, message)) {
      const row = table.rows[index];
      if (row == null || !rowPasses(row, query)) continue;
      return [row];
    }
  }
  if (hits.length === 0) return [];
  const found: number[] = [];
  for (const hit of hits) {
    for (const index of lists(table.byAnchor, hit)) found.push(index);
  }
  found.sort((left, right) => left - right);
  const rows: KeywordRow[] = [];
  for (const index of found) {
    const row = table.rows[index];
    if (row == null || (query.scopeId !== null && row.id !== query.scopeId)) continue;
    rows.push(row);
  }
  return rows;
}

export function materializeKeywordTable(table: StoredKeywordTable): KeywordTable {
  const map = emptyKeywordTable();
  for (let i = 0; i < table.rowCount; i += 1) {
    const row = readStoredRow(table, i);
    upsertKeywordRow(map, row);
  }
  return map;
}

export function listKeywordTexts(table: KeywordStore, scopeId: string | null): string[] {
  const wanted = scopeId ?? "";
  const out: string[] = [];
  if (table.kind === "map") {
    for (const row of table.rows) {
      if (row !== null && (row.id ?? "") === wanted) out.push(row.keyword);
    }
    return out;
  }
  if (table.kind === "stored") {
    for (let i = 0; i < table.rowCount; i += 1) {
      if (storedIdIs(table, i, wanted)) out.push(storedField(table, i, 2));
    }
    return out;
  }
  for (let i = 0; i < table.base.rowCount; i += 1) {
    if (table.deleted.has(i)) continue;
    const replaced = table.replaced.get(i);
    if (replaced !== undefined) {
      if ((replaced.id ?? "") === wanted) out.push(replaced.keyword);
      continue;
    }
    if (storedIdIs(table.base, i, wanted)) out.push(storedField(table.base, i, 2));
  }
  for (const row of table.appended) {
    if (row !== null && (row.id ?? "") === wanted) out.push(row.keyword);
  }
  return out;
}

export function visitKeywordRows(table: KeywordStore, visit: (row: KeywordRow) => void): void {
  if (table.kind === "map") {
    for (const row of table.rows) {
      if (row !== null) visit(row);
    }
    return;
  }
  if (table.kind === "stored") {
    for (let i = 0; i < table.rowCount; i += 1) visit(readStoredRow(table, i));
    return;
  }
  const count = table.base.rowCount + table.appended.length;
  for (let i = 0; i < count; i += 1) {
    const row = readOverlayRow(table, i);
    if (row !== null) visit(row);
  }
}

function storedIdIs(table: StoredKeywordTable, index: number, id: string): boolean {
  const base = index * ROW_STRIDE;
  const len = table.rowMeta[base + 1] ?? 0;
  if (len === NULL_ID) return id === "";
  if (len !== id.length) return false;
  return sameText(table.units, table.rowMeta[base] ?? 0, len, id);
}

function storedField(table: StoredKeywordTable, index: number, slot: number): string {
  const base = index * ROW_STRIDE;
  return sliceText(table.units, table.rowMeta[base + slot] ?? 0, table.rowMeta[base + slot + 1] ?? 0);
}

export function findKeywordRow(
  table: KeywordStore,
  scopeId: string | null,
  keyword: string,
): KeywordRow | null {
  if (table.kind === "map") {
    const index = table.byId.get(scopeId ?? "")?.get(keyword);
    return index === undefined ? null : table.rows[index] ?? null;
  }
  if (table.kind === "stored") {
    const index = findBaseRow(table, scopeId ?? "", keyword);
    return index === null ? null : readStoredRow(table, index);
  }
  const known = table.keyIndex.get(`${scopeId ?? ""}\0${keyword}`);
  if (known !== undefined) return readOverlayRow(table, known);
  const index = findBaseRow(table.base, scopeId ?? "", keyword);
  if (index === null || table.deleted.has(index)) return null;
  return table.replaced.get(index) ?? readStoredRow(table.base, index);
}

export function encodeKeywordTable(table: KeywordTable): Uint8Array {
  const live: KeywordRow[] = [];
  for (const row of table.rows) {
    if (row !== null) live.push(row);
  }
  const grouped = new Map<string, number[]>();
  for (let i = 0; i < live.length; i += 1) {
    const anchor = live[i]?.anchor ?? "";
    const list = grouped.get(anchor);
    if (list === undefined) grouped.set(anchor, [i]);
    else list.push(i);
  }
  const groups = [...grouped.entries()].map(([anchor, rows]) => ({
    anchor,
    hash: hashText(anchor),
    rows,
  }));
  groups.sort((left, right) => cmpHash(left.hash, right.hash) || cmpText(left.anchor, right.anchor));
  const keywords = live.map((row, index) => ({ hash: hashText(row.keyword), index }));
  keywords.sort((left, right) => cmpHash(left.hash, right.hash) || left.index - right.index);

  let chars = 0;
  for (const row of live) chars += (row.id?.length ?? 0) + row.keyword.length + row.reply.length + (row.author?.length ?? 0);
  const poolCount = live.length;
  const header = 20;
  const groupBytes = groups.length * GROUP_STRIDE * 4;
  const keywordBytes = live.length * 8;
  const poolBytes = poolCount * 4;
  const rowBytes = live.length * ROW_STRIDE * 4;
  const bytes = new Uint8Array(header + groupBytes + keywordBytes + poolBytes + rowBytes + chars * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 3, true);
  view.setUint32(4, groups.length, true);
  view.setUint32(8, live.length, true);
  view.setUint32(12, poolCount, true);
  view.setUint32(16, chars, true);
  let cursor = header;
  let poolAt = 0;
  const poolStart = header + groupBytes + keywordBytes;
  for (const group of groups) {
    view.setUint32(cursor, group.hash, true);
    view.setUint32(cursor + 8, group.anchor.length, true);
    view.setUint32(cursor + 12, poolAt, true);
    view.setUint32(cursor + 16, poolAt + group.rows.length, true);
    cursor += GROUP_STRIDE * 4;
    for (const index of group.rows) {
      view.setUint32(poolStart + poolAt * 4, index, true);
      poolAt += 1;
    }
  }
  cursor = header + groupBytes;
  for (const item of keywords) {
    view.setUint32(cursor, item.hash, true);
    view.setUint32(cursor + 4, item.index, true);
    cursor += 8;
  }
  const units = new Uint16Array(bytes.buffer, header + groupBytes + keywordBytes + poolBytes + rowBytes, chars);
  let at = 0;
  const anchorAt = new Map<string, number>();
  const rowStart = header + groupBytes + keywordBytes + poolBytes;
  for (let i = 0; i < live.length; i += 1) {
    const row = live[i] as KeywordRow;
    const id = row.id ?? "";
    view.setUint32(rowStart + i * ROW_STRIDE * 4, at, true);
    view.setUint32(rowStart + i * ROW_STRIDE * 4 + 4, row.id === null ? NULL_ID : id.length, true);
    at = writeUnits(units, at, id);
    const keywordAt = at;
    view.setUint32(rowStart + i * ROW_STRIDE * 4 + 8, at, true);
    view.setUint32(rowStart + i * ROW_STRIDE * 4 + 12, row.keyword.length, true);
    at = writeUnits(units, at, row.keyword);
    if (!anchorAt.has(row.anchor)) anchorAt.set(row.anchor, keywordAt + row.keyword.indexOf(row.anchor));
    view.setUint32(rowStart + i * ROW_STRIDE * 4 + 16, at, true);
    view.setUint32(rowStart + i * ROW_STRIDE * 4 + 20, row.reply.length, true);
    at = writeUnits(units, at, row.reply);
    view.setUint32(rowStart + i * ROW_STRIDE * 4 + 24, at, true);
    view.setUint32(rowStart + i * ROW_STRIDE * 4 + 28, row.author === null ? NULL_ID : row.author.length, true);
    if (row.author !== null) at = writeUnits(units, at, row.author);
  }
  let groupCursor = header;
  for (const group of groups) {
    view.setUint32(groupCursor + 4, anchorAt.get(group.anchor) ?? 0, true);
    groupCursor += GROUP_STRIDE * 4;
  }
  return bytes;
}

export function decodeKeywordTable(bytes: Uint8Array): StoredKeywordTable {
  if (bytes.byteOffset % 4 !== 0) throw new TypeError("keyword row blob was misaligned");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 3) {
    throw new TypeError("keyword row blob was not version 3");
  }
  const groupCount = view.getUint32(4, true);
  const rowCount = view.getUint32(8, true);
  const poolCount = view.getUint32(12, true);
  const chars = view.getUint32(16, true);
  const header = 20;
  const groupBytes = groupCount * GROUP_STRIDE * 4;
  const keywordBytes = rowCount * 8;
  const poolBytes = poolCount * 4;
  const rowBytes = rowCount * ROW_STRIDE * 4;
  const need = header + groupBytes + keywordBytes + poolBytes + rowBytes + chars * 2;
  if (bytes.byteLength < need) throw new TypeError("keyword row blob was truncated");
  const base = bytes.byteOffset;
  return {
    kind: "stored",
    groups: new Uint32Array(bytes.buffer, base + header, groupCount * GROUP_STRIDE),
    groupCount,
    keywords: new Uint32Array(bytes.buffer, base + header + groupBytes, rowCount * 2),
    keywordCount: rowCount,
    pool: new Uint32Array(bytes.buffer, base + header + groupBytes + keywordBytes, poolCount),
    rowMeta: new Uint32Array(bytes.buffer, base + header + groupBytes + keywordBytes + poolBytes, rowCount * ROW_STRIDE),
    rowCount,
    units: new Uint16Array(bytes.buffer, base + header + groupBytes + keywordBytes + poolBytes + rowBytes, chars),
  };
}

const GROUP_STRIDE = 5;
const ROW_STRIDE = 8;
const NULL_ID = 0xffffffff;

function storedRows(
  table: StoredKeywordTable,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordRow[] {
  if (message !== "" && !query.allReply) {
    for (const index of keywordIndexes(table, message)) {
      const row = readStoredRow(table, index);
      if (!rowPasses(row, query)) continue;
      return [row];
    }
  }
  if (hits.length === 0) return [];
  const found: number[] = [];
  for (const hit of hits) {
    const group = findGroup(table, hit);
    if (group === null) continue;
    for (let i = group.begin; i < group.end; i += 1) found.push(table.pool[i] ?? 0);
  }
  found.sort((left, right) => left - right);
  const rows: KeywordRow[] = [];
  for (const index of found) {
    const row = readStoredRow(table, index);
    if (query.scopeId !== null && row.id !== query.scopeId) continue;
    rows.push(row);
  }
  return rows;
}

function rowPasses(row: KeywordRow, query: KeywordSelect): boolean {
  if (query.scopeId !== null && row.id !== query.scopeId) return false;
  const reply = row.reply.startsWith("@") ? row.reply.slice(1) : row.reply;
  return !(query.excludeUrl && reply.includes("https:"));
}

function findGroup(table: StoredKeywordTable, anchor: string): { begin: number; end: number } | null {
  const hash = hashText(anchor);
  let lo = 0;
  let hi = table.groupCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midHash = table.groups[mid * GROUP_STRIDE] ?? 0;
    if (midHash < hash) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < table.groupCount; i += 1) {
    const base = i * GROUP_STRIDE;
    const midHash = table.groups[base] ?? 0;
    if (midHash !== hash) break;
    const off = table.groups[base + 1] ?? 0;
    const len = table.groups[base + 2] ?? 0;
    if (sameText(table.units, off, len, anchor)) {
      return { begin: table.groups[base + 3] ?? 0, end: table.groups[base + 4] ?? 0 };
    }
  }
  return null;
}

function keywordIndexes(table: StoredKeywordTable, keyword: string): number[] {
  const hash = hashText(keyword);
  let lo = 0;
  let hi = table.keywordCount;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midHash = table.keywords[mid * 2] ?? 0;
    if (midHash < hash) lo = mid + 1;
    else hi = mid;
  }
  const found: number[] = [];
  for (let i = lo; i < table.keywordCount; i += 1) {
    const midHash = table.keywords[i * 2] ?? 0;
    if (midHash !== hash) break;
    const index = table.keywords[i * 2 + 1] ?? 0;
    const kwOff = table.rowMeta[index * ROW_STRIDE + 2] ?? 0;
    const kwLen = table.rowMeta[index * ROW_STRIDE + 3] ?? 0;
    if (sameText(table.units, kwOff, kwLen, keyword)) found.push(index);
  }
  found.sort((left, right) => left - right);
  return found;
}

function readStoredRow(table: StoredKeywordTable, index: number): KeywordRow {
  const base = index * ROW_STRIDE;
  const idOff = table.rowMeta[base] ?? 0;
  const idLen = table.rowMeta[base + 1] ?? 0;
  const kwOff = table.rowMeta[base + 2] ?? 0;
  const kwLen = table.rowMeta[base + 3] ?? 0;
  const replyOff = table.rowMeta[base + 4] ?? 0;
  const replyLen = table.rowMeta[base + 5] ?? 0;
  const authorOff = table.rowMeta[base + 6] ?? 0;
  const authorLen = table.rowMeta[base + 7] ?? 0;
  const id = idLen === NULL_ID ? null : sliceText(table.units, idOff, idLen);
  const keyword = sliceText(table.units, kwOff, kwLen);
  return {
    id,
    keyword,
    reply: sliceText(table.units, replyOff, replyLen),
    anchor: anchorOf(keyword),
    author: authorLen === NULL_ID ? null : sliceText(table.units, authorOff, authorLen),
  };
}

function idBucket(table: KeywordTable, id: string): Map<string, number> {
  let bucket = table.byId.get(id);
  if (bucket === undefined) {
    bucket = new Map();
    table.byId.set(id, bucket);
  }
  return bucket;
}

function pushIndex(index: Map<string, number[]>, key: string, at: number): void {
  const list = index.get(key);
  if (list === undefined) index.set(key, [at]);
  else list.push(at);
}

function removeIndex(index: Map<string, number[]>, key: string, at: number): void {
  const list = index.get(key);
  if (list === undefined) return;
  const found = list.indexOf(at);
  if (found !== -1) list.splice(found, 1);
  if (list.length === 0) index.delete(key);
}

function lists(index: Map<string, number[]>, key: string): readonly number[] {
  return index.get(key) ?? [];
}

export function applyRowDelta(base: StoredKeywordTable, ops: readonly RowDeltaOp[]): OverlayKeywordTable {
  const table = emptyOverlay(base);
  for (const op of ops) applyOverlayOp(table, op);
  return table;
}

export function applyOverlayOp(table: OverlayKeywordTable, op: RowDeltaOp): void {
  const key = `${op.id}\0${op.keyword}`;
  const known = table.keyIndex.get(key);
  const index = known ?? findBaseRow(table.base, op.id, op.keyword);
  if (op.op === "del") {
    if (index === null) return;
    table.deleted.add(index);
    table.replaced.delete(index);
    if (index >= table.base.rowCount) table.appended[index - table.base.rowCount] = null;
    table.keyIndex.delete(key);
    return;
  }
  const row: KeywordRow = {
    id: op.id,
    keyword: op.keyword,
    reply: op.reply,
    anchor: anchorOf(op.keyword),
    author: index !== null && index < table.base.rowCount ? readStoredRow(table.base, index).author : null,
  };
  if (index === null) {
    const at = table.base.rowCount + table.appended.length;
    table.appended.push(row);
    table.keyIndex.set(key, at);
    return;
  }
  table.deleted.delete(index);
  table.keyIndex.set(key, index);
  if (index >= table.base.rowCount) table.appended[index - table.base.rowCount] = row;
  else table.replaced.set(index, row);
}

export function snapshotRows(table: KeywordStore): KeywordRow[] {
  if (table.kind === "map") {
    const rows: KeywordRow[] = [];
    for (const row of table.rows) {
      if (row !== null) rows.push(row);
    }
    return rows;
  }
  if (table.kind === "stored") return storedSnapshot(table);
  const rows: KeywordRow[] = [];
  const count = table.base.rowCount + table.appended.length;
  for (let i = 0; i < count; i += 1) {
    const row = readOverlayRow(table, i);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function storedSnapshot(table: StoredKeywordTable): KeywordRow[] {
  const rows: KeywordRow[] = [];
  for (let i = 0; i < table.rowCount; i += 1) rows.push(readStoredRow(table, i));
  return rows;
}

export function emptyStoredKeywordTable(): StoredKeywordTable {
  return decodeKeywordTable(encodeKeywordTable(emptyKeywordTable()));
}

interface EncodeGroup {
  anchor: string;
  hash: number;
  rows: number[];
}

export interface EncodeJob {
  source: KeywordStore;
  live: KeywordRow[];
  groups: EncodeGroup[];
  keywords: Array<{ hash: number; index: number }>;
  groupBuckets: EncodeGroup[][];
  keywordBuckets: Array<Array<{ hash: number; index: number }>>;
  anchorLists: Map<string, number[]>;
  bytes: Uint8Array | null;
  phase: "bucket" | "flatten" | "header" | "fill" | "done";
  cursor: number;
  chars: number;
  at: number;
  poolAt: number;
  anchorAt: Map<string, number>;
}

const BUCKETS = 256;

export function startEncodeJob(source: KeywordStore): EncodeJob {
  return {
    source,
    live: [],
    groups: [],
    keywords: [],
    groupBuckets: Array.from({ length: BUCKETS }, () => []),
    keywordBuckets: Array.from({ length: BUCKETS }, () => []),
    anchorLists: new Map(),
    bytes: null,
    phase: "bucket",
    cursor: 0,
    chars: 0,
    at: 0,
    poolAt: 0,
    anchorAt: new Map(),
  };
}

export function stepEncodeJob(job: EncodeJob, budgetMs: number): boolean {
  const start = performance.now();
  if (job.phase === "bucket") bucketRows(job, start, budgetMs);
  if (job.phase === "flatten" && performance.now() - start < budgetMs) flattenBuckets(job, start, budgetMs);
  if (job.phase === "header" && performance.now() - start < budgetMs) writeHeader(job, start, budgetMs);
  if (job.phase === "fill" && job.bytes !== null && performance.now() - start < budgetMs) {
    fillEncodedRows(job, start, budgetMs);
  }
  return job.phase === "done";
}

function bucketRows(job: EncodeJob, start: number, budgetMs: number): void {
  const total = storeSize(job.source);
  while (job.cursor < total && performance.now() - start < budgetMs) {
    const row = rowAt(job.source, job.cursor);
    job.cursor += 1;
    if (row === null) continue;
    const index = job.live.length;
    job.live.push(row);
    const anchor = row.anchor;
    let listed = job.anchorLists.get(anchor);
    if (listed === undefined) {
      listed = [];
      job.anchorLists.set(anchor, listed);
      const hash = hashText(anchor);
      job.groupBuckets[hash >>> 24]?.push({ anchor, hash, rows: listed });
    }
    listed.push(index);
    const keywordHash = hashText(row.keyword);
    job.keywordBuckets[keywordHash >>> 24]?.push({ hash: keywordHash, index });
    job.chars += (row.id?.length ?? 0) + row.keyword.length + row.reply.length + (row.author?.length ?? 0);
  }
  if (job.cursor < total) return;
  job.cursor = 0;
  job.phase = "flatten";
}

function storeSize(table: KeywordStore): number {
  if (table.kind === "map") return table.rows.length;
  if (table.kind === "stored") return table.rowCount;
  return table.base.rowCount + table.appended.length;
}

function rowAt(table: KeywordStore, index: number): KeywordRow | null {
  if (table.kind === "map") return table.rows[index] ?? null;
  if (table.kind === "stored") return readStoredRow(table, index);
  return readOverlayRow(table, index);
}

function flattenBuckets(job: EncodeJob, start: number, budgetMs: number): void {
  while (job.cursor < BUCKETS && performance.now() - start < budgetMs) {
    const groups = job.groupBuckets[job.cursor] ?? [];
    groups.sort((left, right) => cmpHash(left.hash, right.hash) || cmpText(left.anchor, right.anchor));
    for (const group of groups) job.groups.push(group);
    const keywords = job.keywordBuckets[job.cursor] ?? [];
    keywords.sort((left, right) => cmpHash(left.hash, right.hash) || left.index - right.index);
    for (const item of keywords) job.keywords.push(item);
    job.cursor += 1;
  }
  if (job.cursor < BUCKETS) return;
  const header = 20;
  const groupBytes = job.groups.length * GROUP_STRIDE * 4;
  const keywordBytes = job.live.length * 8;
  const poolBytes = job.live.length * 4;
  const rowBytes = job.live.length * ROW_STRIDE * 4;
  job.bytes = new Uint8Array(header + groupBytes + keywordBytes + poolBytes + rowBytes + job.chars * 2);
  const view = new DataView(job.bytes.buffer);
  view.setUint32(0, 3, true);
  view.setUint32(4, job.groups.length, true);
  view.setUint32(8, job.live.length, true);
  view.setUint32(12, job.live.length, true);
  view.setUint32(16, job.chars, true);
  job.cursor = 0;
  job.poolAt = 0;
  job.phase = "header";
}

function writeHeader(job: EncodeJob, start: number, budgetMs: number): void {
  const bytes = job.bytes;
  if (bytes === null) return;
  const view = new DataView(bytes.buffer);
  const header = 20;
  const groupBytes = job.groups.length * GROUP_STRIDE * 4;
  const keywordBytes = job.live.length * 8;
  const poolStart = header + groupBytes + keywordBytes;
  while (job.cursor < job.groups.length && performance.now() - start < budgetMs) {
    const group = job.groups[job.cursor];
    job.cursor += 1;
    if (group === undefined) continue;
    const cursor = header + (job.cursor - 1) * GROUP_STRIDE * 4;
    view.setUint32(cursor, group.hash, true);
    view.setUint32(cursor + 8, group.anchor.length, true);
    view.setUint32(cursor + 12, job.poolAt, true);
    view.setUint32(cursor + 16, job.poolAt + group.rows.length, true);
    for (const index of group.rows) {
      view.setUint32(poolStart + job.poolAt * 4, index, true);
      job.poolAt += 1;
    }
  }
  if (job.cursor < job.groups.length) return;
  let keywordCursor = job.cursor - job.groups.length;
  while (keywordCursor < job.keywords.length && performance.now() - start < budgetMs) {
    const item = job.keywords[keywordCursor];
    if (item !== undefined) {
      const cursor = header + groupBytes + keywordCursor * 8;
      view.setUint32(cursor, item.hash, true);
      view.setUint32(cursor + 4, item.index, true);
    }
    keywordCursor += 1;
    job.cursor += 1;
  }
  if (keywordCursor < job.keywords.length) return;
  job.cursor = 0;
  job.at = 0;
  job.phase = "fill";
}

function fillEncodedRows(job: EncodeJob, start: number, budgetMs: number): void {
  const bytes = job.bytes;
  if (bytes === null) return;
  const view = new DataView(bytes.buffer);
  const header = 20;
  const groupBytes = job.groups.length * GROUP_STRIDE * 4;
  const keywordBytes = job.live.length * 8;
  const poolBytes = job.live.length * 4;
  const rowBytes = job.live.length * ROW_STRIDE * 4;
  const units = new Uint16Array(bytes.buffer, header + groupBytes + keywordBytes + poolBytes + rowBytes);
  const rowStart = header + groupBytes + keywordBytes + poolBytes;
  while (job.cursor < job.live.length && performance.now() - start < budgetMs) {
    const row = job.live[job.cursor];
    const index = job.cursor;
    job.cursor += 1;
    if (row === undefined) continue;
    const id = row.id ?? "";
    view.setUint32(rowStart + index * ROW_STRIDE * 4, job.at, true);
    view.setUint32(rowStart + index * ROW_STRIDE * 4 + 4, row.id === null ? NULL_ID : id.length, true);
    job.at = writeUnits(units, job.at, id);
    const keywordAt = job.at;
    view.setUint32(rowStart + index * ROW_STRIDE * 4 + 8, job.at, true);
    view.setUint32(rowStart + index * ROW_STRIDE * 4 + 12, row.keyword.length, true);
    job.at = writeUnits(units, job.at, row.keyword);
    if (!job.anchorAt.has(row.anchor)) {
      job.anchorAt.set(row.anchor, keywordAt + row.keyword.indexOf(row.anchor));
    }
    view.setUint32(rowStart + index * ROW_STRIDE * 4 + 16, job.at, true);
    view.setUint32(rowStart + index * ROW_STRIDE * 4 + 20, row.reply.length, true);
    job.at = writeUnits(units, job.at, row.reply);
    view.setUint32(rowStart + index * ROW_STRIDE * 4 + 24, job.at, true);
    view.setUint32(rowStart + index * ROW_STRIDE * 4 + 28, row.author === null ? NULL_ID : row.author.length, true);
    if (row.author !== null) job.at = writeUnits(units, job.at, row.author);
  }
  if (job.cursor < job.live.length) return;
  let groupCursor = header;
  for (const group of job.groups) {
    view.setUint32(groupCursor + 4, job.anchorAt.get(group.anchor) ?? 0, true);
    groupCursor += GROUP_STRIDE * 4;
  }
  job.phase = "done";
}

function emptyOverlay(base: StoredKeywordTable): OverlayKeywordTable {
  return {
    kind: "overlay",
    base,
    deleted: new Set(),
    replaced: new Map(),
    appended: [],
    keyIndex: new Map(),
  };
}

function findBaseRow(base: StoredKeywordTable, id: string, keyword: string): number | null {
  for (const index of keywordIndexes(base, keyword)) {
    const row = readStoredRow(base, index);
    if ((row.id ?? "") === id) return index;
  }
  return null;
}

function overlayRows(
  table: OverlayKeywordTable,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordRow[] {
  if (message !== "" && !query.allReply) {
    const indexes = [
      ...keywordIndexes(table.base, message),
      ...appendedIndexes(table, (row) => row.keyword === message),
    ].sort((left, right) => left - right);
    for (const index of indexes) {
      const row = readOverlayRow(table, index);
      if (row === null || !rowPasses(row, query)) continue;
      return [row];
    }
  }
  if (hits.length === 0) return [];
  const wanted = new Set(hits);
  const found: number[] = [];
  for (const hit of hits) {
    const group = findGroup(table.base, hit);
    if (group === null) continue;
    for (let i = group.begin; i < group.end; i += 1) found.push(table.base.pool[i] ?? 0);
  }
  found.push(...appendedIndexes(table, (row) => wanted.has(row.anchor)));
  found.sort((left, right) => left - right);
  const rows: KeywordRow[] = [];
  for (const index of found) {
    const row = readOverlayRow(table, index);
    if (row === null || (query.scopeId !== null && row.id !== query.scopeId)) continue;
    rows.push(row);
  }
  return rows;
}

function appendedIndexes(
  table: OverlayKeywordTable,
  take: (row: KeywordRow) => boolean,
): number[] {
  const found: number[] = [];
  for (let i = 0; i < table.appended.length; i += 1) {
    const row = table.appended[i];
    if (row !== null && row !== undefined && take(row)) found.push(table.base.rowCount + i);
  }
  return found;
}

function readOverlayRow(table: OverlayKeywordTable, index: number): KeywordRow | null {
  if (table.deleted.has(index)) return null;
  const replaced = table.replaced.get(index);
  if (replaced !== undefined) return replaced;
  if (index < table.base.rowCount) return readStoredRow(table.base, index);
  return table.appended[index - table.base.rowCount] ?? null;
}

function writeUnits(units: Uint16Array, at: number, text: string): number {
  for (let i = 0; i < text.length; i += 1) units[at + i] = text.charCodeAt(i);
  return at + text.length;
}

function sliceText(units: Uint16Array, at: number, length: number): string {
  if (length === 0) return "";
  let text = "";
  for (let i = 0; i < length; i += 1024) {
    const end = Math.min(length, i + 1024);
    text += String.fromCharCode(...units.subarray(at + i, at + end));
  }
  return text;
}

function sameText(units: Uint16Array, at: number, length: number, text: string): boolean {
  if (text.length !== length) return false;
  for (let i = 0; i < length; i += 1) {
    if (units[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function cmpHash(left: number, right: number): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cmpText(left: string, right: string): number {
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const diff = left.charCodeAt(i) - right.charCodeAt(i);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}
