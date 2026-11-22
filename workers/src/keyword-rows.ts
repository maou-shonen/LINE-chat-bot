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

export interface ChunkedKeywordTable {
  kind: "chunked";
  gen: number;
  rowCount: number;
  chunkCount: number;
  emptyAnchor: boolean;
  lengths: number[];
  loaded: Map<number, StoredKeywordTable>;
  rowIndex: Map<number, number>;
}

export type BaseKeywordTable = StoredKeywordTable | ChunkedKeywordTable;

export interface OverlayKeywordTable {
  kind: "overlay";
  base: BaseKeywordTable;
  deleted: Set<number>;
  replaced: Map<number, KeywordRow>;
  appended: Array<KeywordRow | null>;
  keyIndex: Map<string, number>;
}

export type KeywordStore = KeywordTable | StoredKeywordTable | ChunkedKeywordTable | OverlayKeywordTable;

export const KEYWORD_CHUNK_COUNT = 64;

// v4 caches recorded 8 chunks; new blobs record 64. Follow the meta count so an
// old cache stays readable after the upgrade.
export function keywordChunk(anchor: string, chunkCount: number = KEYWORD_CHUNK_COUNT): number {
  const bits = 31 - Math.clz32(chunkCount);
  return bits === 0 ? 0 : hashText(anchor) >>> (32 - bits);
}

export function registerChunk(
  base: ChunkedKeywordTable,
  id: number,
  chunk: StoredKeywordTable,
): void {
  if (base.loaded.has(id)) return;
  base.loaded.set(id, chunk);
  for (let local = 0; local < chunk.rowCount; local += 1) {
    const ordinal = chunk.rowMeta[local * ROW_STRIDE + ROW_ORDINAL] ?? local;
    base.rowIndex.set(ordinal, (id << CHUNK_LOCAL_SHIFT) | local);
  }
}

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
  if (table.kind === "chunked") return chunkedRows(table, message, query, hits);
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

export interface KeywordMatchRows {
  rows: KeywordRow[];
  candidates: number;
}

/**
 * Same candidate order as rowsForHits, but decodes only rows whose keyword can
 * match the message. Exact, destar and wildcard checks are repeated later by
 * matchKeyword; this only removes rows that cannot win.
 */
