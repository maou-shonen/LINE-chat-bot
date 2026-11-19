declare global {
  interface Env {
    IMPORT_SECRET?: string;
  }
  namespace Cloudflare {
    interface Env {
      IMPORT_SECRET?: string;
    }
  }
}

export const IMPORT_SECRET_HEADER = "x-import-secret";
export const DAILY_WRITE_LIMIT = 80_000;
export const DEFAULT_BATCH_SIZE = 200;
export const MAX_BATCH_ROWS = 1000;
export const BATCH_BOOKKEEPING_WRITES = 2;

export const IMPORT_TABLE_ORDER = [
  "user",
  "group",
  "group_user",
  "keywords_logs",
  "user_keyword",
  "user_settings",
] as const;

export type ImportTable = (typeof IMPORT_TABLE_ORDER)[number];

type CellKind = "text" | "text?" | "scope" | "json" | "blank" | "int" | "options";

interface ColumnSpec {
  name: string;
  kind: CellKind;
}

interface TableSpec {
  indexes: number;
  orderBy: string;
  read: readonly string[];
  write: readonly ColumnSpec[];
}

// index counts are SQLite indexes updated by an insert, excluding the table btree.
// INTEGER PRIMARY KEY is that btree, so user_keyword does not add one for _id.
// D1 pricing, which Durable Object SQLite uses, counts one written row per updated index.
// https://developers.cloudflare.com/d1/platform/pricing/
export const TABLE_SPEC: { [K in ImportTable]: TableSpec } = {
  user: {
    indexes: 1,
    orderBy: "id",
    read: ["id", "name", "create_on", "update_on"],
    write: [
      { name: "id", kind: "text" },
      { name: "name", kind: "text?" },
      { name: "create_on", kind: "text?" },
      { name: "update_on", kind: "text?" },
    ],
  },
  group: {
    indexes: 1,
    orderBy: "id",
    read: ["id", "_id", "_count", "_setting", "_admin", "create_on", "update_on"],
    write: [
      { name: "id", kind: "text" },
      { name: "_id", kind: "text?" },
      { name: "_count", kind: "json" },
      { name: "_setting", kind: "json" },
      { name: "_admin", kind: "json" },
      { name: "create_on", kind: "text?" },
      { name: "update_on", kind: "text?" },
    ],
  },
  group_user: {
    indexes: 1,
    orderBy: "_id",
    read: ["_id", "gid", "uid", "_count", "_setting"],
    write: [
      { name: "gid", kind: "scope" },
      { name: "uid", kind: "scope" },
      { name: "_count", kind: "json" },
      { name: "_setting", kind: "json" },
    ],
  },
  keywords_logs: {
    indexes: 1,
    orderBy: "_id",
    read: ["_id", "id", "keyword", "reply", "create_on"],
    write: [
      { name: "_id", kind: "text" },
      { name: "id", kind: "text?" },
      { name: "keyword", kind: "text?" },
      { name: "reply", kind: "text?" },
      { name: "create_on", kind: "text?" },
    ],
  },
  user_keyword: {
    indexes: 3,
    orderBy: "_id",
    read: ["_id", "id", "author", "keyword", "reply", "anchor"],
    write: [
      { name: "_id", kind: "int" },
      { name: "id", kind: "text?" },
      { name: "author", kind: "text?" },
      { name: "keyword", kind: "text" },
      { name: "reply", kind: "text" },
      { name: "anchor", kind: "blank" },
    ],
  },
  user_settings: {
    indexes: 1,
    orderBy: "_id",
    read: ["_id", "group_id", "user_id", "options"],
    write: [
      { name: "group_id", kind: "scope" },
      { name: "user_id", kind: "scope" },
      { name: "options", kind: "options" },
    ],
  },
};

for (const table of IMPORT_TABLE_ORDER) {
  const spec = TABLE_SPEC[table];
  if (!spec.read.includes(spec.orderBy)) {
    throw new Error(`missing order column for ${table}`);
  }
  for (const column of spec.write) {
    if (!spec.read.includes(column.name)) {
      throw new Error(`missing read column for ${table}.${column.name}`);
    }
  }
}

export interface ImportRow {
  table: ImportTable;
  values: Record<string, string | number | null>;
}

export interface ImportBatch {
  batchId: string;
  rows: ImportRow[];
}

export interface ApplyResult {
  ok: true;
  duplicate: boolean;
  rows: number;
  writeUnits: number;
}

export class ImportBatchError extends Error {
  constructor() {
    super("invalid batch");
    this.name = "ImportBatchError";
  }
}

export interface TableTally {
  source: number;
  imported: number;
  skipped: number;
}

export function importGate(
  expected: string | undefined,
  presented: string | null,
): "disabled" | "reject" | "ok" {
  if (expected === undefined || expected.length === 0) return "disabled";
  // An empty header still runs the compare. Returning first would be faster than a wrong secret.
  return timingSafeEqual(expected, presented ?? "") ? "ok" : "reject";
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError("refusing to quote an unexpected identifier");
  }
  return `"${name}"`;
}

