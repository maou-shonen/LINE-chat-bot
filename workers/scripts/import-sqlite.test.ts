import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { assertImportEndpoint, batchWriteUnits, type ImportRow } from "../src/import-plan.ts";
import { runImport, type ImportRunOptions } from "./import-sqlite.ts";

const SCHEMA = `
CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  create_on TEXT,
  update_on TEXT
);
CREATE TABLE "group" (
  id TEXT PRIMARY KEY NOT NULL,
  _id TEXT,
  _count TEXT,
  _setting TEXT,
  _admin TEXT,
  create_on TEXT,
  update_on TEXT
);
CREATE TABLE group_user (
  _id INTEGER PRIMARY KEY,
  gid TEXT,
  uid TEXT,
  _count TEXT,
  _setting TEXT
);
CREATE TABLE keywords_logs (
  _id TEXT PRIMARY KEY NOT NULL,
  id TEXT,
  keyword TEXT,
  reply TEXT,
  create_on TEXT
);
CREATE TABLE user_keyword (
  _id INTEGER PRIMARY KEY,
  id TEXT,
  author TEXT,
  keyword TEXT NOT NULL,
  reply TEXT NOT NULL,
  anchor TEXT
);
CREATE TABLE user_settings (
  _id INTEGER PRIMARY KEY,
  group_id TEXT,
  user_id TEXT,
  options TEXT
);
`;

function createDb(path: string, seed: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  seed(db);
  db.close();
}

