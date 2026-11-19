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
  countSettings(key: SettingsKey): Promise<number>;
  inspectSchema(): Promise<SchemaSnapshot>;
  touchAndCount(input: TouchAndCount): Promise<void>;
  inspectTouch(): Promise<TouchRows>;
  upsertKeyword(input: KeywordWrite): Promise<KeywordWriteStatus>;
  deleteKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus>;
  getKeyword(input: KeywordLookup): Promise<string | null>;
  listKeywords(scopeId: string | null): Promise<string[]>;
  inspectKeywords(): Promise<KeywordSnapshot>;
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

  async touchAndCount(input: TouchAndCount): Promise<void> {
    this.storage.transactionSync(() => {
      writeTouch(this.storage.sql, input);
    });
  }

  async inspectTouch(): Promise<TouchRows> {
    return readTouch(this.storage.sql);
  }

  async upsertKeyword(input: KeywordWrite): Promise<KeywordWriteStatus> {
    let status: KeywordWriteStatus = "written";
    this.storage.transactionSync(() => {
      const existing = readKeywordRow(this.storage.sql, input.scopeId, input.keyword);
      if (existing !== null && isProtectedReply(existing.reply) && existing.author !== input.author) {
        status = "protected";
        return;
      }
      const anchor = anchorOf(input.keyword);
      const reply = existing !== null && input.plus ? `${input.reply}__${existing.reply}` : input.reply;
      if (existing === null) {
        this.storage.sql.exec(
          "INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)",
          input.scopeId,
          input.author,
          input.keyword,
          reply,
          anchor,
        );
      } else {
        this.storage.sql.exec(
          "UPDATE user_keyword SET author = ?, reply = ?, anchor = ? WHERE _id = ?",
          input.author,
          reply,
          anchor,
          existing.id,
        );
      }
      if (input.scopeId !== null) {
        this.storage.sql.exec(
          "INSERT INTO keywords_logs (_id, id, keyword, reply, create_on) VALUES (?, ?, ?, ?, ?)",
          crypto.randomUUID(),
          input.scopeId,
          input.keyword,
          input.reply,
          input.now,
        );
      }
    });
    return status;
  }

  async deleteKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus> {
    let status: KeywordDeleteStatus = "missing";
    this.storage.transactionSync(() => {
      const existing = readKeywordRow(this.storage.sql, input.scopeId, input.keyword);
      if (existing === null) return;
      if (isProtectedReply(existing.reply) && existing.author !== input.author) {
        status = "protected";
        return;
      }
      this.storage.sql.exec("DELETE FROM user_keyword WHERE _id = ?", existing.id);
      status = "deleted";
    });
    return status;
  }

  async getKeyword(input: KeywordLookup): Promise<string | null> {
    return readKeywordRow(this.storage.sql, input.scopeId, input.keyword)?.reply ?? null;
  }

  async listKeywords(scopeId: string | null): Promise<string[]> {
    const scope = keywordScope(scopeId);
    return this.storage.sql
      .exec(`SELECT keyword FROM user_keyword WHERE ${scope.clause} ORDER BY _id`, ...scope.binds)
      .toArray()
      .map((row) => requiredText(asRecord(row), "keyword"));
  }

  async inspectKeywords(): Promise<KeywordSnapshot> {
    return readKeywords(this.storage.sql);
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
export interface KeywordWrite {
  scopeId: string | null;
  author: string | null;
  keyword: string;
  reply: string;
  plus: boolean;
  now: string;
}

export interface KeywordDelete {
  scopeId: string | null;
  author: string | null;
  keyword: string;
}

export interface KeywordLookup {
  scopeId: string | null;
  keyword: string;
}

export type KeywordWriteStatus = "written" | "protected";
export type KeywordDeleteStatus = "deleted" | "missing" | "protected";

export interface StoredKeyword {
  scopeId: string | null;
  author: string | null;
  keyword: string;
  reply: string;
  anchor: string;
}

export interface StoredKeywordLog {
  scopeId: string | null;
  keyword: string | null;
  reply: string | null;
  createOn: string | null;
}

export interface KeywordSnapshot {
  keywords: StoredKeyword[];
  logs: StoredKeywordLog[];
}

export function isProtectedReply(reply: string): boolean {
  const at = reply.lastIndexOf("##");
  return at >= 0 && reply.slice(at).includes("保護");
}

export function parseKeywordWrite(value: unknown): KeywordWrite {
  const record = objectRecord(value, "keyword write");
  return {
    scopeId: optionalId(record.scopeId, "scopeId"),
    author: optionalId(record.author, "author"),
    keyword: requiredString(record.keyword, "keyword"),
    reply: requiredString(record.reply, "reply"),
    plus: requiredBoolean(record.plus),
    now: requiredNow(record.now),
  };
}

export function parseKeywordDelete(value: unknown): KeywordDelete {
  const record = objectRecord(value, "keyword delete");
  return {
    scopeId: optionalId(record.scopeId, "scopeId"),
    author: optionalId(record.author, "author"),
    keyword: requiredString(record.keyword, "keyword"),
  };
}

export function parseKeywordLookup(value: unknown): KeywordLookup {
  const record = objectRecord(value, "keyword lookup");
  return {
    scopeId: optionalId(record.scopeId, "scopeId"),
    keyword: requiredString(record.keyword, "keyword"),
  };
}

export function parseScopeId(value: unknown): string | null {
  return optionalId(value, "scopeId");
}

interface KeywordExisting {
  id: number;
  author: string | null;
  reply: string;
}

function keywordScope(scopeId: string | null): { clause: string; binds: string[] } {
  if (scopeId === null) return { clause: "id IS NULL", binds: [] };
  return { clause: "id = ?", binds: [scopeId] };
}

function readKeywordRow(sql: SqlStorage, scopeId: string | null, keyword: string): KeywordExisting | null {
  const scope = keywordScope(scopeId);
  const row = sql
    .exec(
      `SELECT _id, author, reply FROM user_keyword WHERE ${scope.clause} AND keyword = ? ORDER BY _id LIMIT 1`,
      ...scope.binds,
      keyword,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const record = asRecord(row);
  const id = record._id;
  if (typeof id !== "number") throw new TypeError("user_keyword._id was not a number");
  return { id, author: optionalText(record, "author"), reply: requiredText(record, "reply") };
}

function readKeywords(sql: SqlStorage): KeywordSnapshot {
  const keywords = sql
    .exec("SELECT id, author, keyword, reply, anchor FROM user_keyword ORDER BY _id")
    .toArray()
    .map((row) => {
      const record = asRecord(row);
      return {
        scopeId: optionalText(record, "id"),
        author: optionalText(record, "author"),
        keyword: requiredText(record, "keyword"),
        reply: requiredText(record, "reply"),
        anchor: requiredText(record, "anchor"),
      };
    });
  const logs = sql
    .exec("SELECT id, keyword, reply, create_on FROM keywords_logs ORDER BY rowid")
    .toArray()
    .map((row) => {
      const record = asRecord(row);
      return {
        scopeId: optionalText(record, "id"),
        keyword: optionalText(record, "keyword"),
        reply: optionalText(record, "reply"),
        createOn: optionalText(record, "create_on"),
      };
    });
  return { keywords, logs };
}

// shortcut: JS length is UTF-16 units, upgrade when a keyword contains a non-BMP character
function anchorOf(keyword: string): string {
  let best = "";
  for (const piece of keyword.split("**")) {
    if (piece.length > best.length) best = piece;
  }
  return best;
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalId(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string or null`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("plus must be a boolean");
  return value;
}

function requiredNow(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("now must be a non-empty string");
  }
  return value;
}
