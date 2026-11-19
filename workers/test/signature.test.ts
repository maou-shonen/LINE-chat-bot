import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src";

const SECRET = "test-channel-secret";
const BODY = '{"events":[]}';

describe("LINE signature gate", () => {
  it("accepts a valid signature and forwards to BotState", async () => {
    const response = await post("/callback/test-channel-secret/token/with/slash", BODY, await sign(SECRET, BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-bot-state")).toBe("accepted");
    expect(await response.text()).toBe("ok");
  });

  it("rejects a wrong signature without reaching BotState", async () => {
    const response = await post("/callback/test-channel-secret/token", BODY, "not-a-signature");
    expect(response.status).toBe(400);
    expect(response.headers.get("x-bot-state")).toBeNull();
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("token");
  });

  it("rejects a missing signature", async () => {
    const response = await post("/callback/test-channel-secret/token", BODY, null);
    expect(response.status).toBe(400);
    expect(response.headers.get("x-bot-state")).toBeNull();
  });

  it("does not treat healthz as a callback", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.com/healthz"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-bot-state")).toBeNull();
  });
});

async function post(path: string, body: string, signature: string | null): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("x-line-signature", signature);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`http://example.com${path}`, { method: "POST", headers, body }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return btoa(binary);
}
