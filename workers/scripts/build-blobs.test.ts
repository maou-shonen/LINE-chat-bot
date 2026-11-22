import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { buildBlobs } from "./build-blobs.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("build blobs", () => {
  it("writes counts outside the repo and does not print row contents", async () => {
    const root = mkdtempSync(join(tmpdir(), "blob-src-"));
    const out = mkdtempSync(join(tmpdir(), "blob-out-"));
    dirs.push(root, out);
    const sqlite = join(root, "snap.db");
    const db = new DatabaseSync(sqlite);
    db.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, create_on TEXT, update_on TEXT);
      CREATE TABLE "group" (id TEXT PRIMARY KEY, _id TEXT, _count TEXT, _setting TEXT, _admin TEXT, create_on TEXT, update_on TEXT);
      CREATE TABLE group_user (_id INTEGER PRIMARY KEY, gid TEXT, uid TEXT, _count TEXT, _setting TEXT);
      CREATE TABLE keywords_logs (_id TEXT PRIMARY KEY, id TEXT, keyword TEXT, reply TEXT, create_on TEXT);
      CREATE TABLE user_keyword (_id INTEGER PRIMARY KEY, id TEXT, author TEXT, keyword TEXT, reply TEXT, anchor TEXT);
      CREATE TABLE user_settings (_id INTEGER PRIMARY KEY, group_id TEXT, user_id TEXT, options TEXT);
    `);
    db.prepare("INSERT INTO user (id, name, create_on, update_on) VALUES (?, ?, ?, ?)").run(
      "Usecret",
      "Nsecret",
      null,
      null,
    );
    db.prepare(
      'INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run("Gsecret", null, "{}", "{}", "{}", null, null);
    db.prepare("INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?)").run(
      "Gsecret",
      "Usecret",
      "{}",
      "{}",
    );
    db.prepare("INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, ?, ?)").run(
      "Gorphan",
      "Usecret",
      "{}",
      "{}",
    );
    db.prepare("INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)").run(
      "Gorphan",
      "Usecret",
      '{"b":1}',
    );
    db.prepare("INSERT INTO user_keyword (id, author, keyword, reply, anchor) VALUES (?, ?, ?, ?, ?)").run(
      "Gsecret",
      null,
      "Ksecret",
      "Rsecret",
      null,
    );
    db.prepare("INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)").run(
      "",
      "Usecret",
      '{"a":1}',
    );
    db.prepare("INSERT INTO user_settings (group_id, user_id, options) VALUES (?, ?, ?)").run("", "Usecret", "{}");
    db.prepare("INSERT INTO keywords_logs (_id, id, keyword, reply, create_on) VALUES (?, ?, ?, ?, ?)").run(
      "L1",
      "Gsecret",
      "Ksecret",
      "Rsecret",
      null,
    );
    db.close();
    const before = statSync(sqlite).mtimeMs;
    const lines: string[] = [];
    const uploads: string[] = [];
    const summary = await buildBlobs({
      sqlitePath: sqlite,
      outDir: out,
      repoRoot: root,
      upload: "http://127.0.0.1/import/kv",
      secret: "s",
      fetchImpl: async (_url, init) => {
        uploads.push(String(init?.body ?? ""));
        return new Response("{}", { status: 200 });
      },
      stdout: (line) => lines.push(line),
    });
    assert.equal(statSync(sqlite).mtimeMs, before);
    assert.equal(summary.groups, 2);
    assert.equal(summary.groupsMissing, 1);
    assert.equal(summary.membersSkipped, 0);
    assert.equal(summary.users, 1);
    assert.equal(summary.keywords, 1);
    assert.equal(summary.settingsDm, 1);
    assert.equal(summary.settingsSkipped, 1);
    assert.equal(summary.logKeys, 1);
    assert.ok(summary.keywordKeys <= 128);
    assert.equal(uploads.length, summary.puts);
    const printed = lines.join("\n");
    for (const secret of ["Usecret", "Nsecret", "Gsecret", "Ksecret", "Rsecret"]) {
      assert.equal(printed.includes(secret), false);
    }
    const names = readdirSync(out);
    assert.ok(names.includes("c-manifest.json"));
    const groupFile = names.find((name) => name.startsWith("c-group:"));
    assert.ok(groupFile);
    const orphanName = names.find((name) => name.startsWith("c-group:Gorphan"));
    assert.ok(orphanName);
    const orphan = JSON.parse(readFileSync(join(out, orphanName), "utf8")) as {
      group: null;
      users: Array<{ uid: string }>;
      settings: Array<{ options: string }>;
    };
    assert.equal(orphan.group, null);
    assert.equal(orphan.users.length, 1);
    assert.equal(orphan.settings.length, 1);
    const presentName = names.find((name) => name.startsWith("c-group:Gsecret"));
    assert.ok(presentName);
    const group = JSON.parse(readFileSync(join(out, presentName), "utf8")) as {
      users: Array<{ name: string }>;
    };
    assert.equal(group.users[0]?.name, "Nsecret");
    await assert.rejects(() =>
      buildBlobs({
        sqlitePath: sqlite,
        outDir: root,
        repoRoot: root,
        stdout: () => undefined,
      }),
    );
  });
});
