export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKey: number;
}

export interface IndexInfo {
  name: string;
  sql: string | null;
}

export interface SchemaSnapshot {
  tables: string[];
  indexes: IndexInfo[];
  columns: Record<string, ColumnInfo[]>;
  migrationVersion: number | null;
}

const V1 = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT,
    create_on TEXT,
    update_on TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS "group" (
    id TEXT PRIMARY KEY NOT NULL,
    _id TEXT,
    _count TEXT NOT NULL DEFAULT '{}',
    _setting TEXT NOT NULL DEFAULT '{}',
    _admin TEXT NOT NULL DEFAULT '{}',
    create_on TEXT,
    update_on TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS group_user (
    gid TEXT NOT NULL DEFAULT '',
    uid TEXT NOT NULL DEFAULT '',
    _count TEXT NOT NULL DEFAULT '{}',
    _setting TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (gid, uid)
  )`,
  `CREATE TABLE IF NOT EXISTS keywords_logs (
    _id TEXT PRIMARY KEY NOT NULL,
    id TEXT,
    keyword TEXT,
    reply TEXT,
    create_on TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS user_keyword (
    _id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT,
    author TEXT,
    keyword TEXT NOT NULL,
    reply TEXT NOT NULL,
    anchor TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS ix_user_keyword_anchor
    ON user_keyword(anchor)`,
  `CREATE INDEX IF NOT EXISTS ix_user_keyword_anchor_len
    ON user_keyword(length(anchor))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_user_keyword_id_keyword
    ON user_keyword(id, keyword)`,
  `CREATE TABLE IF NOT EXISTS user_settings (
    group_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
  )`,
];

const V2 = [
  `CREATE TABLE IF NOT EXISTS cold_group (
    id TEXT PRIMARY KEY NOT NULL,
    cursor INTEGER NOT NULL,
    members INTEGER NOT NULL,
    done INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cold_user (
    id TEXT PRIMARY KEY NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cold_omit (
    gid TEXT NOT NULL,
    uid TEXT NOT NULL,
    PRIMARY KEY (gid, uid)
  )`,
];

const MIGRATIONS = [V1, V2];

const INSPECT_TABLES = [
  "user",
  "group",
  "group_user",
  "keywords_logs",
  "user_keyword",
  "user_settings",
];

export function migrateSql(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL
    )`,
  );
  MIGRATIONS.forEach((statements, index) => {
    const version = index + 1;
    const applied = rows(
      sql,
      "SELECT version FROM schema_migrations WHERE version = ?",
      version,
    );
    if (applied.length > 0) return;
    for (const statement of statements) sql.exec(statement);
    sql.exec("INSERT INTO schema_migrations (version) VALUES (?)", version);
  });
}

export function inspectSql(sql: SqlStorage): SchemaSnapshot {
  const tables = rows(
    sql,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).map((row) => requiredString(row, "name"));
  const indexes = rows(
    sql,
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name",
  ).map((row) => ({
    name: requiredString(row, "name"),
    sql: optionalString(row, "sql"),
  }));
  const columns: Record<string, ColumnInfo[]> = {};
  for (const table of INSPECT_TABLES) {
    columns[table] = rows(sql, `PRAGMA table_info(${quoteIdent(table)})`).map(
      (row) => ({
        name: requiredString(row, "name"),
        type: requiredString(row, "type"),
        notNull: requiredNumber(row, "notnull") === 1,
        defaultValue: optionalString(row, "dflt_value"),
        primaryKey: requiredNumber(row, "pk"),
      }),
    );
  }
  const versions = rows(
    sql,
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
  );
  const versionRow = versions[0];
  return {
    tables,
    indexes,
    columns,
    migrationVersion:
      versionRow === undefined ? null : requiredNumber(versionRow, "version"),
  };
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError("refusing to quote an unexpected identifier");
  }
  return `"${name}"`;
}

function rows(
  sql: SqlStorage,
  query: string,
  ...bindings: Array<string | number | null>
): Record<string, unknown>[] {
  return sql.exec(query, ...bindings).toArray().map(asRecord);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sql row was not an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`${key} was not a string`);
  }
  return value;
}

function optionalString(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${key} was not a string`);
  }
  return value;
}

function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new TypeError(`${key} was not a number`);
  }
  return value;
}
