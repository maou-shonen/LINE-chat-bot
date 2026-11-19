import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DAILY_WRITE_LIMIT,
  DEFAULT_BATCH_SIZE,
  IMPORT_SECRET_HEADER,
  IMPORT_TABLE_ORDER,
  MAX_BATCH_ROWS,
  assertImportEndpoint,
  batchWriteUnits,
  formatDryRun,
  planSourceRow,
  quoteIdent,
  selectSql,
  type ApplyResult,
  type ImportBatchError,
  type ImportRow,
  type ImportTable,
  type TableTally,
} from "../src/import-plan.ts";

interface Checkpoint {
  version: 1;
  source: string;
  batchSize: number;
  counts: Record<ImportTable, number>;
  offsets: Record<ImportTable, number>;
  utcDay: string;
  writesToday: number;
}

export interface ImportRunOptions {
  sqlitePath: string;
  dryRun: boolean;
  batchSize: number;
  dailyLimit: number;
  checkpointPath: string;
  endpoint?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  stdout: (line: string) => void;
}

export async function runImport(options: ImportRunOptions): Promise<"done" | "daily-limit"> {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error("batch size must be a positive integer");
  }
  if (options.batchSize > MAX_BATCH_ROWS) {
    throw new Error(`batch size must be at most ${MAX_BATCH_ROWS}`);
  }
  if (!Number.isSafeInteger(options.dailyLimit) || options.dailyLimit < 1) {
    throw new Error("daily write limit must be a positive integer");
  }
  const sqlitePath = resolve(options.sqlitePath);
  const checkpointPath = resolve(options.checkpointPath);
  if (sqlitePath === checkpointPath) {
    throw new Error("checkpoint path must differ from the sqlite file");
  }
  const now = options.now ?? (() => new Date());
  if (!options.dryRun) {
    if (options.endpoint === undefined) throw new Error("endpoint is required");
    assertImportEndpoint(options.endpoint);
    if (options.secret === undefined || options.secret.length === 0) {
      throw new Error("import secret is empty");
    }
  }

  const db = openReadOnly(sqlitePath);
  try {
    const counts = countAll(db);
    if (options.dryRun) {
      options.stdout(formatDryRun(scanAll(db), options.batchSize, options.dailyLimit));
      return "done";
    }
    const endpoint = options.endpoint;
    const secret = options.secret;
    if (endpoint === undefined || secret === undefined) {
      throw new Error("endpoint is required");
    }
    const checkpoint = loadCheckpoint(
      checkpointPath,
      sqlitePath,
      counts,
      options.batchSize,
      now(),
    );
    for (const table of IMPORT_TABLE_ORDER) {
      const status = await importTable({
        db,
        table,
        checkpoint,
        checkpointPath,
        batchSize: options.batchSize,
        dailyLimit: options.dailyLimit,
        endpoint,
        secret,
        fetchImpl: options.fetchImpl ?? fetch,
        now,
        stdout: options.stdout,
      });
      if (status === "daily-limit") {
        options.stdout(
          "stopped for the daily write limit. resume with the same checkpoint after 00:00 UTC.",
        );
        return "daily-limit";
      }
    }
    options.stdout("done");
    return "done";
  } finally {
    db.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const secret = args.dryRun ? undefined : process.env[args.secretEnv];
    if (!args.dryRun && (secret === undefined || secret.length === 0)) {
      throw new Error(`${args.secretEnv} is empty`);
    }
    await runImport({
      sqlitePath: args.sqlite,
      dryRun: args.dryRun,
      batchSize: args.batchSize,
      dailyLimit: args.dailyLimit,
      checkpointPath: args.checkpoint,
      endpoint: args.endpoint,
      secret,
      stdout: (line) => {
        console.log(line);
      },
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "import failed";
    console.error(message);
    return 1;
  }
}

interface ParsedArgs {
  sqlite: string;
  dryRun: boolean;
  batchSize: number;
  dailyLimit: number;
  checkpoint: string;
  endpoint?: string;
  secretEnv: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let sqlite: string | undefined;
  let dryRun = false;
  let batchSize = DEFAULT_BATCH_SIZE;
  let dailyLimit = DAILY_WRITE_LIMIT;
  let checkpoint = "import-checkpoint.json";
  let endpoint: string | undefined;
  let secretEnv = "IMPORT_SECRET";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    i++;
    if (arg === "--sqlite") sqlite = value;
    else if (arg === "--batch-size") batchSize = parsePositive(value, "batch size");
    else if (arg === "--daily-limit") dailyLimit = parsePositive(value, "daily write limit");
    else if (arg === "--checkpoint") checkpoint = value;
    else if (arg === "--endpoint") endpoint = value;
    else if (arg === "--secret-env") secretEnv = value;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (sqlite === undefined) throw new Error("--sqlite is required");
  if (!dryRun && endpoint === undefined) throw new Error("--endpoint is required");
  return { sqlite, dryRun, batchSize, dailyLimit, checkpoint, endpoint, secretEnv };
}

function parsePositive(value: string, label: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function importTable(input: {
  db: DatabaseSync;
  table: ImportTable;
  checkpoint: Checkpoint;
  checkpointPath: string;
  batchSize: number;
  dailyLimit: number;
  endpoint: string;
  secret: string;
  fetchImpl: typeof fetch;
  now: () => Date;
  stdout: (line: string) => void;
}): Promise<"done" | "daily-limit"> {
  const start = input.checkpoint.offsets[input.table];
  let batchStart = start;
  let cursor = start;
  let batch: ImportRow[] = [];
  let index = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const rows = batch;
    const end = cursor;
    const startOffset = batchStart;
    const batchId = `${input.table}:${startOffset}:${end}`;
    const result = await postBatch(
      input.fetchImpl,
      input.endpoint,
      input.secret,
      batchId,
      rows,
    );
    input.checkpoint.offsets[input.table] = end;
    input.checkpoint.writesToday += result.writeUnits;
    input.checkpoint.utcDay = utcDay(input.now());
    saveCheckpoint(input.checkpointPath, input.checkpoint);
    input.stdout(
      `posted ${input.table} ${startOffset} ${end} rows=${result.rows} write_units=${result.writeUnits} duplicate=${result.duplicate}`,
    );
    batch = [];
    batchStart = end;
  };

  for (const raw of sourceRows(input.db, input.table)) {
    const current = index;
    index++;
    if (current < start) continue;
    const today = utcDay(input.now());
    if (input.checkpoint.utcDay !== today) {
      input.checkpoint.utcDay = today;
      input.checkpoint.writesToday = 0;
    }
    const next = current + 1;
    let planned: ImportRow | null;
    try {
      planned = planSourceRow(input.table, raw);
    } catch (error) {
      if (isBatchError(error)) throw new Error(`${input.table} source index ${current} rejected`);
      throw error;
    }
    if (planned === null) {
      if (batch.length === 0) batchStart = next;
      cursor = next;
      continue;
    }
    const oneBatch = batchWriteUnits([planned]);
    if (oneBatch > input.dailyLimit) {
      throw new Error(`one ${input.table} row exceeds the daily write limit`);
    }
    const withRow = batchWriteUnits([...batch, planned]);
    if (input.checkpoint.writesToday + withRow > input.dailyLimit) {
      if (batch.length > 0) await flush();
      if (input.checkpoint.writesToday + oneBatch > input.dailyLimit) {
        if (input.checkpoint.offsets[input.table] !== cursor) {
          input.checkpoint.offsets[input.table] = cursor;
          saveCheckpoint(input.checkpointPath, input.checkpoint);
        }
        return "daily-limit";
      }
    }
    batch.push(planned);
    cursor = next;
    if (batch.length === input.batchSize) await flush();
  }
  await flush();
  if (input.checkpoint.offsets[input.table] !== cursor) {
    input.checkpoint.offsets[input.table] = cursor;
    saveCheckpoint(input.checkpointPath, input.checkpoint);
  }
  return "done";
}

async function postBatch(
  fetchImpl: typeof fetch,
  endpoint: string,
  secret: string,
  batchId: string,
  rows: ImportRow[],
): Promise<ApplyResult> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      [IMPORT_SECRET_HEADER]: secret,
    },
    body: JSON.stringify({ batchId, rows }),
  });
  if (!response.ok) throw new Error(`import endpoint returned ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("import endpoint returned an unreadable result");
  }
  if (
    !isRecord(body) ||
    body.ok !== true ||
    typeof body.duplicate !== "boolean" ||
    typeof body.rows !== "number" ||
    typeof body.writeUnits !== "number"
  ) {
    throw new Error("import endpoint returned an unreadable result");
  }
  return {
    ok: true,
    duplicate: body.duplicate,
    rows: body.rows,
    writeUnits: body.writeUnits,
  };
}

function scanAll(db: DatabaseSync): { [K in ImportTable]: TableTally } {
  const tallies = {} as { [K in ImportTable]: TableTally };
  for (const table of IMPORT_TABLE_ORDER) {
    let source = 0;
    let imported = 0;
    let skipped = 0;
    let index = 0;
    for (const raw of sourceRows(db, table)) {
      source++;
      try {
        const planned = planSourceRow(table, raw);
        if (planned === null) skipped++;
        else imported++;
      } catch (error) {
        if (isBatchError(error)) throw new Error(`${table} source index ${index} rejected`);
        throw error;
      }
      index++;
    }
    tallies[table] = { source, imported, skipped };
  }
  return tallies;
}

function loadCheckpoint(
  path: string,
  source: string,
  counts: Record<ImportTable, number>,
  batchSize: number,
  now: Date,
): Checkpoint {
  if (!existsSync(path)) {
    return {
      version: 1,
      source,
      batchSize,
      counts,
      offsets: zeroOffsets(),
      utcDay: utcDay(now),
      writesToday: 0,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("checkpoint is unreadable");
  }
  const checkpoint = parseCheckpoint(parsed);
  if (checkpoint.source !== source) {
    throw new Error("checkpoint belongs to a different sqlite file");
  }
  if (checkpoint.batchSize !== batchSize) {
    throw new Error(`checkpoint batch size is ${checkpoint.batchSize}`);
  }
  for (const table of IMPORT_TABLE_ORDER) {
    if (checkpoint.counts[table] !== counts[table]) {
      throw new Error("sqlite row counts changed. refuse to resume this checkpoint");
    }
    if ((checkpoint.offsets[table] ?? 0) > counts[table]) {
      throw new Error(`checkpoint offset for ${table} is past the table`);
    }
  }
  const today = utcDay(now);
  if (checkpoint.utcDay !== today) {
    checkpoint.utcDay = today;
    checkpoint.writesToday = 0;
  }
  return checkpoint;
}

function parseCheckpoint(value: unknown): Checkpoint {
  if (!isRecord(value) || value.version !== 1) throw new Error("checkpoint version is not 1");
  if (typeof value.source !== "string" || value.source.length === 0) {
    throw new Error("checkpoint source is invalid");
  }
  if (typeof value.utcDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.utcDay)) {
    throw new Error("checkpoint day is invalid");
  }
  return {
    version: 1,
    source: value.source,
    batchSize: nonNegativeInteger(value.batchSize, "batch size"),
    counts: countMap(value.counts, "counts"),
    offsets: countMap(value.offsets, "offsets"),
    utcDay: value.utcDay,
    writesToday: nonNegativeInteger(value.writesToday, "writes today"),
  };
}

function countMap(value: unknown, label: string): Record<ImportTable, number> {
  if (!isRecord(value)) throw new Error(`checkpoint ${label} is invalid`);
  const out = {} as Record<ImportTable, number>;
  for (const table of IMPORT_TABLE_ORDER) {
    out[table] = nonNegativeInteger(value[table], `${label} ${table}`);
  }
  return out;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`checkpoint ${label} is invalid`);
  }
  return value;
}

function zeroOffsets(): Record<ImportTable, number> {
  const offsets = {} as Record<ImportTable, number>;
  for (const table of IMPORT_TABLE_ORDER) offsets[table] = 0;
  return offsets;
}

function countAll(db: DatabaseSync): Record<ImportTable, number> {
  const counts = {} as Record<ImportTable, number>;
  for (const table of IMPORT_TABLE_ORDER) counts[table] = countRows(db, table);
  return counts;
}

function countRows(db: DatabaseSync, table: ImportTable): number {
  let row: unknown;
  try {
    row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("no such table")) throw new Error(`missing table ${table}`);
    throw error;
  }
  if (!isRecord(row)) throw new Error(`missing table ${table}`);
  const n = row.n;
  if (typeof n === "bigint") {
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${table} has too many rows`);
    return Number(n);
  }
  if (typeof n !== "number") throw new Error(`missing table ${table}`);
  return n;
}

function* sourceRows(db: DatabaseSync, table: ImportTable): Generator<Record<string, unknown>> {
  for (const row of db.prepare(selectSql(table)).iterate()) {
    yield plain(row);
  }
}

function plain(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") {
      if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
        throw new Error(`${key} integer is out of range`);
      }
      out[key] = Number(value);
      continue;
    }
    if (value instanceof Uint8Array) throw new Error(`${key} blob is not importable`);
    out[key] = value;
  }
  return out;
}

function openReadOnly(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`sqlite file cannot be opened read-only: ${message}`);
  }
}

function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isBatchError(error: unknown): error is ImportBatchError {
  return error instanceof Error && error.name === "ImportBatchError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "import failed";
      console.error(message);
      process.exit(1);
    });
}
