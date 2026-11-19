import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";

describe("user settings", () => {
  it("returns defaults on read and does not store an empty upsert", async () => {
    const state = freshState();
    const key = { groupId: "C1", userId: "U1" };

    expect(await state.countSettings(key)).toBe(0);
    const missing = await state.getSettings(key);
    expect(missing).toEqual({ groupId: "C1", userId: "U1", options: {}, stored: false });
    expect(await state.countSettings(key)).toBe(0);

    await state.upsertSettings(key, {});
    expect(await state.countSettings(key)).toBe(0);
    expect((await state.getSettings(key)).stored).toBe(false);
  });

  it("stores a non-empty upsert once and keeps an empty string scope distinct", async () => {
    const state = freshState();
    const key = { groupId: "C1", userId: "U1" };
    const absentGroup = { groupId: "", userId: "U1" };

    await state.upsertSettings(key, { 暫停: true });
    await state.upsertSettings(key, { 列表: false });
    expect(await state.countSettings(key)).toBe(1);
    expect(await state.getSettings(key)).toEqual({
      groupId: "C1",
      userId: "U1",
      options: { 暫停: true, 列表: false },
      stored: true,
    });

    await state.upsertSettings(absentGroup, { 個人: true });
    expect(await state.countSettings(absentGroup)).toBe(1);
    expect(await state.countSettings(key)).toBe(1);
    expect((await state.getSettings({ groupId: "", userId: "" })).stored).toBe(false);
  });

  it("keeps __proto__ as an own option", async () => {
    const state = freshState();
    const key = { groupId: "C1", userId: "U1" };
    await state.upsertSettings(key, JSON.parse('{"__proto__":true}'));
    const view = await state.getSettings(key);
    expect(view.stored).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(view.options, "__proto__")).toBe(true);
    expect(view.options["__proto__"]).toBe(true);
  });

  it("dumps a non-BMP key as a UTF-16 surrogate pair", async () => {
    const state = freshState();
    await state.upsertSettings({ groupId: "C1", userId: "" }, { "😀": true });
    const raw = (await state.fixtureSlices()).settings.map((row) => row[2]).join("\n");
    expect(raw).toContain("\\ud83d\\ude00");
    expect(raw).not.toContain("\\u1f600");
  });
});

function freshState(): DurableObjectStub<BotState> {
  const id = env.BOT_STATE.idFromName(`settings-${crypto.randomUUID()}`);
  return env.BOT_STATE.get(id);
}
