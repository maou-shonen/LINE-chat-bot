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

export interface BotRepository {
  migrate(): Promise<void>;
  getSettings(key: SettingsKey): Promise<SettingsView>;
  upsertSettings(key: SettingsKey, patch: SettingsPatch): Promise<void>;
  omitSettings(key: SettingsKey, names: readonly string[]): Promise<void>;
  countSettings(key: SettingsKey): Promise<number>;
  inspectSchema(): Promise<SchemaSnapshot>;
  touchAndCount(input: TouchAndCount): Promise<void>;
  inspectTouch(): Promise<TouchRows>;
}

export class SqliteBotRepository implements BotRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  async migrate(): Promise<void> {
    this.storage.transactionSync(() => {
      migrateSql(this.storage.sql);
    });
  }

  async getSettings(key: SettingsKey): Promise<SettingsView> {
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
    this.storage.transactionSync(() => {
      const current = readOptions(this.storage.sql, key);
      const next = { ...(current?.options ?? {}), ...patch };
      writeOptions(this.storage.sql, key, current, next);
    });
  }

  async omitSettings(key: SettingsKey, names: readonly string[]): Promise<void> {
    this.storage.transactionSync(() => {
      const current = readOptions(this.storage.sql, key);
      if (current === null) return;
      const next = { ...current.options };
      for (const name of names) delete next[name];
      writeOptions(this.storage.sql, key, current, next);
    });
  }

  async countSettings(key: SettingsKey): Promise<number> {
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
    this.storage.transactionSync(() => {
      writeTouch(this.storage.sql, input);
    });
  }

  async inspectTouch(): Promise<TouchRows> {
    return readTouch(this.storage.sql);
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
  const encoded = JSON.stringify(next);
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

export interface TouchAndCount {
  source: CountSource;
  now: string;
  delta: CountMap;
}

export interface TouchUser {
  id: string;
  name: string | null;
  createOn: string | null;
  updateOn: string | null;
}

export interface TouchGroup {
  id: string;
  createOn: string | null;
  updateOn: string | null;
}

export interface TouchRows {
  users: TouchUser[];
  groups: TouchGroup[];
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
  const row = sql
    .exec("SELECT _count FROM group_user WHERE gid = ? AND uid = ?", gid, uid)
    .toArray()[0];
  if (row === undefined) return {};
  const raw = asRecord(row)._count;
  if (typeof raw !== "string") throw new TypeError("group_user._count was not text");
  return parseCountMap(raw);
}

function readTouch(sql: SqlStorage): TouchRows {
  const users = sql
    .exec("SELECT id, name, create_on, update_on FROM user ORDER BY id")
    .toArray()
    .map((row) => {
      const record = asRecord(row);
      return {
        id: requiredText(record, "id"),
        name: optionalText(record, "name"),
        createOn: optionalText(record, "create_on"),
        updateOn: optionalText(record, "update_on"),
      };
    });
  const groups = sql
    .exec(`SELECT id, create_on, update_on FROM "group" ORDER BY id`)
    .toArray()
    .map((row) => {
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
