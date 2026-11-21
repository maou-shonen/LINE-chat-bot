import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";

const NOW = "2023-11-14 22:13:20";

describe("per-message touch reads", () => {
  it("reads a constant number of rows for one group text as the tables grow", async () => {
    const small = await messageCost(400);
    const large = await messageCost(4000);
    expect(small.rowsRead).toBe(large.rowsRead);
    expect(small.rowsRead).toBeLessThan(40);
    expect(small.sql.some((query) => query.includes("ORDER BY id") || query.includes("ORDER BY gid"))).toBe(false);
  });

  it("skips the name write when the display name is unchanged", async () => {
    const same = await messageCost(20, { existingName: "Neko", displayName: "Neko" });
    const changed = await messageCost(20, { existingName: "Old", displayName: "Neko" });
    const first = await messageCost(20, { existingName: null, displayName: "Neko", insertUser: false });
    expect(same.sql.some((query) => query.startsWith("UPDATE user SET name"))).toBe(false);
    expect(changed.sql.some((query) => query.startsWith("UPDATE user SET name"))).toBe(true);
    expect(first.sql.some((query) => query.startsWith("UPDATE user SET name"))).toBe(true);
    expect(changed.rowsWritten).toBe(same.rowsWritten + 1);
    expect(await userName(same.stub)).toBe("Neko");
    expect(await userName(first.stub)).toBe("Neko");
  });
});

async function userName(stub: DurableObjectStub<BotState>): Promise<string | null> {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql.exec("SELECT name FROM user WHERE id = ?", "Utarget").toArray()[0];
    if (row === undefined) return null;
    const name = row.name;
    return typeof name === "string" ? name : null;
  });
}

async function messageCost(
  n: number,
  name: { existingName: string | null; displayName: string; insertUser?: boolean } = {
    existingName: null,
    displayName: "Neko",
  },
): Promise<{ rowsRead: number; rowsWritten: number; sql: string[]; stub: DurableObjectStub<BotState> }> {
  const stub = env.BOT_STATE.get(
    env.BOT_STATE.idFromName(`touch-${n}-${name.displayName}-${name.existingName}-${crypto.randomUUID()}`),
  );
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.transactionSync(() => {
      const sql = state.storage.sql;
      for (let i = 0; i < n; i += 1) {
        sql.exec(
          "INSERT INTO user (id, name, create_on, update_on) VALUES (?, 'pad', ?, ?)",
          `Upad${i}`,
          NOW,
          NOW,
        );
        sql.exec(
          `INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on) VALUES (?, ?, '{}', '{}', '{}', ?, ?)`,
          `Gpad${i}`,
          `gid${i}`,
          NOW,
          NOW,
        );
        sql.exec(
          "INSERT INTO group_user (gid, uid, _count, _setting) VALUES (?, ?, '{}', '{}')",
          `Gpad${i}`,
          `Upad${i}`,
        );
      }
      sql.exec(
        `INSERT INTO "group" (id, _id, _count, _setting, _admin, create_on, update_on) VALUES ('Gtarget', 'gtarget', '{}', '{}', '{}', ?, ?)`,
        NOW,
        NOW,
      );
      if (name.insertUser !== false) {
        sql.exec(
          "INSERT INTO user (id, name, create_on, update_on) VALUES ('Utarget', ?, ?, ?)",
          name.existingName,
          NOW,
          NOW,
        );
        sql.exec(
          "INSERT INTO group_user (gid, uid, _count, _setting) VALUES ('Gtarget', 'Utarget', '{}', '{}')",
        );
      }
    });
    installMeter(state);
  });
  const saved = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === "https://api.line.me" && url.pathname === "/v2/bot/message/reply") return Response.json({});
    if (url.origin === "https://api.line.me" && /^\/v2\/bot\/group\/.+\/member\/.+$/.test(url.pathname)) {
      return Response.json({ displayName: name.displayName });
    }
    if (url.origin === "https://api.line.me" && /^\/v2\/bot\/room\/.+\/member\/.+$/.test(url.pathname)) {
      return Response.json({}, { status: 404 });
    }
    throw new Error(`unmocked ${url.origin}${url.pathname}`);
  };
  try {
    const response = await stub.fetch(
      new Request("http://do/callback/secret/token", {
        method: "POST",
        headers: { "content-type": "application/json", "x-frozen-now": NOW, "x-frozen-epoch": "1700000000" },
        body: JSON.stringify({
          events: [
            {
              type: "message",
              replyToken: "r1",
              source: { type: "group", groupId: "Gtarget", userId: "Utarget" },
              message: { type: "text", id: "m1", text: "hello" },
            },
          ],
        }),
      }),
    );
    expect(response.status).toBe(200);
  } finally {
    globalThis.fetch = saved;
  }
  const meter = await runInDurableObject(stub, () => readMeter());
  return { ...meter, stub };
}

type Meter = { rowsRead: number; rowsWritten: number; sql: string[] };

function installMeter(state: DurableObjectState): void {
  const meter: Meter = { rowsRead: 0, rowsWritten: 0, sql: [] };
  (globalThis as unknown as { __touchMeter: Meter }).__touchMeter = meter;
  const sql = state.storage.sql;
  const exec = sql.exec.bind(sql);
  sql.exec = ((query: string, ...bindings: Array<string | number | null | ArrayBuffer>) => {
    const cursor = exec(query, ...bindings);
    meter.sql.push(query);
    const note = () => {
      meter.rowsRead += cursor.rowsRead;
      meter.rowsWritten += cursor.rowsWritten;
    };
    const toArray = cursor.toArray.bind(cursor);
    const one = cursor.one.bind(cursor);
    cursor.toArray = () => {
      const rows = toArray();
      note();
      return rows;
    };
    cursor.one = () => {
      const row = one();
      note();
      return row;
    };
    if (!/^\s*(select|with)\b/i.test(query)) note();
    return cursor;
  }) as typeof sql.exec;
}

function readMeter(): Meter {
  return (globalThis as unknown as { __touchMeter: Meter }).__touchMeter;
}
