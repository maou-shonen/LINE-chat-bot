import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { COLD_BOT_STATE, groupBlobKey, userShardKey, userShardIndex } from "../src/blob-store";
import type { BotState } from "../src/bot-state";
import { HYDRATE_BATCH } from "../src/hydrate";

const NOW = "2024-01-02 03:04:05";

describe("cold hydration", () => {
  const stub = env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE));

  beforeEach(async () => {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      await _instance.migrate();
    });
  });

  it("copies a group once, then stops reading the blob", async () => {
    await putGroup(stub, {
      id: "G1",
      group: {
        id: "G1",
        _id: "legacy",
        _count: '{"文字":1}',
        _setting: "{}",
        _admin: "{}",
        create_on: "2019-01-01 00:00:00",
        update_on: "2019-02-01 00:00:00",
      },
      users: [{ uid: "U1", name: "Old", _count: '{"文字":4}', _setting: "{}" }],
      settings: [{ user_id: "U1", options: '{"全回應": true}' }],
    });
    await spyGets(stub);
    await stub.recordMessage(text("G1", "U1", "hi"), NOW);
    const afterFirst = await readGets(stub);
    expect(afterFirst).toBeGreaterThan(0);
    const row = await groupRow(stub, "G1");
    expect(row.create_on).toBe("2019-01-01 00:00:00");
    expect(row._id).toBe("legacy");
    await stub.recordMessage(text("G1", "U1", "hi"), "2024-01-03 00:00:00");
    expect(await readGets(stub)).toBe(afterFirst);
    const settings = await stub.getSettings({ groupId: "G1", userId: "U1" });
    expect(settings.stored).toBe(true);
  });

  it("creates a python-shaped group when the blob group is null and when the blob is missing", async () => {
    await putGroup(stub, {
      id: "Gnull",
      group: null,
      users: [{ uid: "Unull", name: "N", _count: "{}", _setting: "{}" }],
      settings: [],
    });
    await stub.recordMessage(text("Gnull", "Unull", "hi"), NOW);
    const created = await groupRow(stub, "Gnull");
    expect(created._count).toBe("{}");
    expect(created._id).not.toBeNull();
    const members = await stub.listGroupUsers("Gnull");
    expect(members.map((member) => member.uid)).toEqual(["Unull"]);

    await spyGets(stub);
    await stub.recordMessage(text("Gnew", "Unew", "hi"), NOW);
    const once = await readGets(stub);
    await stub.recordMessage(text("Gnew", "Unew", "hi"), NOW);
    expect(await readGets(stub)).toBe(once);
    expect(once).toBe(2);
    expect((await groupRow(stub, "Gnew")).create_on).toBe(NOW);
  });

  it("hydrates one user from the shard and does not reread it", async () => {
    const id = "Ushard";
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(userShardKey(userShardIndex(id)), {
        users: [{ id, name: "Shard", create_on: "2018-01-01", update_on: "2018-01-02" }],
        settings: [{ user_id: id, options: '{"a": 1}' }],
      });
    });
    await spyGets(stub);
    expect(await stub.userName(id)).toBe("Shard");
    expect(await stub.userName(id)).toBe("Shard");
    expect(await readGets(stub)).toBe(1);
    const dm = await stub.getSettings({ groupId: "", userId: id });
    expect(dm.stored).toBe(true);
  });

  it("fills shard timestamps after a group stub, and does not reread the shard", async () => {
    const id = "Ustub";
    await putGroup(stub, {
      id: "Gstub",
      group: {
        id: "Gstub",
        _id: "g",
        _count: "{}",
        _setting: "{}",
        _admin: "{}",
        create_on: "2019-01-01",
        update_on: "2019-01-01",
      },
      users: [
        { uid: id, name: "FromGroup", _count: "{}", _setting: "{}" },
        { uid: "Uspeaker", name: "Other", _count: "{}", _setting: "{}" },
      ],
      settings: [],
    });
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(userShardKey(userShardIndex(id)), {
        users: [{ id, name: "FromShard", create_on: "2017-05-01", update_on: "2017-06-01" }],
        settings: [{ user_id: id, options: '{"dm": 1}' }],
      });
    });
    await stub.recordMessage(text("Gstub", "Uspeaker", "hi"), NOW);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE user SET name = ? WHERE id = ?", "Live", id);
    });
    await installMeter(stub);
    await spyGets(stub);
    await stub.recordMessage(text("Gstub", id, "hi"), "2024-03-01 00:00:00");
    const user = await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec(
        "SELECT name, create_on, update_on FROM user WHERE id = ?",
        id,
      ).one();
      return { name: String(row.name), create_on: String(row.create_on), update_on: String(row.update_on) };
    });
    expect(user.name).toBe("Live");
    expect(user.create_on).toBe("2017-05-01");
    expect(user.update_on).toBe("2024-03-01 00:00:00");
    const dm = await stub.getSettings({ groupId: "", userId: id });
    expect(dm.stored).toBe(true);
    const filled = await readMeter(stub);
    const gets = await readGets(stub);
    await stub.userName(id);
    expect(await readGets(stub)).toBe(gets);
    console.log(JSON.stringify({ stubThenShardRowsRead: filled.rowsRead, stubThenShardRowsWritten: filled.rowsWritten }));
  });

  it("lists a 659 member group during batched hydration, then finishes idempotently", async () => {
    const users = [];
    for (let i = 0; i < 659; i += 1) {
      users.push({ uid: `U${String(i).padStart(4, "0")}`, name: "N", _count: '{"文字":1}', _setting: "{}" });
    }
    await putGroup(stub, {
      id: "Gbig",
      group: {
        id: "Gbig",
        _id: "big",
        _count: "{}",
        _setting: "{}",
        _admin: "{}",
        create_on: "2018-01-01",
        update_on: "2018-01-01",
      },
      users,
      settings: [],
    });
    await installMeter(stub);
    const started = performance.now();
    await stub.recordMessage(text("Gbig", "U0000", "hi"), NOW);
    const firstMs = performance.now() - started;
    await stub.deleteGroupUsers("Gbig", "U0658");
    const midway = await stub.listGroupUsers("Gbig");
    expect(midway).toHaveLength(658);
    expect(midway.some((member) => member.uid === "U0658")).toBe(false);
    expect((await readMeter(stub)).rowsWritten).toBeGreaterThan(0);
    const duringSql = await memberCount(stub, "Gbig");
    expect(duringSql).toBeLessThan(659);
    let alarmMs = 0;
    let steps = 0;
    for (;;) {
      const stepStarted = performance.now();
      const more = await stub.pumpHydration();
      alarmMs = Math.max(alarmMs, performance.now() - stepStarted);
      steps += 1;
      const pending = await runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql.exec("SELECT done FROM cold_group WHERE id = ?", "Gbig").toArray()[0];
        return row?.done;
      });
      if (pending === 1) break;
      expect(steps).toBeLessThan(40);
      void more;
    }
    expect(await memberCount(stub, "Gbig")).toBe(658);
    expect((await stub.listGroupUsers("Gbig")).some((member) => member.uid === "U0658")).toBe(false);
    const hydrated = await readMeter(stub);
    const before = 658;
    await stub.pumpHydration();
    await Promise.all([
      stub.recordMessage(text("Gbig", "U0001", "hi"), NOW),
      stub.pumpHydration(),
    ]);
    expect(await memberCount(stub, "Gbig")).toBe(before);
    await resetMeter(stub);
    await stub.recordMessage(text("Gbig", "U0002", "hi"), NOW);
    const follow = await readMeter(stub);
    expect(follow.rowsRead).toBeLessThan(40);
    expect(firstMs).toBeLessThan(50);
    expect(alarmMs).toBeLessThan(50);
    console.log(JSON.stringify({
      batch: HYDRATE_BATCH,
      firstMs: Math.round(firstMs * 10) / 10,
      alarmMs: Math.round(alarmMs * 10) / 10,
      steps,
      hydrateRowsRead: hydrated.rowsRead,
      hydrateRowsWritten: hydrated.rowsWritten,
      followRowsRead: follow.rowsRead,
      followRowsWritten: follow.rowsWritten,
    }));
  });
});

