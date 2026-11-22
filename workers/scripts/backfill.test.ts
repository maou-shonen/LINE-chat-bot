import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { EXPORT_TABLES, type ExportTable } from "../src/export-tables.ts";
import { runBackfill } from "./backfill.ts";

const SCHEMA = `
CREATE TABLE user (id TEXT PRIMARY KEY NOT NULL, name TEXT, create_on TEXT, update_on TEXT);
CREATE TABLE "group" (id TEXT PRIMARY KEY NOT NULL, _id TEXT, _count TEXT, _setting TEXT, _admin TEXT, create_on TEXT, update_on TEXT);
CREATE TABLE group_user (_id INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT, uid TEXT, _count TEXT, _setting TEXT);
CREATE UNIQUE INDEX ux_group_user_gid_uid ON group_user(coalesce(gid, ''), coalesce(uid, ''));
CREATE TABLE keywords_logs (_id TEXT PRIMARY KEY NOT NULL, id TEXT, keyword TEXT, reply TEXT, create_on TEXT);
CREATE TABLE user_keyword (_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, author TEXT, keyword TEXT NOT NULL, reply TEXT NOT NULL, anchor TEXT NOT NULL DEFAULT '');
CREATE UNIQUE INDEX ux_user_keyword_id_keyword ON user_keyword(id, keyword);
CREATE TABLE user_settings (_id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT, user_id TEXT, options TEXT);
CREATE UNIQUE INDEX ux_user_settings_group_user ON user_settings(coalesce(group_id, ''), coalesce(user_id, ''));
`;

