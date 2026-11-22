export const EXPORT_TABLES = [
  "user",
  "group",
  "group_user",
  "user_settings",
  "user_keyword",
  "keywords_logs",
  "keyword_tombstone",
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];

export interface ExportPage {
  rows: Record<string, unknown>[];
  next: number | null;
}

export function parseExportPage(value: unknown): { table: ExportTable; after: number; limit: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("export page must be an object");
  }
  const record = value as Record<string, unknown>;
  const table = record.table;
  if (typeof table !== "string" || !isExportTable(table)) {
    throw new TypeError("unknown export table");
  }
  const after = record.after;
  const limit = record.limit;
  if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
    throw new TypeError("export cursor must be a non-negative integer");
  }
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("export limit must be 1..500");
  }
  return { table, after, limit };
}

function isExportTable(value: string): value is ExportTable {
  return (EXPORT_TABLES as readonly string[]).includes(value);
}

