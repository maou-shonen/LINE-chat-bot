import { describe, expect, it } from "vitest";
import { liveRng, safeBrowsingLive, taipeiNow } from "../src/dispatch";

describe("production runtime", () => {
  it("formats Taipei local time like Python str(datetime.now())", () => {
    expect(taipeiNow(Date.UTC(2026, 10, 21, 15, 50, 17, 123))).toBe("2026-11-21 23:50:17.123000");
  });

  it("draws without a fixture script", () => {
    const rng = liveRng();
    const items = ["a", "b", "c", "d"];
    for (let i = 0; i < 50; i += 1) {
      expect(items).toContain(rng.choice(items));
      const u = rng.uniform(2, 5);
      expect(u).toBeGreaterThanOrEqual(2);
      expect(u).toBeLessThan(5);
      const picked = rng.sample(items, 3);
      expect(new Set(picked).size).toBe(3);
    }
    expect(() => rng.choice([])).toThrow();
    expect(() => rng.sample(items, 5)).toThrow();
    rng.finish();
  });

  it("ports the Safe Browsing reply shapes", async () => {
    const reply = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await safeBrowsingLive(reply(400, {}), "https://a.example/", "")).toEqual(["Google網址檢查：查詢失敗"]);
    expect(await safeBrowsingLive(reply(200, {}), "https://a.example/", "k")).toBeNull();
    expect(
      await safeBrowsingLive(
        reply(200, { matches: [{ threat: { url: "https://a.example/" }, threatType: "MALWARE" }] }),
        "https://a.example/",
        "k",
      ),
    ).toEqual(["Google網址檢查：危險！\n", "網址:https://a.example/\n類型:惡意軟件\n"]);
  });
});