export function selectSql(table: ImportTable): string {
  const spec = TABLE_SPEC[table];
  const columns = spec.read.map(quoteIdent).join(", ");
  return `SELECT ${columns} FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(spec.orderBy)}`;
}

export function planSourceRow(
  table: ImportTable,
  raw: Record<string, unknown>,
): ImportRow | null {
  if (table === "user_settings" && emptyOptions(raw.options)) return null;
  const values: Record<string, string | number | null> = {};
  for (const column of TABLE_SPEC[table].write) {
    values[column.name] = coerceCell(column, raw[column.name]);
  }
  return { table, values };
}

export function parseImportBatch(input: unknown): ImportBatch {
  if (!isRecord(input)) throw new ImportBatchError();
  if (typeof input.batchId !== "string" || !/^[A-Za-z0-9:._-]{1,200}$/.test(input.batchId)) {
    throw new ImportBatchError();
  }
  if (!Array.isArray(input.rows) || input.rows.length > MAX_BATCH_ROWS) {
    throw new ImportBatchError();
  }
  const rows = input.rows.map(parseRow);
  return { batchId: input.batchId, rows };
}

export function batchWriteUnits(rows: readonly ImportRow[]): number {
  let units = BATCH_BOOKKEEPING_WRITES;
  for (const row of rows) units += 1 + TABLE_SPEC[row.table].indexes;
  return units;
}

export function estimateDays(writeUnits: number, dailyLimit: number): number {
  if (dailyLimit < 1) throw new TypeError("daily write limit must be positive");
  if (writeUnits <= 0) return 0;
  return Math.ceil(writeUnits / dailyLimit);
}

export function formulaLines(): string[] {
  const counts = IMPORT_TABLE_ORDER.map(
    (table) => `${table}=${TABLE_SPEC[table].indexes}`,
  ).join(" ");
  return [
    "write_units per row = 1 + index_count",
    `index_count ${counts}`,
    "user_keyword INTEGER PRIMARY KEY is the row itself and is not an index",
    "each posted batch also writes 2 rows for import_batches (the row and its primary key index)",
    "estimated_days = ceil(total_write_units / daily_write_limit)",
    "daily_write_limit default 80000 is the Free plan 100000 written rows minus about 7800 daily bot writes",
  ];
}

export function formatDryRun(
  tallies: { [K in ImportTable]: TableTally },
  batchSize: number,
  dailyLimit: number,
): string {
  const lines = formulaLines();
  let rowUnits = 0;
  let batches = 0;
  for (const table of IMPORT_TABLE_ORDER) {
    const tally = tallies[table];
    const units = tally.imported * (1 + TABLE_SPEC[table].indexes);
    const tableBatches = tally.imported === 0 ? 0 : Math.ceil(tally.imported / batchSize);
    rowUnits += units;
    batches += tableBatches;
    lines.push(
      `${table} source=${tally.source} import=${tally.imported} skipped=${tally.skipped} write_units=${units}`,
    );
  }
  const bookkeeping = batches * BATCH_BOOKKEEPING_WRITES;
  const total = rowUnits + bookkeeping;
  lines.push(`batches=${batches}`);
  lines.push(`bookkeeping_write_units=${bookkeeping}`);
  lines.push(`total_write_units=${total}`);
  lines.push(`daily_write_limit=${dailyLimit}`);
  lines.push(`estimated_days=${estimateDays(total, dailyLimit)}`);
  return lines.join("\n");
}

export function assertImportEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("endpoint must be an absolute URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("endpoint must not include a user, query, or hash");
  }
  if (url.pathname !== "/import") throw new Error("endpoint path must be /import");
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("endpoint must be https, or http on localhost");
  }
  return url;
}

function parseRow(input: unknown): ImportRow {
  if (!isRecord(input) || !isImportTable(input.table) || !isRecord(input.values)) {
    throw new ImportBatchError();
  }
  const planned = planSourceRow(input.table, input.values);
  if (planned === null) throw new ImportBatchError();
  return planned;
}

function coerceCell(column: ColumnSpec, value: unknown): string | number | null {
  switch (column.kind) {
    case "text":
      if (typeof value !== "string") throw new ImportBatchError();
      return value;
    case "text?":
      if (value === undefined || value === null) return null;
      if (typeof value !== "string") throw new ImportBatchError();
      return value;
    case "scope":
    case "blank":
      if (value === undefined || value === null) return "";
      if (typeof value !== "string") throw new ImportBatchError();
      return value;
    case "json":
      if (value === undefined || value === null || value === "") return "{}";
      if (typeof value !== "string") throw new ImportBatchError();
      return value;
    case "int":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new ImportBatchError();
      }
      return value;
    case "options":
      if (typeof value !== "string" || emptyOptions(value)) throw new ImportBatchError();
      return value;
  }
}

function emptyOptions(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "{}";
}

function isImportTable(value: unknown): value is ImportTable {
  return typeof value === "string" && (IMPORT_TABLE_ORDER as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
