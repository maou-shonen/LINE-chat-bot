import {
  IMPORT_TABLE_ORDER,
  TABLE_SPEC,
  batchWriteUnits,
  quoteIdent,
  type ApplyResult,
  type ImportBatch,
  type ImportRow,
  type ImportTable,
} from "./import-plan";

const INSERT_SQL = Object.fromEntries(
  IMPORT_TABLE_ORDER.map((table) => [table, insertSql(table)]),
) as { [K in ImportTable]: string };

export function applyImportBatch(sql: SqlStorage, batch: ImportBatch): ApplyResult {
  // shortcut: first-batch CREATE TABLE is outside the write estimate, upgrade when the remaining daily quota is under a few hundred rows
  sql.exec(
    `CREATE TABLE IF NOT EXISTS import_batches (
      batch_id TEXT PRIMARY KEY NOT NULL,
      row_count INTEGER NOT NULL,
      write_units INTEGER NOT NULL
    )`,
  );
  const existing = sql
    .exec("SELECT write_units FROM import_batches WHERE batch_id = ?", batch.batchId)
    .toArray();
  const prior = existing[0];
  if (prior !== undefined) {
    return {
      ok: true,
      duplicate: true,
      rows: 0,
      writeUnits: requiredNumber(prior, "write_units"),
    };
  }
  for (const row of batch.rows) insertRow(sql, row);
  const writeUnits = batchWriteUnits(batch.rows);
  sql.exec(
    "INSERT INTO import_batches (batch_id, row_count, write_units) VALUES (?, ?, ?)",
    batch.batchId,
    batch.rows.length,
    writeUnits,
  );
  return { ok: true, duplicate: false, rows: batch.rows.length, writeUnits };
}

function insertRow(sql: SqlStorage, row: ImportRow): void {
  const values = TABLE_SPEC[row.table].write.map((column) => {
    const value = row.values[column.name];
    if (value === undefined) throw new TypeError(`missing ${row.table}.${column.name}`);
    return value;
  });
  sql.exec(INSERT_SQL[row.table], ...values);
}

function insertSql(table: ImportTable): string {
  const columns = TABLE_SPEC[table].write.map((column) => quoteIdent(column.name));
  const marks = columns.map(() => "?").join(", ");
  return `INSERT INTO ${quoteIdent(table)} (${columns.join(", ")}) VALUES (${marks})`;
}

function requiredNumber(value: unknown, key: string): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sql row was not an object");
  }
  const number = (value as Record<string, unknown>)[key];
  if (typeof number !== "number") throw new TypeError(`${key} was not a number`);
  return number;
}
