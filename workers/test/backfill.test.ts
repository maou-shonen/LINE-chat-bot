import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { COLD_BOT_STATE, keywordBlobEntries } from "../src/blob-store";
import type { BotState } from "../src/bot-state";
import { EXPORT_TABLES } from "../src/export-tables";

const SECRET = "backfill-test-secret";
const NOW = "2024-06-01 00:00:00";

describe("cold export", () => {
  const stub: DurableObjectStub<BotState> = env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE));

  beforeEach(async () => {
    env.IMPORT_SECRET = SECRET;
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAll();
      await instance.migrate();
    });
    await importKv({
      key: "c-group:G1",
      json: {
        id: "G1",
        group: {
          id: "G1",
          _id: "legacy",
          _count: '{"文字": 5}',
          _setting: "{}",
          _admin: "{}",
          create_on: "2019-01-01 00:00:00",
          update_on: "2019-01-02 00:00:00",
        },
        users: [{ uid: "U1", name: "Old", _count: '{"文字": 1}', _setting: "{}" }],
        settings: [{ user_id: "U1", options: '{"a": 1}' }],
      },
    });
    for (const entry of keywordBlobEntries([
      { id: "G1", author: "U1", keyword: "kbase", reply: "base" },
      { id: "G1", author: "U1", keyword: "kdel", reply: "gone" },
    ])) {
      await importKv(
        entry.bytes === undefined
          ? { key: entry.key, json: entry.json }
          : { key: entry.key, bytes: Buffer.from(entry.bytes).toString("base64") },
      );
    }
    await stub.measureColdRequest(
      { message: "", scopeId: null, allReply: false, excludeUrl: false, stripName: false, rng: [] },
      1,
    );
    await stub.recordMessage(text("G1", "U1"), NOW);
    expect(await stub.getKeyword({ scopeId: "G1", keyword: "kdel" })).toBe("gone");
    await stub.recordMessage(text("G2", "U2"), NOW);
    await stub.upsertKeyword(write("G1", "knew", "new"));
    expect(await stub.getKeyword({ scopeId: "G1", keyword: "kdel" })).toBe("gone");
    await stub.upsertKeyword(write("G1", "kbase", "changed"));
    expect(await stub.getKeyword({ scopeId: "G1", keyword: "kdel" })).toBe("gone");
    expect(await stub.deleteKeyword({ scopeId: "G1", author: "U1", keyword: "kdel" })).toBe("deleted");
    await stub.upsertSettings({ groupId: "G1", userId: "U1" }, { 全回應: false });
  });

  it("pages every hot table and includes tombstones, but no cold tables", async () => {
    expect(await page("user", 0, 1)).toMatchObject({ next: expect.any(Number) });
    const users = await exportAll("user", 1);
    expect(users.map((row) => row.id).sort()).toEqual(["U1", "U2"]);
    const u1 = users.find((row) => row.id === "U1");
    expect(u1?.name).toBe("Old");

    const groups = await exportAll("group", 2);
    const g1 = groups.find((row) => row.id === "G1");
    expect(g1?._id).toBe("legacy");
    expect(g1?.update_on).toBe(NOW);
    const g2 = groups.find((row) => row.id === "G2");
    expect(typeof g2?._id).toBe("string");
    expect(g2?._count).not.toBe("");

    const members = await exportAll("group_user", 1);
    expect(members.map((row) => `${row.gid}/${row.uid}`).sort()).toEqual(["G1/U1", "G2/U2"]);
    expect(members.find((row) => row.gid === "G1")?._count).not.toBe('{"文字": 1}');

    const settings = await exportAll("user_settings", 1);
    expect(settings.some((row) => row.group_id === "G1" && row.user_id === "U1")).toBe(true);

    const keywords = await exportAll("user_keyword", 1);
    expect(keywords.map((row) => row.keyword).sort()).toEqual(["kbase", "knew"]);
    expect(keywords.find((row) => row.keyword === "kbase")?.reply).toBe("changed");

    const tombstones = await exportAll("keyword_tombstone", 1);
    expect(tombstones).toEqual([{ id: "G1", keyword: "kdel" }]);

    expect(await exportAll("group_user_tombstone", 1)).toEqual([]);

    const logs = await exportAll("keywords_logs", 1);
    expect(logs).toHaveLength(2);

    for (const table of EXPORT_TABLES) expect(table.startsWith("cold_")).toBe(false);
  });

  it("records member deletes and clears them when the member speaks again", async () => {
    await stub.deleteGroupUsers("G1", "U1");
    expect(await exportAll("group_user_tombstone", 1)).toEqual([{ gid: "G1", uid: "U1" }]);
    expect((await exportAll("group_user", 1)).map((row) => `${row.gid}/${row.uid}`)).toEqual(["G2/U2"]);

    await stub.recordMessage(text("G1", "U1"), NOW);
    expect(await exportAll("group_user_tombstone", 1)).toEqual([]);
    expect((await exportAll("group_user", 1)).map((row) => `${row.gid}/${row.uid}`).sort()).toEqual([
      "G1/U1",
      "G2/U2",
    ]);
  });

  it("records whole-group deletes, pages tombstones one at a time, and clears them when the group returns", async () => {
    await stub.deleteGroupUsers("G1", "U1");
    await stub.deleteGroupUsers("G2", null);

    const first = await page("group_user_tombstone", 0, 1);
    expect(first.rows).toHaveLength(1);
    expect(typeof first.next).toBe("number");
    expect(await exportAll("group_user_tombstone", 1)).toEqual([
      { gid: "G1", uid: "U1" },
      { gid: "G2", uid: "" },
    ]);
    expect(await exportAll("group_user", 1)).toEqual([]);

    await stub.recordMessage(text("G2", "U2"), NOW);
    expect(await exportAll("group_user_tombstone", 1)).toEqual([{ gid: "G1", uid: "U1" }]);
    expect((await exportAll("group_user", 1)).map((row) => `${row.gid}/${row.uid}`)).toEqual(["G2/U2"]);
  });

  it("rejects export without the secret and unknown tables", async () => {
    const unauthorized = await post("/export", { table: "user", after: 0, limit: 1 }, null);
    expect(unauthorized.status).toBe(401);
    const unknown = await post("/export", { table: "cold_group", after: 0, limit: 1 }, SECRET);
    expect(unknown.status).toBe(400);
    const badLimit = await post("/export", { table: "user", after: 0, limit: 0 }, SECRET);
    expect(badLimit.status).toBe(400);
  });

  async function exportAll(table: string, limit: number): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let after = 0;
    for (;;) {
      const response = await post("/export", { table, after, limit }, SECRET);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { rows: Record<string, unknown>[]; next: number | null };
      rows.push(...body.rows);
      if (body.next === null) break;
      after = body.next;
    }
    return rows;
  }

  async function page(table: string, after: number, limit: number) {
    const response = await post("/export", { table, after, limit }, SECRET);
    expect(response.status).toBe(200);
    return (await response.json()) as { rows: Record<string, unknown>[]; next: number | null };
  }

  async function importKv(body: unknown): Promise<void> {
    const response = await post("/import/kv", body, SECRET);
    expect(response.status).toBe(200);
  }

  async function post(path: string, body: unknown, secret: string | null): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });
    if (secret !== null) headers.set("x-import-secret", secret);
    return stub.fetch(
      new Request(`http://do${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }
});

function text(groupId: string, userId: string) {
  return { kind: "text", text: "hi", source: { type: "group", groupId, userId } };
}

function write(scopeId: string, keyword: string, reply: string) {
  return { scopeId, author: "U1", keyword, reply, plus: false, now: NOW };
}
