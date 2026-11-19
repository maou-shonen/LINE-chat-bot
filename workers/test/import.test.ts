import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src";
import type { BotState } from "../src/bot-state";
import { GLOBAL_BOT_STATE } from "../src/bot-state";
import {
  IMPORT_TABLE_ORDER,
  ImportBatchError,
  TABLE_SPEC,
  importGate,
  parseImportBatch,
} from "../src/import-plan";
import type { SchemaSnapshot } from "../src/schema";

const SECRET = "test-import-secret";

describe("import gate", () => {
  it("rejects a wrong secret before any import table exists", async () => {
    expect(importGate("", SECRET)).toBe("disabled");
    expect(importGate(SECRET, "other")).toBe("reject");
    const response = await postImport(
      { batchId: "user:0:1", rows: [userRow("U-secret")] },
      "other",
    );
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(SECRET);

    const stub = env.BOT_STATE.get(env.BOT_STATE.idFromName(GLOBAL_BOT_STATE));
    const names = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'import_batches'")
        .toArray(),
    );
    expect(names).toEqual([]);
  });

  it("inserts a batch once and reports the same write units on a replay", async () => {
    const batch = { batchId: "user:0:1", rows: [userRow("U-once")] };
    const first = await postImport(batch, SECRET);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, duplicate: false, rows: 1, writeUnits: 4 });
    const second = await postImport(batch, SECRET);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, duplicate: true, rows: 0, writeUnits: 4 });
  });
});

describe("import batch", () => {
  it("keeps null keyword ids distinct, stores an empty scope, and rolls back a conflict", async () => {
    const stub = freshStub();
    const keyword = await postStub(stub, {
      batchId: "user_keyword:0:2",
      rows: [
        keywordRow(1, null, "same", "one"),
        keywordRow(2, null, "same", "two"),
      ],
    });
    expect(keyword.status).toBe(200);
    expect(await keyword.json()).toMatchObject({ duplicate: false, rows: 2, writeUnits: 10 });

    const member = await postStub(stub, {
      batchId: "group_user:0:1",
      rows: [
        {
          table: "group_user",
          values: { _id: 9, gid: null, uid: null, _count: null, _setting: null },
        },
      ],
    });
    expect(member.status).toBe(200);

    const replay = await postStub(stub, {
      batchId: "user_keyword:0:2",
      rows: [
        keywordRow(1, null, "same", "one"),
        keywordRow(2, null, "same", "two"),
      ],
    });
    expect(await replay.json()).toEqual({ ok: true, duplicate: true, rows: 0, writeUnits: 10 });

    const stored = await runInDurableObject(stub, (_instance, state) => {
      const keywords = state.storage.sql
        .exec("SELECT id, keyword FROM user_keyword ORDER BY _id")
        .toArray();
      const members = state.storage.sql.exec("SELECT gid, uid, _count FROM group_user").toArray();
      return { keywords, members };
    });
    expect(stored.keywords).toEqual([
      { id: null, keyword: "same" },
      { id: null, keyword: "same" },
    ]);
    expect(stored.members).toEqual([{ gid: "", uid: "", _count: "{}" }]);

    const empty = await postStub(stub, {
      batchId: "user_settings:0:1",
      rows: [{ table: "user_settings", values: { group_id: "G", user_id: "U", options: "{}" } }],
    });
    expect(empty.status).toBe(400);

    const conflictStub = freshStub();
    const conflict = await postStub(conflictStub, {
      batchId: "user:0:2",
      rows: [userRow("U-dup"), userRow("U-dup")],
    });
    expect(conflict.status).toBe(409);
    const left = await runInDurableObject(conflictStub, (_instance, state) =>
      state.storage.sql.exec("SELECT COUNT(*) AS n FROM user").toArray(),
    );
    expect(left).toEqual([{ n: 0 }]);
  });

  it("rejects an empty settings row and a batch over the row cap", () => {
    expect(() =>
      parseImportBatch({
        batchId: "user_settings:0:1",
        rows: [{ table: "user_settings", values: { group_id: null, user_id: "U", options: " {} " } }],
      }),
    ).toThrow(ImportBatchError);
    const row = userRow("U");
    expect(() =>
      parseImportBatch({
        batchId: "user:0:1001",
        rows: Array.from({ length: 1001 }, () => row),
      }),
    ).toThrow(ImportBatchError);
  });

  it("counts the same indexes the schema created", async () => {
    const stub = freshStub();
    const snapshot = await stub.inspectSchema();
    for (const table of IMPORT_TABLE_ORDER) {
      expect(indexCount(snapshot, table)).toBe(TABLE_SPEC[table].indexes);
    }
  });
});

function userRow(id: string): { table: "user"; values: Record<string, string | null> } {
  return { table: "user", values: { id, name: null, create_on: null, update_on: null } };
}

function keywordRow(
  id: number,
  scope: string | null,
  keyword: string,
  reply: string,
): { table: "user_keyword"; values: Record<string, string | number | null> } {
  return {
    table: "user_keyword",
    values: { _id: id, id: scope, author: null, keyword, reply, anchor: null },
  };
}

function freshStub(): DurableObjectStub<BotState> {
  const id = env.BOT_STATE.idFromName(`import-${crypto.randomUUID()}`);
  return env.BOT_STATE.get(id);
}

async function postImport(body: unknown, secret: string | null): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("x-import-secret", secret);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("http://example.com/import", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function postStub(
  stub: DurableObjectStub<BotState>,
  body: unknown,
): Promise<Response> {
  return stub.fetch(
    new Request("http://example.com/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-import-secret": SECRET,
      },
      body: JSON.stringify(body),
    }),
  );
}

function indexCount(snapshot: SchemaSnapshot, table: string): number {
  return snapshot.indexes.filter((index) => {
    if (index.name === `sqlite_autoindex_${table}_1`) return true;
    return new RegExp(`\\b${table}\\b`).test(index.sql ?? "");
  }).length;
}
