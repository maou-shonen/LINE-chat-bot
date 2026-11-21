import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { COLD_BOT_STATE, keywordBlobEntries, keywordBlobsRoundTrip, userShardIndex } from "../src/blob-store";
import { GLOBAL_BOT_STATE } from "../src/bot-state";

const SECRET = "test-import-secret";

describe("blob import", () => {
  beforeEach(() => {
    env.IMPORT_SECRET = SECRET;
  });

  it("rejects a bad secret and stores a group blob only on the cold object", async () => {
    env.IMPORT_SECRET = undefined;
    const closed = await postKv({ key: "c-manifest", json: { puts: 0 } }, SECRET);
    expect(closed.status).toBe(404);

    env.IMPORT_SECRET = SECRET;
    const wrong = await postKv({ key: "c-manifest", json: { puts: 0 } }, "other");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(SECRET);

    const bad = await postKv({ key: "user", json: { id: "U" } }, SECRET);
    expect(bad.status).toBe(400);

    const body = { key: "c-group:Cblobtest", json: { group: { id: "Cblobtest" }, users: [], settings: [] } };
    const ok = await postKv(body, SECRET);
    expect(ok.status).toBe(200);
    const stored = await runInDurableObject(
      env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE)),
      (_instance, state) => state.storage.get("c-group:Cblobtest"),
    );
    expect(stored).toEqual(body.json);
    const globalValue = await runInDurableObject(
      env.BOT_STATE.get(env.BOT_STATE.idFromName(GLOBAL_BOT_STATE)),
      (_instance, state) => state.storage.get("c-group:Cblobtest"),
    );
    expect(globalValue).toBeUndefined();
    await runInDurableObject(
      env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE)),
      async (_instance, state) => {
        await state.storage.delete("c-group:Cblobtest");
      },
    );
  });

  it("round-trips keyword blobs with the probe codec and keeps the key count within 16", () => {
    const rows = [];
    for (let i = 0; i < 20; i += 1) {
      rows.push({ id: "G", keyword: `anchor${i}word`, reply: `reply${i}` });
    }
    const entries = keywordBlobEntries(rows);
    expect(entries.length).toBeLessThanOrEqual(16);
    expect(keywordBlobsRoundTrip(entries)).toBeGreaterThan(0);
    expect(userShardIndex("U1")).toBe(userShardIndex("U1"));
    expect(userShardIndex("U1")).toBeGreaterThanOrEqual(0);
    expect(userShardIndex("U1")).toBeLessThan(256);
  });
});

async function postKv(body: unknown, secret: string | null): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("x-import-secret", secret);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("http://example.com/import/kv", {
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