function text(groupId: string, userId: string, message: string) {
  return { kind: "text", text: message, source: { type: "group", groupId, userId } };
}

async function putGroup(stub: DurableObjectStub<BotState>, blob: unknown): Promise<void> {
  const id = (blob as { id: string }).id;
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(groupBlobKey(id), blob);
  });
}

async function spyGets(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const box = { n: 0 };
    (globalThis as unknown as { __hydrateGets: { n: number } }).__hydrateGets = box;
    const get = state.storage.get.bind(state.storage);
    state.storage.get = (async (key: string) => {
      box.n += 1;
      return get(key);
    }) as typeof state.storage.get;
  });
}

async function readGets(stub: DurableObjectStub<BotState>): Promise<number> {
  return runInDurableObject(
    stub,
    () => (globalThis as unknown as { __hydrateGets: { n: number } }).__hydrateGets.n,
  );
}

async function groupRow(stub: DurableObjectStub<BotState>, id: string) {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql.exec(
      'SELECT _id, _count, create_on FROM "group" WHERE id = ?',
      id,
    ).toArray()[0];
    if (row === undefined) throw new Error("missing group");
    return {
      _id: typeof row._id === "string" ? row._id : null,
      _count: String(row._count),
      create_on: String(row.create_on),
    };
  });
}

async function memberCount(stub: DurableObjectStub<BotState>, gid: string): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql.exec(
      "SELECT COUNT(*) AS n FROM group_user WHERE gid = ?",
      gid,
    ).one();
    return Number(row.n);
  });
}

async function installMeter(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    const box = { rowsRead: 0, rowsWritten: 0 };
    (globalThis as unknown as { __hydrateMeter: typeof box }).__hydrateMeter = box;
    const exec = state.storage.sql.exec.bind(state.storage.sql);
    state.storage.sql.exec = ((query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...(bindings as never[]));
      box.rowsRead += cursor.rowsRead;
      box.rowsWritten += cursor.rowsWritten;
      return cursor;
    }) as typeof state.storage.sql.exec;
  });
}

async function readMeter(stub: DurableObjectStub<BotState>): Promise<{ rowsRead: number; rowsWritten: number }> {
  return runInDurableObject(stub, () => {
    const box = (globalThis as unknown as { __hydrateMeter: { rowsRead: number; rowsWritten: number } }).__hydrateMeter;
    return { rowsRead: box.rowsRead, rowsWritten: box.rowsWritten };
  });
}

async function resetMeter(stub: DurableObjectStub<BotState>): Promise<void> {
  await runInDurableObject(stub, () => {
    const box = (globalThis as unknown as { __hydrateMeter: { rowsRead: number; rowsWritten: number } }).__hydrateMeter;
    box.rowsRead = 0;
    box.rowsWritten = 0;
  });
}