export function matchingRows(
  table: KeywordStore,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordMatchRows {
  if (table.kind === "stored") return matchingStored(table, message, query, hits);
  if (table.kind === "chunked") return matchingChunked(table, message, query, hits);
  if (table.kind === "overlay") return matchingOverlay(table, message, query, hits);
  const rows = rowsForHits(table, message, query, hits);
  return { rows, candidates: rows.length };
}

function matchingStored(
  table: StoredKeywordTable,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordMatchRows {
  if (message !== "" && !query.allReply) {
    for (const index of keywordIndexes(table, message)) {
      const row = readStoredRow(table, index);
      if (!rowPasses(row, query)) continue;
      return { rows: [row], candidates: 1 };
    }
  }
  if (hits.length === 0) return { rows: [], candidates: 0 };
  const found: number[] = [];
  for (const hit of hits) {
    const group = findGroup(table, hit);
    if (group === null) continue;
    for (let i = group.begin; i < group.end; i += 1) found.push(table.pool[i] ?? 0);
  }
  found.sort((left, right) => left - right);
  let candidates = 0;
  const rows: KeywordRow[] = [];
  for (const index of found) {
    if (query.scopeId !== null && !storedIdIs(table, index, query.scopeId)) continue;
    candidates += 1;
    if (!storedMayMatch(table, index, message)) continue;
    rows.push(readMatchStoredRow(table, index));
  }
  return { rows, candidates };
}

function matchingChunked(
  table: ChunkedKeywordTable,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordMatchRows {
  if (message !== "" && !query.allReply) {
    for (const index of baseKeywordIndexes(table, message)) {
      const row = baseReadRow(table, index);
      if (!rowPasses(row, query)) continue;
      return { rows: [row], candidates: 1 };
    }
  }
  if (hits.length === 0) return { rows: [], candidates: 0 };
  const found: number[] = [];
  for (const hit of hits) pushBaseGroupRows(table, hit, found);
  found.sort((left, right) => left - right);
  let candidates = 0;
  const rows: KeywordRow[] = [];
  for (const index of found) {
    if (query.scopeId !== null && !baseIdIs(table, index, query.scopeId)) continue;
    candidates += 1;
    if (!baseMayMatch(table, index, message)) continue;
    rows.push(readMatchChunkedRow(table, index));
  }
  return { rows, candidates };
}

function matchingOverlay(
  table: OverlayKeywordTable,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordMatchRows {
  if (message !== "" && !query.allReply) {
    const rows = overlayRows(table, message, query, hits);
    return { rows, candidates: rows.length };
  }
  if (hits.length === 0) return { rows: [], candidates: 0 };
  const wanted = new Set(hits);
  const found: number[] = [];
  for (const hit of hits) pushBaseGroupRows(table.base, hit, found);
  found.push(...appendedIndexes(table, (row) => wanted.has(row.anchor)));
  found.sort((left, right) => left - right);
  let candidates = 0;
  const rows: KeywordRow[] = [];
  for (const index of found) {
    if (index < table.base.rowCount) {
      const replaced = table.replaced.get(index);
      if (replaced !== undefined) {
        if (query.scopeId !== null && (replaced.id ?? "") !== query.scopeId) continue;
        candidates += 1;
        rows.push(replaced);
        continue;
      }
      if (table.deleted.has(index)) continue;
      if (query.scopeId !== null && !baseIdIs(table.base, index, query.scopeId)) continue;
      candidates += 1;
      if (!baseMayMatch(table.base, index, message)) continue;
      rows.push(baseReadMatchRow(table.base, index));
      continue;
    }
    const appended = table.appended[index - table.base.rowCount];
    if (appended === null || appended === undefined) continue;
    if (query.scopeId !== null && (appended.id ?? "") !== query.scopeId) continue;
    candidates += 1;
    // Appended rows are at most the delta limit; let matchKeyword filter them.
    rows.push(appended);
  }
  return { rows, candidates };
}

function baseMayMatch(base: BaseKeywordTable, index: number, message: string): boolean {
  if (base.kind === "stored") return storedMayMatch(base, index, message);
  const packed = base.rowIndex.get(index);
  if (packed === undefined) throw new Error("keyword chunk was not loaded");
  const chunk = base.loaded.get(packed >>> CHUNK_LOCAL_SHIFT);
  if (chunk === undefined) throw new Error("keyword chunk was not loaded");
  return storedMayMatch(chunk, packed & CHUNK_LOCAL_MASK, message);
}

function storedMayMatch(table: StoredKeywordTable, index: number, message: string): boolean {
  const base = index * ROW_STRIDE;
  const off = table.rowMeta[base + 2] ?? 0;
  const len = table.rowMeta[base + 3] ?? 0;
  if (sameText(table.units, off, len, message)) return true;
  if (!hasDoubleStar(table.units, off, len)) {
    // Candidate groups come from an anchor that is in the message. For a
    // keyword without **, that anchor is the whole keyword.
    if (len === 0) return true;
    return message.charCodeAt(0) === (table.units[off] ?? 0)
      && message.charCodeAt(message.length - 1) === (table.units[off + len - 1] ?? 0);
  }
  if (withoutDoubleStarEqualsUnits(table.units, off, len, message)) return true;
  return wildcardMatchUnits(table.units, off, len, message);
}

function hasDoubleStar(units: Uint16Array, off: number, len: number): boolean {
  for (let i = 0; i < len - 1; i += 1) {
    if (units[off + i] === 42 && units[off + i + 1] === 42) return true;
  }
  return false;
}

function withoutDoubleStarEqualsUnits(
  units: Uint16Array,
  off: number,
  len: number,
  message: string,
): boolean {
  let at = 0;
  for (let i = 0; i < len;) {
    if (units[off + i] === 42 && units[off + i + 1] === 42) {
      i += 2;
      continue;
    }
    if (at >= message.length || units[off + i] !== message.charCodeAt(at)) return false;
    i += 1;
    at += 1;
  }
  return at === message.length;
}

function wildcardMatchUnits(
  units: Uint16Array,
  off: number,
  len: number,
  message: string,
): boolean {
  const firstStar = findDoubleStar(units, off, off + len);
  if (firstStar === -1) {
    if (len === 0) return true;
    const keyword = sliceText(units, off, len);
    if (message.indexOf(keyword) === -1) return false;
    return message[0] === keyword[0] && message[message.length - 1] === keyword[keyword.length - 1];
  }
  const first = firstStar;
  const lastStar = findLastDoubleStar(units, off, off + len);
  const last = lastStar === -1 ? off + len : lastStar + 2;
  const firstText = sliceText(units, off, first - off);
  const lastText = sliceText(units, last, off + len - last);
  let kn = -1;
  let start = off;
  for (;;) {
    const end = findDoubleStar(units, start, off + len);
    const stop = end === -1 ? off + len : end;
    const piece = sliceText(units, start, stop - start);
    if (piece !== "") {
      const found = message.indexOf(piece);
      if (found > kn) kn = found;
      else return false;
    }
    // The original rechecks the pins for every piece, including empty ones.
    if (firstText !== "" && message[0] !== String.fromCharCode(units[off] ?? 0)) return false;
    if (lastText !== "" && message[message.length - 1] !== String.fromCharCode(units[off + len - 1] ?? 0)) {
      return false;
    }
    if (end === -1) break;
    start = end + 2;
  }
  return true;
}

function findDoubleStar(units: Uint16Array, from: number, end: number): number {
  for (let i = from; i < end - 1; i += 1) {
    if (units[i] === 42 && units[i + 1] === 42) return i;
  }
  return -1;
}

function findLastDoubleStar(units: Uint16Array, from: number, end: number): number {
  for (let i = end - 2; i >= from; i -= 1) {
    if (units[i] === 42 && units[i + 1] === 42) return i;
  }
  return -1;
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
  if (table.kind === "chunked") {
    for (let i = 0; i < table.rowCount; i += 1) {
      if (baseIdIs(table, i, wanted)) out.push(baseField(table, i, 2));
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
    if (baseIdIs(table.base, i, wanted)) out.push(baseField(table.base, i, 2));
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
  if (table.kind === "chunked") {
    for (let i = 0; i < table.rowCount; i += 1) visit(baseReadRow(table, i));
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
  if (table.kind === "stored" || table.kind === "chunked") {
    const index = findBaseRow(table, scopeId ?? "", keyword);
    return index === null ? null : baseReadRow(table, index);
  }
  const known = table.keyIndex.get(`${scopeId ?? ""}\0${keyword}`);
  if (known !== undefined) return readOverlayRow(table, known);
  const index = findBaseRow(table.base, scopeId ?? "", keyword);
  if (index === null || table.deleted.has(index)) return null;
  return table.replaced.get(index) ?? baseReadRow(table.base, index);
}

export function encodeKeywordTable(table: KeywordTable): Uint8Array {
  const live: KeywordRow[] = [];
  for (const row of table.rows) {
    if (row !== null) live.push(row);
  }
  const ordinals = live.map((_, index) => index);
  return encodeKeywordRows(live, ordinals);
}

export function encodeKeywordRows(
  live: readonly KeywordRow[],
  ordinals: readonly number[],
): Uint8Array {
  if (live.length !== ordinals.length) throw new TypeError("keyword ordinal count mismatch");
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
  view.setUint32(0, 4, true);
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
    view.setUint32(rowStart + i * ROW_STRIDE * 4 + 32, ordinals[i] ?? i, true);
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
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 4) {
    throw new TypeError("keyword row blob was not version 4");
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
const ROW_STRIDE = 9;
const ROW_ORDINAL = 8;
const NULL_ID = 0xffffffff;
const CHUNK_LOCAL_SHIFT = 20;
const CHUNK_LOCAL_MASK = (1 << CHUNK_LOCAL_SHIFT) - 1;

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
    if (query.scopeId !== null && !storedIdIs(table, index, query.scopeId)) continue;
    rows.push(readStoredRow(table, index));
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

/** matchKeyword only reads keyword and reply; skip the other decoded fields. */
function readMatchStoredRow(table: StoredKeywordTable, index: number): KeywordRow {
  const base = index * ROW_STRIDE;
  return {
    id: null,
    keyword: sliceText(table.units, table.rowMeta[base + 2] ?? 0, table.rowMeta[base + 3] ?? 0),
    reply: sliceText(table.units, table.rowMeta[base + 4] ?? 0, table.rowMeta[base + 5] ?? 0),
    anchor: "",
    author: null,
  };
}

function baseReadMatchRow(base: BaseKeywordTable, index: number): KeywordRow {
  if (base.kind === "stored") return readMatchStoredRow(base, index);
  return readMatchChunkedRow(base, index);
}

function readMatchChunkedRow(base: ChunkedKeywordTable, index: number): KeywordRow {
  const packed = base.rowIndex.get(index);
  if (packed === undefined) throw new Error("keyword chunk was not loaded");
  const chunk = base.loaded.get(packed >>> CHUNK_LOCAL_SHIFT);
  if (chunk === undefined) throw new Error("keyword chunk was not loaded");
  return readMatchStoredRow(chunk, packed & CHUNK_LOCAL_MASK);
}

function chunkedRows(
  table: ChunkedKeywordTable,
  message: string,
  query: KeywordSelect,
  hits: readonly string[],
): KeywordRow[] {
  if (message !== "" && !query.allReply) {
    for (const index of baseKeywordIndexes(table, message)) {
      const row = baseReadRow(table, index);
      if (!rowPasses(row, query)) continue;
      return [row];
    }
  }
  if (hits.length === 0) return [];
  const found: number[] = [];
  for (const hit of hits) pushBaseGroupRows(table, hit, found);
  found.sort((left, right) => left - right);
  const rows: KeywordRow[] = [];
  for (const index of found) {
    if (query.scopeId !== null && !baseIdIs(table, index, query.scopeId)) continue;
    rows.push(baseReadRow(table, index));
  }
  return rows;
}

function chunkRowOrdinal(chunk: StoredKeywordTable, local: number): number {
  return chunk.rowMeta[local * ROW_STRIDE + ROW_ORDINAL] ?? local;
}

function baseReadRow(base: BaseKeywordTable, index: number): KeywordRow {
  if (base.kind === "stored") return readStoredRow(base, index);
  const packed = base.rowIndex.get(index);
  if (packed === undefined) throw new Error("keyword chunk was not loaded");
  const chunk = base.loaded.get(packed >>> CHUNK_LOCAL_SHIFT);
  if (chunk === undefined) throw new Error("keyword chunk was not loaded");
  return readStoredRow(chunk, packed & CHUNK_LOCAL_MASK);
}

function baseIdIs(base: BaseKeywordTable, index: number, id: string): boolean {
  if (base.kind === "stored") return storedIdIs(base, index, id);
  const packed = base.rowIndex.get(index);
  if (packed === undefined) throw new Error("keyword chunk was not loaded");
  const chunk = base.loaded.get(packed >>> CHUNK_LOCAL_SHIFT);
  if (chunk === undefined) throw new Error("keyword chunk was not loaded");
  return storedIdIs(chunk, packed & CHUNK_LOCAL_MASK, id);
}

function baseField(base: BaseKeywordTable, index: number, slot: number): string {
  if (base.kind === "stored") return storedField(base, index, slot);
  const packed = base.rowIndex.get(index);
  if (packed === undefined) throw new Error("keyword chunk was not loaded");
  const chunk = base.loaded.get(packed >>> CHUNK_LOCAL_SHIFT);
  if (chunk === undefined) throw new Error("keyword chunk was not loaded");
  return storedField(chunk, packed & CHUNK_LOCAL_MASK, slot);
}

function pushBaseGroupRows(base: BaseKeywordTable, anchor: string, rows: number[]): void {
  if (base.kind === "stored") {
    const group = findGroup(base, anchor);
    if (group === null) return;
    for (let i = group.begin; i < group.end; i += 1) rows.push(base.pool[i] ?? 0);
    return;
  }
  if (anchor === "" && !base.emptyAnchor) return;
  const chunk = base.loaded.get(keywordChunk(anchor, base.chunkCount));
  if (chunk === undefined) throw new Error("keyword chunk was not loaded");
  const group = findGroup(chunk, anchor);
  if (group === null) return;
  for (let i = group.begin; i < group.end; i += 1) {
    rows.push(chunkRowOrdinal(chunk, chunk.pool[i] ?? 0));
  }
}

function baseKeywordIndexes(base: BaseKeywordTable, keyword: string): number[] {
  if (base.kind === "stored") return keywordIndexes(base, keyword);
  const anchor = anchorOf(keyword);
  if (anchor === "" && !base.emptyAnchor) return [];
  const chunk = base.loaded.get(keywordChunk(anchor, base.chunkCount));
  if (chunk === undefined) throw new Error("keyword chunk was not loaded");
  return keywordIndexes(chunk, keyword).map((local) => chunkRowOrdinal(chunk, local));
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

export function applyRowDelta(base: BaseKeywordTable, ops: readonly RowDeltaOp[]): OverlayKeywordTable {
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
    author: index !== null && index < table.base.rowCount ? baseReadRow(table.base, index).author : null,
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
  if (table.kind === "chunked") {
    const rows: KeywordRow[] = [];
    for (let i = 0; i < table.rowCount; i += 1) rows.push(baseReadRow(table, i));
    return rows;
  }
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

interface ChunkSlot {
  rows: KeywordRow[];
  ordinals: number[];
  groups: Map<string, number[]>;
  chars: number;
  bytes: Uint8Array | null;
  view: DataView | null;
  units: Uint16Array | null;
  rowStart: number;
  poolStart: number;
  at: number;
  fillAt: number;
  keywords: Array<{ hash: number; index: number }> | null;
}

export interface ChunkEncodeJob {
  source: KeywordStore;
  phase: "scan" | "alloc" | "fill" | "sort" | "done";
  cursor: number;
  total: number;
  chunks: ChunkSlot[];
  bytes: Array<Uint8Array | null>;
  anchors: string[];
  lengths: number[];
  anchorSeen: Set<string>;
  lengthSeen: Set<number>;
  hasEmptyAnchor: boolean;
  rowCount: number;
  rowBytes: number;
}

export function startChunkEncodeJob(source: KeywordStore): ChunkEncodeJob {
  return {
    source,
    phase: "scan",
    cursor: 0,
    total: storeSize(source),
    chunks: Array.from({ length: KEYWORD_CHUNK_COUNT }, () => ({
      rows: [],
      ordinals: [],
      groups: new Map(),
      chars: 0,
      bytes: null,
      view: null,
      units: null,
      rowStart: 0,
      poolStart: 0,
      at: 0,
      fillAt: 0,
      keywords: null,
    })),
    bytes: Array.from({ length: KEYWORD_CHUNK_COUNT }, () => null),
    anchors: [],
    lengths: [],
    anchorSeen: new Set(),
    lengthSeen: new Set(),
    hasEmptyAnchor: false,
    rowCount: 0,
    rowBytes: 0,
  };
}

export function stepChunkEncodeJob(job: ChunkEncodeJob, budgetMs: number): boolean {
  const start = performance.now();
  if (job.phase === "scan") scanChunkRows(job, start, budgetMs);
  if (job.phase === "alloc" && performance.now() - start < budgetMs) allocChunks(job, start, budgetMs);
  if (job.phase === "fill" && performance.now() - start < budgetMs) fillChunks(job, start, budgetMs);
  if (job.phase === "sort" && performance.now() - start < budgetMs) sortChunks(job, start, budgetMs);
  return job.phase === "done";
}

function scanChunkRows(job: ChunkEncodeJob, start: number, budgetMs: number): void {
  while (job.cursor < job.total && performance.now() - start < budgetMs) {
    const row = rowAt(job.source, job.cursor);
    job.cursor += 1;
    if (row === null) continue;
    const slot = job.chunks[keywordChunk(row.anchor)];
    if (slot === undefined) throw new Error("keyword chunk index was out of range");
    if (slot.rows.length >= CHUNK_LOCAL_MASK) throw new Error("keyword chunk was too large");
    const local = slot.rows.length;
    slot.rows.push(row);
    slot.ordinals.push(job.rowCount);
    slot.chars += (row.id?.length ?? 0) + row.keyword.length + row.reply.length + (row.author?.length ?? 0);
    const group = slot.groups.get(row.anchor);
    if (group === undefined) slot.groups.set(row.anchor, [local]);
    else group.push(local);
    job.rowCount += 1;
    if (row.anchor !== "") {
      job.anchorSeen.add(row.anchor);
      job.lengthSeen.add([...row.anchor].length);
    } else {
      job.hasEmptyAnchor = true;
    }
  }
  if (job.cursor < job.total) return;
  job.anchors = [...job.anchorSeen];
  job.lengths = [...job.lengthSeen].sort((left, right) => left - right);
  job.anchorSeen.clear();
  job.lengthSeen.clear();
  job.cursor = 0;
  job.phase = "alloc";
}

function allocChunks(job: ChunkEncodeJob, start: number, budgetMs: number): void {
  while (job.cursor < KEYWORD_CHUNK_COUNT && performance.now() - start < budgetMs) {
    const slot = job.chunks[job.cursor];
    job.cursor += 1;
    if (slot === undefined || slot.rows.length === 0) continue;
    const header = 20;
    const groupBytes = slot.groups.size * GROUP_STRIDE * 4;
    const keywordBytes = slot.rows.length * 8;
    const poolBytes = slot.rows.length * 4;
    const rowBytes = slot.rows.length * ROW_STRIDE * 4;
    const bytes = new Uint8Array(header + groupBytes + keywordBytes + poolBytes + rowBytes + slot.chars * 2);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 4, true);
    view.setUint32(4, slot.groups.size, true);
    view.setUint32(8, slot.rows.length, true);
    view.setUint32(12, slot.rows.length, true);
    view.setUint32(16, slot.chars, true);
    slot.bytes = bytes;
    slot.view = view;
    slot.poolStart = header + groupBytes + keywordBytes;
    slot.rowStart = slot.poolStart + poolBytes;
    slot.units = new Uint16Array(bytes.buffer, slot.rowStart + rowBytes, slot.chars);
    slot.keywords = new Array(slot.rows.length);
  }
  if (job.cursor < KEYWORD_CHUNK_COUNT) return;
  job.cursor = 0;
  job.phase = "fill";
}

function fillChunks(job: ChunkEncodeJob, start: number, budgetMs: number): void {
  while (job.cursor < KEYWORD_CHUNK_COUNT && performance.now() - start < budgetMs) {
    const slot = job.chunks[job.cursor];
    if (slot === undefined || slot.rows.length === 0) {
      job.cursor += 1;
      continue;
    }
    const view = slot.view;
    const units = slot.units;
    const keywords = slot.keywords;
    if (view === null || units === null || keywords === null) throw new Error("keyword chunk was not allocated");
    while (slot.fillAt < slot.rows.length && performance.now() - start < budgetMs) {
      const local = slot.fillAt;
      const row = slot.rows[local] as KeywordRow;
      const id = row.id ?? "";
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4, slot.at, true);
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4 + 4, row.id === null ? NULL_ID : id.length, true);
      slot.at = writeUnits(units, slot.at, id);
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4 + 8, slot.at, true);
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4 + 12, row.keyword.length, true);
      slot.at = writeUnits(units, slot.at, row.keyword);
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4 + 16, slot.at, true);
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4 + 20, row.reply.length, true);
      slot.at = writeUnits(units, slot.at, row.reply);
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4 + 24, slot.at, true);
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4 + 28, row.author === null ? NULL_ID : row.author.length, true);
      if (row.author !== null) slot.at = writeUnits(units, slot.at, row.author);
      view.setUint32(slot.rowStart + local * ROW_STRIDE * 4 + 32, slot.ordinals[local] ?? local, true);
      keywords[local] = { hash: hashText(row.keyword), index: local };
      slot.fillAt += 1;
    }
    if (slot.fillAt < slot.rows.length) return;
    job.cursor += 1;
  }
  if (job.cursor < KEYWORD_CHUNK_COUNT) return;
  job.cursor = 0;
  job.phase = "sort";
}

function sortChunks(job: ChunkEncodeJob, start: number, budgetMs: number): void {
  while (job.cursor < KEYWORD_CHUNK_COUNT && performance.now() - start < budgetMs) {
    const index = job.cursor;
    const slot = job.chunks[index];
    job.cursor += 1;
    if (slot === undefined || slot.bytes === null || slot.view === null) continue;
    const view = slot.view;
    const groups = [...slot.groups.entries()].map(([anchor, rows]) => ({
      anchor,
      hash: hashText(anchor),
      rows,
    }));
    groups.sort((left, right) => cmpHash(left.hash, right.hash) || cmpText(left.anchor, right.anchor));
    let poolAt = 0;
    for (let at = 0; at < groups.length; at += 1) {
      const group = groups[at] as (typeof groups)[number];
      const cursor = 20 + at * GROUP_STRIDE * 4;
      const first = group.rows[0] as number;
      const keywordAt = view.getUint32(slot.rowStart + first * ROW_STRIDE * 4 + 8, true);
      const row = slot.rows[first] as KeywordRow;
      view.setUint32(cursor, group.hash, true);
      view.setUint32(cursor + 4, keywordAt + row.keyword.indexOf(group.anchor), true);
      view.setUint32(cursor + 8, group.anchor.length, true);
      view.setUint32(cursor + 12, poolAt, true);
      view.setUint32(cursor + 16, poolAt + group.rows.length, true);
      for (const local of group.rows) {
        view.setUint32(slot.poolStart + poolAt * 4, local, true);
        poolAt += 1;
      }
    }
    const keywords = slot.keywords;
    if (keywords === null) throw new Error("keyword chunk keywords were missing");
    keywords.sort((left, right) => cmpHash(left.hash, right.hash) || left.index - right.index);
    const keywordStart = 20 + groups.length * GROUP_STRIDE * 4;
    for (let at = 0; at < keywords.length; at += 1) {
      const item = keywords[at] as (typeof keywords)[number];
      view.setUint32(keywordStart + at * 8, item.hash, true);
      view.setUint32(keywordStart + at * 8 + 4, item.index, true);
    }
    job.bytes[index] = slot.bytes;
    job.rowBytes += slot.bytes.byteLength;
    slot.rows = [];
    slot.groups = new Map();
    slot.keywords = null;
    slot.units = null;
  }
  if (job.cursor < KEYWORD_CHUNK_COUNT) return;
  job.phase = "done";
}

function storeSize(table: KeywordStore): number {
  if (table.kind === "map") return table.rows.length;
  if (table.kind === "stored" || table.kind === "chunked") return table.rowCount;
  return table.base.rowCount + table.appended.length;
}

function rowAt(table: KeywordStore, index: number): KeywordRow | null {
  if (table.kind === "map") return table.rows[index] ?? null;
  if (table.kind === "stored") return readStoredRow(table, index);
  if (table.kind === "chunked") return baseReadRow(table, index);
  return readOverlayRow(table, index);
}

function emptyOverlay(base: BaseKeywordTable): OverlayKeywordTable {
  return {
    kind: "overlay",
    base,
    deleted: new Set(),
    replaced: new Map(),
    appended: [],
    keyIndex: new Map(),
  };
}

function findBaseRow(base: BaseKeywordTable, id: string, keyword: string): number | null {
  for (const index of baseKeywordIndexes(base, keyword)) {
    const row = baseReadRow(base, index);
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
      ...baseKeywordIndexes(table.base, message),
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
  for (const hit of hits) pushBaseGroupRows(table.base, hit, found);
  found.push(...appendedIndexes(table, (row) => wanted.has(row.anchor)));
  found.sort((left, right) => left - right);
  const rows: KeywordRow[] = [];
  for (const index of found) {
    if (index < table.base.rowCount) {
      const replaced = table.replaced.get(index);
      if (replaced !== undefined) {
        if (query.scopeId !== null && (replaced.id ?? "") !== query.scopeId) continue;
      } else if (query.scopeId !== null && !baseIdIs(table.base, index, query.scopeId)) {
        continue;
      }
    } else {
      const appended = table.appended[index - table.base.rowCount];
      if (appended === null || appended === undefined) continue;
      if (query.scopeId !== null && (appended.id ?? "") !== query.scopeId) continue;
    }
    const row = readOverlayRow(table, index);
    if (row === null) continue;
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
  if (index < table.base.rowCount) return baseReadRow(table.base, index);
  return table.appended[index - table.base.rowCount] ?? null;
}

function writeUnits(units: Uint16Array, at: number, text: string): number {
  for (let i = 0; i < text.length; i += 1) units[at + i] = text.charCodeAt(i);
  return at + text.length;
}

function sliceText(units: Uint16Array, at: number, length: number): string {
  if (length === 0) return "";
  if (length === 1) return String.fromCharCode(units[at] ?? 0);
  if (length <= 32) {
    let text = "";
    for (let i = 0; i < length; i += 1) text += String.fromCharCode(units[at + i] ?? 0);
    return text;
  }
  let text = "";
  for (let i = 0; i < length; i += 4096) {
    const end = Math.min(length, i + 4096);
    text += String.fromCharCode.apply(null, units.subarray(at + i, at + end) as unknown as number[]);
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
