import {
  inspectSql,
  migrateSql,
  type SchemaSnapshot,
} from "./schema";
import { parseSettingsPatch, type SettingsKey, type SettingsPatch, type SettingsView } from "./settings";

export interface BotRepository {
  migrate(): Promise<void>;
  getSettings(key: SettingsKey): Promise<SettingsView>;
  upsertSettings(key: SettingsKey, patch: SettingsPatch): Promise<void>;
  countSettings(key: SettingsKey): Promise<number>;
  inspectSchema(): Promise<SchemaSnapshot>;
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
      if (Object.keys(next).length === 0) {
        if (current !== null) {
          this.storage.sql.exec(
            "DELETE FROM user_settings WHERE group_id = ? AND user_id = ?",
            key.groupId,
            key.userId,
          );
        }
        return;
      }
      const encoded = JSON.stringify(next);
      if (current === null) {
        this.storage.sql.exec(
          "INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)",
          key.groupId,
          key.userId,
          encoded,
        );
        return;
      }
      if (current.raw === encoded) return;
      this.storage.sql.exec(
        "UPDATE user_settings SET options = ? WHERE group_id = ? AND user_id = ?",
        encoded,
        key.groupId,
        key.userId,
      );
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("sql row was not an object");
  }
  return value as Record<string, unknown>;
}