const PAGES: Record<ExportTable, Record<string, unknown>[]> = {
  user: [
    { id: "U1", name: "Old", create_on: null, update_on: "2024-06-01 00:00:00" },
    { id: "U2", name: "New", create_on: "2024-06-01 00:00:00", update_on: "2024-06-01 00:00:00" },
  ],
  group: [
    { id: "G1", _id: null, _count: '{"對話": 1}', _setting: "{}", _admin: "{}", create_on: null, update_on: "2024-06-01 00:00:00" },
    { id: "G2", _id: "uuid2", _count: '{"對話": 1}', _setting: "{}", _admin: "{}", create_on: "2024-06-01 00:00:00", update_on: "2024-06-01 00:00:00" },
  ],
  group_user: [
    { gid: "G2", uid: "U2", _count: '{"對話": 1}', _setting: "{}" },
    { gid: "G4", uid: "U4", _count: '{"對話": 2}', _setting: "{}" },
  ],
  user_settings: [{ group_id: "G1", user_id: "U1", options: '{"全回應": false}' }],
  user_keyword: [
    { id: "G1", author: "U1", keyword: "kbase", reply: "changed", anchor: "kbase" },
    { id: "G1", author: "U1", keyword: "knew", reply: "new", anchor: "knew" },
  ],
  keywords_logs: [
    { _id: "log1", id: "G1", keyword: "knew", reply: "new", create_on: "2024-06-01 00:00:00" },
  ],
  keyword_tombstone: [
    { id: "G1", keyword: "kdel" },
    { id: null, keyword: "gdel" },
  ],
  group_user_tombstone: [
    { gid: "G1", uid: "U1" },
    { gid: "G3", uid: "" },
  ],
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("backfill apply", () => {
  it("upserts changed rows, deletes tombstones, and is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-"));
    dirs.push(dir);
    const path = join(dir, "line.db");
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    seed(db);
    const before = ids(db);
    db.close();

    const first = await apply(path);
    assert.deepEqual(first, {
      user: 2,
      group: 2,
      group_user: 2,
      user_settings: 1,
      user_keyword: 2,
      keywords_logs: 1,
      keyword_tombstone: 2,
      group_user_tombstone: 2,
    });

    const after = new DatabaseSync(path);
    try {
      const u1 = after.prepare("SELECT * FROM user WHERE id = 'U1'").get();
      assert.equal(u1?.name, "Old");
      assert.equal(u1?.create_on, "2019-01-01 00:00:00");
      assert.equal(u1?.update_on, "2024-06-01 00:00:00");
      assert.equal(after.prepare("SELECT name FROM user WHERE id = 'U2'").get()?.name, "New");
      assert.equal(after.prepare("SELECT name FROM user WHERE id = 'U9'").get()?.name, "keep");

      const g1 = after.prepare('SELECT * FROM "group" WHERE id = ?').get("G1");
      assert.equal(g1?._id, "legacy");
      assert.equal(g1?._count, '{"對話": 1}');
      assert.equal(g1?.update_on, "2024-06-01 00:00:00");
      assert.equal(after.prepare('SELECT _count FROM "group" WHERE id = ?').get("G9")?._count, '{"舊":1}');

      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM group_user WHERE COALESCE(gid, '') = 'G1'").get()?.n, 0);
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM group_user WHERE COALESCE(gid, '') = 'G3'").get()?.n, 0);
      assert.equal(
        after.prepare("SELECT _count FROM group_user WHERE COALESCE(gid, '') = 'G2' AND COALESCE(uid, '') = 'U2'").get()
          ?._count,
        '{"對話": 1}',
      );
      assert.equal(
        after.prepare("SELECT _id FROM group_user WHERE COALESCE(gid, '') = 'G4' AND COALESCE(uid, '') = 'U4'").get()
          ?._id,
        before.member,
      );
      assert.equal(
        after.prepare("SELECT _count FROM group_user WHERE COALESCE(gid, '') = 'G4' AND COALESCE(uid, '') = 'U4'").get()
          ?._count,
        '{"對話": 2}',
      );
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM group_user").get()?.n, 3);
      assert.equal(
        after.prepare("SELECT _count FROM group_user WHERE COALESCE(gid, '') = 'G9' AND COALESCE(uid, '') = 'U9'").get()
          ?._count,
        '{"舊":1}',
      );

      assert.equal(after.prepare("SELECT _id FROM user_settings WHERE group_id = 'G1'").get()?._id, before.settings);
      assert.equal(after.prepare("SELECT options FROM user_settings WHERE group_id = 'G1'").get()?.options, '{"全回應": false}');
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM user_settings").get()?.n, 2);

      assert.equal(after.prepare("SELECT _id FROM user_keyword WHERE keyword = 'kbase'").get()?._id, before.keyword);
      assert.equal(after.prepare("SELECT reply FROM user_keyword WHERE keyword = 'kbase'").get()?.reply, "changed");
      assert.equal(after.prepare("SELECT author FROM user_keyword WHERE keyword = 'kbase'").get()?.author, "U1");
      assert.equal(after.prepare("SELECT reply FROM user_keyword WHERE keyword = 'knew'").get()?.reply, "new");
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM user_keyword WHERE keyword IN ('kdel', 'gdel')").get()?.n, 0);
      assert.equal(after.prepare("SELECT reply FROM user_keyword WHERE keyword = 'keepme'").get()?.reply, "keep");

      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM keywords_logs").get()?.n, 1);
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM user").get()?.n, 3);
      assert.equal(after.prepare('SELECT COUNT(*) AS n FROM "group"').get()?.n, 3);
    } finally {
      after.close();
    }

    const second = await apply(path);
    assert.deepEqual(second, first);
    const again = new DatabaseSync(path);
    try {
      assert.equal(again.prepare("SELECT COUNT(*) AS n FROM user").get()?.n, 3);
      assert.equal(again.prepare("SELECT COUNT(*) AS n FROM user_keyword").get()?.n, 3);
      assert.equal(again.prepare("SELECT _id FROM user_keyword WHERE keyword = 'kbase'").get()?._id, before.keyword);
      assert.equal(again.prepare("SELECT COUNT(*) AS n FROM group_user").get()?.n, 3);
      assert.equal(
        again.prepare("SELECT COUNT(*) AS n FROM group_user WHERE COALESCE(gid, '') IN ('G1', 'G3')").get()?.n,
        0,
      );
      assert.equal(
        again.prepare("SELECT _id FROM group_user WHERE COALESCE(gid, '') = 'G4' AND COALESCE(uid, '') = 'U4'").get()
          ?._id,
        before.member,
      );
    } finally {
      again.close();
    }
  });

  it("rejects a non-export endpoint and an empty secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "backfill-"));
    dirs.push(dir);
    const path = join(dir, "line.db");
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    db.close();
    await assert.rejects(() =>
      runBackfill({ endpoint: "http://localhost/import/kv", sqlitePath: path, secret: "s", stdout: () => undefined }),
    );
    await assert.rejects(() =>
      runBackfill({ endpoint: "http://localhost/export", sqlitePath: path, secret: "", stdout: () => undefined }),
    );
  });
});

