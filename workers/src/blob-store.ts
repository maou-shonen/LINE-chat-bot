import { buildAho, decodeAho, encodeAho } from "./aho";
import {
  decodeKeywordTable,
  emptyKeywordTable,
  encodeKeywordRows,
  KEYWORD_CHUNK_COUNT,
  startChunkEncodeJob,
  stepChunkEncodeJob,
  upsertKeywordRow,
} from "./keyword-rows";

export const COLD_BOT_STATE = "global-c";
export const BLOB_CHUNK_BYTES = 1_300_000;
export const BLOB_VALUE_LIMIT = 8 * 1024 * 1024;
export const KEYWORD_BLOB_KEY_LIMIT = 128;
export const KEYWORD_CACHE_META_KEY = "keyword-cache-meta";
const LOG_BLOB_LIMIT = 16;
const LOG_PART_BYTES = 1_000_000;

export const KEYWORD_CACHE_VERSION = 4;

export interface GroupBlobUser {
  uid: string;
  name: string | null;
  _count: string;
  _setting: string;
}

export interface GroupBlob {
  id: string;
  group: {
    id: string;
    _id: string | null;
    _count: string;
    _setting: string;
    _admin: string;
    create_on: string | null;
    update_on: string | null;
  } | null;
  users: GroupBlobUser[];
  settings: Array<{ user_id: string; options: string }>;
}

export interface UserShard {
  users: Array<{
    id: string;
    name: string | null;
    create_on: string | null;
    update_on: string | null;
  }>;
  settings: Array<{ user_id: string; options: string }>;
}

export type LogRow = [
  string,
  string | null,
  string | null,
  string | null,
  string | null,
];

export interface BlobPut {
  key: string;
  bytes?: Uint8Array;
  json?: unknown;
}

export class BlobPutError extends Error {
  constructor() {
    super("invalid blob");
    this.name = "BlobPutError";
  }
}

export function userShardIndex(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash & 255;
}

export function userShardKey(index: number): string {
  return `c-user:${index.toString(16).padStart(2, "0")}`;
}

export function groupBlobKeyOrNull(id: string): string | null {
  return /^[A-Za-z0-9]{1,64}$/.test(id) ? `c-group:${id}` : null;
}

export function groupBlobKey(id: string): string {
  const key = groupBlobKeyOrNull(id);
  if (key === null) throw new BlobPutError();
  return key;
}

export function keywordBlobEntries(
  rows: ReadonlyArray<{ id: string | null; keyword: string; reply: string; author?: string | null }>,
): BlobPut[] {
  const table = emptyKeywordTable();
  for (const row of rows) upsertKeywordRow(table, row);
  const job = startChunkEncodeJob(table);
  while (!stepChunkEncodeJob(job, 1e9)) {
    // one full encode
  }
  const aho = encodeAho(buildAho(job.anchors));
  const ahoParts = splitBytes(aho);
  const entries: BlobPut[] = [];
  ahoParts.forEach((part, index) => {
    entries.push({ key: ahoChunkKey(1, index), bytes: part });
  });
  let rowBytes = 0;
  for (let index = 0; index < KEYWORD_CHUNK_COUNT; index += 1) {
    const part = job.bytes[index] ?? encodeKeywordRows([], []);
    rowBytes += part.byteLength;
    entries.push({ key: rowChunkKey(1, index), bytes: part });
  }
  entries.push({
    key: KEYWORD_CACHE_META_KEY,
    json: {
      version: KEYWORD_CACHE_VERSION,
      ahoGen: 1,
      ahoChunks: ahoParts.length,
      ahoBytes: aho.byteLength,
      rowGen: 1,
      rowChunks: KEYWORD_CHUNK_COUNT,
      rowBytes,
      rowCount: job.rowCount,
      anchors: job.anchors.length,
      emptyAnchor: job.hasEmptyAnchor,
      lengths: job.lengths,
    },
  });
  if (entries.length > KEYWORD_BLOB_KEY_LIMIT) throw new Error("keyword blob exceeds key limit");
  return entries;
}