function seedSmall(path: string): void {
  createDb(path, (db) => {
    db.prepare("INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, ?, ?)").run(
      "U1",
      null,
      null,
      null,
    );
    db.prepare("INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, ?, ?)").run(
      "U2",
      "name",
      "2020-01-01",
      "2020-01-02",
    );
    db.prepare(
      'INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run("G1", "uuid", null, "{}", "{}", null, null);
    db.prepare("INSERT INTO group_user (_id, gid, uid, _count, _setting) VALUES (?, ?, ?, ?, ?)").run(
      1,
      null,
      "U1",
      null,
      null,
    );
    db.prepare("INSERT INTO group_user (_id, gid, uid, _count, _setting) VALUES (?, ?, ?, ?, ?)").run(
      2,
      "G1",
      "U1",
      "{}",
      "{}",
    );
    db.prepare(
      "INSERT INTO keywords_logs (_id, id, keyword, reply, create_on) VALUES (?, ?, ?, ?, ?)",
    ).run("log-1", "G1", "k", "reply", null);
    const keyword = db.prepare(
      "INSERT INTO user_keyword (_id, id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?, ?)",
    );
    keyword.run(1, null, "A", "same", "one", null);
    keyword.run(2, null, "A", "same", "two", "same");
    keyword.run(3, "G1", "A", "other", "three", "other");
    const settings = db.prepare(
      "INSERT INTO user_settings (_id, group_id, user_id, options) VALUES (?, ?, ?, ?)",
    );
    settings.run(1, "G1", "U1", "{}");
    settings.run(2, null, "U1", null);
    settings.run(3, "G1", "U2", '{"暫停": true}');
  });
}

function seedUsers(path: string, count: number): void {
  createDb(path, (db) => {
    const insert = db.prepare(
      "INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < count; i++) insert.run(`U${i}`, null, null, null);
  });
}

function baseOptions(dir: string, sqliteName: string): ImportRunOptions {
  return {
    sqlitePath: join(dir, sqliteName),
    dryRun: false,
    batchSize: 200,
    dailyLimit: 80_000,
    checkpointPath: join(dir, "checkpoint.json"),
    endpoint: "http://127.0.0.1/import",
    secret: "test-import-secret",
    stdout: () => undefined,
  };
}

describe("sqlite import", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), "import-"));
    dirs.push(dir);
    return dir;
  }

  it("dry-run counts transformed rows and does not write a checkpoint", async () => {
    const dir = temp();
    const options = baseOptions(dir, "bot.db");
    seedSmall(options.sqlitePath);
    const lines: string[] = [];
    const status = await runImport({
      ...options,
      dryRun: true,
      stdout: (line) => lines.push(line),
    });
    const text = lines.join("\n");
    assert.equal(status, "done");
    assert.match(text, /index_count user_keyword=3 user_settings=1 group=1 group_user=1 user=1 keywords_logs=1/);
    assert.match(text, /user source=2 import=2 skipped=0 write_units=4/);
    assert.match(text, /group source=1 import=1 skipped=0 write_units=2/);
    assert.match(text, /group_user source=2 import=2 skipped=0 write_units=4/);
    assert.match(text, /keywords_logs source=1 import=1 skipped=0 write_units=2/);
    assert.match(text, /user_keyword source=3 import=3 skipped=0 write_units=12/);
    assert.match(text, /user_settings source=3 import=1 skipped=2 write_units=2/);
    assert.match(text, /batches=6/);
    assert.match(text, /bookkeeping_write_units=12/);
    assert.match(text, /total_write_units=38/);
    assert.match(text, /estimated_days=1/);
    assert.equal(existsSync(options.checkpointPath), false);
  });

  it("posts transformed rows and leaves secrets and keyword text off stdout", async () => {
    const dir = temp();
    const options = baseOptions(dir, "bot.db");
    seedSmall(options.sqlitePath);
    const bodies: Array<{ batchId: string; rows: ImportRow[] }> = [];
    const lines: string[] = [];
    await runImport({
      ...options,
      batchSize: 100,
      stdout: (line) => lines.push(line),
      fetchImpl: async (_input, init) => {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("x-import-secret"), options.secret);
        const body = JSON.parse(String(init?.body)) as { batchId: string; rows: ImportRow[] };
        bodies.push(body);
        return Response.json({
          ok: true,
          duplicate: false,
          rows: body.rows.length,
          writeUnits: batchWriteUnits(body.rows),
        });
      },
    });
    const keywords = bodies.find((body) => body.batchId.startsWith("user_keyword:"));
    assert.equal(keywords?.rows.filter((row) => row.values.id === null).length, 2);
    assert.equal(keywords?.rows[0]?.values.anchor, "");
    const groups = bodies.find((body) => body.batchId.startsWith("group:"));
    assert.equal(groups?.rows[0]?.values._count, "{}");
    const settings = bodies.find((body) => body.batchId.startsWith("user_settings:"));
    assert.equal(settings?.rows.length, 1);
    assert.equal(settings?.rows[0]?.values.options, '{"暫停": true}');
    const members = bodies.find((body) => body.batchId.startsWith("group_user:"));
    assert.equal(members?.rows.some((row) => row.values.gid === "" && row.values.uid === "U1"), true);
    assert.equal(JSON.stringify(members).includes('"_id"'), false);
    const text = lines.join("\n");
    assert.equal(text.includes("test-import-secret"), false);
    assert.equal(text.includes("same"), false);
    assert.equal(text.includes("暫停"), false);
  });

  it("resumes after a failed batch and refuses a different batch size", async () => {
    const dir = temp();
    const options = baseOptions(dir, "users.db");
    seedUsers(options.sqlitePath, 4);
    const posted: string[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { batchId: string; rows: ImportRow[] };
      posted.push(body.batchId);
      calls += 1;
      if (calls === 2) return new Response("no", { status: 500 });
      return Response.json({
        ok: true,
        duplicate: false,
        rows: body.rows.length,
        writeUnits: batchWriteUnits(body.rows),
      });
    };
    await assert.rejects(
      () => runImport({ ...options, batchSize: 2, fetchImpl }),
      /returned 500/,
    );
    const first = JSON.parse(readFileSync(options.checkpointPath, "utf8")) as {
      offsets: { user: number };
    };
    assert.equal(first.offsets.user, 2);
    assert.deepEqual(posted, ["user:0:2", "user:2:4"]);

    await assert.rejects(
      () => runImport({ ...options, batchSize: 3, fetchImpl: async () => new Response("no") }),
      /batch size is 2/,
    );
    const unchanged = JSON.parse(readFileSync(options.checkpointPath, "utf8")) as {
      offsets: { user: number };
    };
    assert.equal(unchanged.offsets.user, 2);

    const resumed: string[] = [];
    await runImport({
      ...options,
      batchSize: 2,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { batchId: string; rows: ImportRow[] };
        resumed.push(body.batchId);
        return Response.json({
          ok: true,
          duplicate: false,
          rows: body.rows.length,
          writeUnits: batchWriteUnits(body.rows),
        });
      },
    });
    assert.deepEqual(resumed, ["user:2:4"]);
  });

  it("counts a lost response once when the same batch comes back as a duplicate", async () => {
    const dir = temp();
    const options = baseOptions(dir, "users.db");
    seedUsers(options.sqlitePath, 2);
    const seen = new Map<string, number>();
    let hung = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { batchId: string; rows: ImportRow[] };
      const units = batchWriteUnits(body.rows);
      if (!hung) {
        hung = true;
        seen.set(body.batchId, units);
        throw new Error("socket hang up");
      }
      const prior = seen.get(body.batchId);
      if (prior !== undefined) {
        return Response.json({ ok: true, duplicate: true, rows: 0, writeUnits: prior });
      }
      seen.set(body.batchId, units);
      return Response.json({
        ok: true,
        duplicate: false,
        rows: body.rows.length,
        writeUnits: units,
      });
    };
    await assert.rejects(() => runImport({ ...options, fetchImpl }), /socket hang up/);
    assert.equal(existsSync(options.checkpointPath), false);
    const lines: string[] = [];
    await runImport({
      ...options,
      fetchImpl,
      stdout: (line) => lines.push(line),
    });
    const saved = JSON.parse(readFileSync(options.checkpointPath, "utf8")) as {
      offsets: { user: number };
      writesToday: number;
    };
    assert.equal(saved.offsets.user, 2);
    assert.equal(saved.writesToday, 6);
    assert.equal(seen.size, 1);
    assert.match(lines.join("\n"), /duplicate=true/);
  });

  it("stops at the daily write limit and continues on the next UTC day", async () => {
    const dir = temp();
    const options = baseOptions(dir, "users.db");
    seedUsers(options.sqlitePath, 4);
    const posted: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { batchId: string; rows: ImportRow[] };
      posted.push(body.batchId);
      return Response.json({
        ok: true,
        duplicate: false,
        rows: body.rows.length,
        writeUnits: batchWriteUnits(body.rows),
      });
    };
    const firstDay = new Date("2026-11-19T12:00:00.000Z");
    const status = await runImport({
      ...options,
      batchSize: 2,
      dailyLimit: 6,
      now: () => firstDay,
      fetchImpl,
    });
    assert.equal(status, "daily-limit");
    assert.deepEqual(posted, ["user:0:2"]);
    const next = await runImport({
      ...options,
      batchSize: 2,
      dailyLimit: 6,
      now: () => new Date("2026-11-20T00:00:00.000Z"),
      fetchImpl,
    });
    assert.equal(next, "done");
    assert.deepEqual(posted, ["user:0:2", "user:2:4"]);
  });

  it("refuses a non-local http endpoint before opening sqlite", async () => {
    const dir = temp();
    await assert.rejects(
      () =>
        runImport({
          ...baseOptions(dir, "missing.db"),
          endpoint: "http://example.com/import",
        }),
      /https/,
    );
    assert.equal(assertImportEndpoint("http://127.0.0.1/import").pathname, "/import");
  });
});