async function apply(path: string): Promise<Record<ExportTable, number>> {
  const lines: string[] = [];
  const result = await runBackfill({
    endpoint: "http://localhost/export",
    sqlitePath: path,
    secret: "secret",
    limit: 1,
    stdout: (line) => lines.push(line),
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-import-secret"), "secret");
      const body = JSON.parse(String(init?.body)) as { table: ExportTable; after: number; limit: number };
      assert.ok(EXPORT_TABLES.includes(body.table));
      const rows = PAGES[body.table];
      const slice = rows.slice(body.after, body.after + body.limit);
      const next = body.after + body.limit < rows.length ? body.after + body.limit : null;
      return Response.json({ rows: slice, next });
    },
  });
  assert.equal(lines.join("\n"), EXPORT_TABLES.map((table) => `${table}=${result[table]}`).join("\n"));
  return result;
}

function seed(db: DatabaseSync): void {
  db.prepare("INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, ?, ?)").run(
    "U1",
    "Old",
    "2019-01-01 00:00:00",
    "2019-01-02 00:00:00",
  );
  db.prepare("INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, ?, ?)").run(
    "U9",
    "keep",
    null,
    null,
  );
  db.prepare(
    'INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run("G1", "legacy", '{"文字": 5}', "{}", "{}", "2019-01-01 00:00:00", "2019-01-02 00:00:00");
  db.prepare(
    'INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run("G9", "legacy9", '{"舊":1}', "{}", "{}", null, null);
  db.prepare("INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?)").run(
    "G1",
    "U1",
    '{"文字": 1}',
    "{}",
  );
  db.prepare("INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?)").run(
    "G3",
    "U3",
    '{"舊":1}',
    "{}",
  );
  db.prepare("INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?)").run(
    "G3",
    "U4",
    '{"舊":1}',
    "{}",
  );
  db.prepare("INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?)").run(
    "G4",
    "U4",
    '{"舊":1}',
    "{}",
  );
  db.prepare("INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?)").run(
    "G9",
    "U9",
    '{"舊":1}',
    "{}",
  );
  db.prepare("INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)").run(
    "G1",
    "U1",
    '{"a": 1}',
  );
  db.prepare("INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)").run(
    "G9",
    "U9",
    '{"舊":1}',
  );
  db.prepare("INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)").run(
    "G1",
    "U1",
    "kbase",
    "base",
    "kbase",
  );
  db.prepare("INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)").run(
    "G1",
    "U1",
    "kdel",
    "gone",
    "kdel",
  );
  db.prepare("INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)").run(
    null,
    null,
    "gdel",
    "gone",
    "gdel",
  );
  db.prepare("INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)").run(
    "G1",
    "U1",
    "keepme",
    "keep",
    "keepme",
  );
}

function ids(db: DatabaseSync): { member: number; settings: number; keyword: number } {
  return {
    member: Number(
      db.prepare("SELECT _id FROM group_user WHERE COALESCE(gid, '') = 'G4' AND COALESCE(uid, '') = 'U4'").get()?._id,
    ),
    settings: Number(db.prepare("SELECT _id FROM user_settings WHERE group_id = 'G1'").get()?._id),
    keyword: Number(db.prepare("SELECT _id FROM user_keyword WHERE keyword = 'kbase'").get()?._id),
  };
}
