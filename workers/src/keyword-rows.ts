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

export type KeywordStore = KeywordTable | StoredKeywordTable;

export function emptyKeywordTable(): KeywordTable {
  return { kind: "map", rows: [], byAnchor: new Map(), byKeyword: new Map(), byId: new Map() };
}

export function upsertKeywordRow(
  table: KeywordTable,
  row: { id: string | null; keyword: string; reply: string },
): void {
  const anchor = anchorOf(row.keyword);
  const stored: KeywordRow = { id: row.id, keyword: row.keyword, reply: row.reply, anchor };
  if (row.id === null) {
    const at = table.rows.length;
    table.rows.push(stored);
    pushIndex(table.byKeyword, row.keyword, at);
    pushIndex(table.byAnchor, anchor, at);
    return;
  }
  const bucket = idBucket(table, row.id);
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
  for (const row of live) chars += (row.id?.length ?? 0) + row.keyword.length + row.reply.length;
  const poolCount = live.length;
  const header = 20;
  const groupBytes = groups.length * GROUP_STRIDE * 4;
  const keywordBytes = live.length * 8;
  const poolBytes = poolCount * 4;
  const rowBytes = live.length * ROW_STRIDE * 4;
  const bytes = new Uint8Array(header + groupBytes + keywordBytes + poolBytes + rowBytes + chars * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 2, true);
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
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 2) {
    throw new TypeError("keyword row blob was not version 2");
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
const ROW_STRIDE = 6;
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
  const id = idLen === NULL_ID ? null : sliceText(table.units, idOff, idLen);
  const keyword = sliceText(table.units, kwOff, kwLen);
  return {
    id,
    keyword,
    reply: sliceText(table.units, replyOff, replyLen),
    anchor: anchorOf(keyword),
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