export function keywordBlobsRoundTrip(entries: readonly BlobPut[]): number {
  const meta = entries.find((entry) => entry.key === KEYWORD_CACHE_META_KEY)?.json;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new TypeError("keyword meta was missing");
  }
  const record = meta as Record<string, unknown>;
  const ahoChunks = record.ahoChunks;
  const rowChunks = record.rowChunks;
  if (typeof ahoChunks !== "number" || typeof rowChunks !== "number") {
    throw new TypeError("keyword meta was invalid");
  }
  const machine = decodeAho(concatParts(entries, ahoChunkKey(1, 0).slice(0, -1)));
  let rows = 0;
  for (let index = 0; index < rowChunks; index += 1) {
    const part = entries.find((entry) => entry.key === rowChunkKey(1, index))?.bytes;
    if (part === undefined) throw new TypeError("keyword row chunk was missing");
    rows += decodeKeywordTable(part).rowCount;
  }
  return machine.chars.length + rows;
}

export function splitLogBlobs(rows: readonly LogRow[]): LogRow[][] {
  const parts: LogRow[][] = [];
  let start = 0;
  while (start < rows.length) {
    let low = start + 1;
    let high = rows.length;
    let end = start + 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (jsonSize(rows.slice(start, mid)) <= LOG_PART_BYTES) {
        end = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (jsonSize(rows.slice(start, end)) > LOG_PART_BYTES) throw new Error("log row exceeds blob limit");
    parts.push(rows.slice(start, end));
    start = end;
  }
  if (parts.length > LOG_BLOB_LIMIT) throw new Error("log archive exceeds 16 keys");
  return parts;
}

export function assertBlobKey(key: string): void {
  if (key === KEYWORD_CACHE_META_KEY || key === "c-manifest") return;
  if (/^keyword-aho-\d+-\d+$/.test(key)) return;
  if (/^keyword-rows-\d+-\d+$/.test(key)) return;
  if (/^c-group:[A-Za-z0-9]{1,64}$/.test(key)) return;
  if (/^c-user:[0-9a-f]{2}$/.test(key)) return;
  if (/^c-logs:\d{1,2}$/.test(key)) return;
  throw new BlobPutError();
}

export function parseBlobPut(input: unknown): BlobPut {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new BlobPutError();
  const record = input as Record<string, unknown>;
  const key = record.key;
  if (typeof key !== "string" || key.length > 96) throw new BlobPutError();
  assertBlobKey(key);
  const hasBytes = record.bytes !== undefined;
  const hasJson = record.json !== undefined;
  if (hasBytes === hasJson) throw new BlobPutError();
  if (hasBytes) {
    if (typeof record.bytes !== "string") throw new BlobPutError();
    const bytes = decodeBase64(record.bytes);
    assertValueLimit(key, bytes.byteLength);
    return { key, bytes };
  }
  assertValueLimit(key, jsonSize(record.json));
  return { key, json: record.json };
}

export function blobPutBody(put: BlobPut): string {
  if (put.bytes !== undefined) {
    return JSON.stringify({ key: put.key, bytes: encodeBase64(put.bytes) });
  }
  return JSON.stringify({ key: put.key, json: put.json });
}

export function assertKvEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("endpoint must be an absolute URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("endpoint must not include a user, query, or hash");
  }
  if (url.pathname !== "/import/kv") throw new Error("endpoint path must be /import/kv");
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("endpoint must be https, or http on localhost");
  }
  return url;
}

function splitBytes(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength === 0) return [bytes];
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.byteLength; i += BLOB_CHUNK_BYTES) {
    parts.push(bytes.slice(i, Math.min(bytes.byteLength, i + BLOB_CHUNK_BYTES)));
  }
  return parts;
}

export function ahoChunkKey(gen: number, index: number): string {
  return `keyword-aho-${gen}-${index}`;
}

export function rowChunkKey(gen: number, index: number): string {
  return `keyword-rows-${gen}-${index}`;
}

function concatParts(entries: readonly BlobPut[], prefix: string): Uint8Array {
  const parts = entries
    .filter((entry) => entry.key.startsWith(prefix) && entry.bytes !== undefined)
    .sort((left, right) => Number(left.key.slice(prefix.length)) - Number(right.key.slice(prefix.length)));
  const size = parts.reduce((sum, entry) => sum + (entry.bytes?.byteLength ?? 0), 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const entry of parts) {
    const bytes = entry.bytes;
    if (bytes === undefined) continue;
    out.set(bytes, at);
    at += bytes.byteLength;
  }
  return out;
}

function jsonSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertValueLimit(key: string, bytes: number): void {
  if (key.length + bytes > BLOB_VALUE_LIMIT) throw new BlobPutError();
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(value)) throw new BlobPutError();
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
