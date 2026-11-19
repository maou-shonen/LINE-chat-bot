import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src";

const SECRET = "test-channel-secret";
const BODY = '{"events":[]}';

describe("LINE signature gate", () => {
  it("accepts a valid signature and returns ok without the BotState header", async () => {
    const response = await post("/callback/test-channel-secret/token/with/slash", BODY, await sign(SECRET, BODY));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-bot-state")).toBeNull();
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
    const response = await worker.fetch(new Request("http://example.com/healthz"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("x-bot-state")).toBeNull();
  });

  it("returns 200 before BotState finishes", async () => {
    const secret = "sec-do-not-log";
    const token = "tok-do-not-log";
    let release = (_response: Response) => {};
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let started = false;
    const ctx = createExecutionContext();
    let waited: Promise<unknown> | undefined;
    const waitUntil = ctx.waitUntil.bind(ctx);
    ctx.waitUntil = (promise) => {
      waited = promise;
      waitUntil(promise);
    };
    const logs = captureConsole();
    try {
      const response = await worker.fetch(
        callbackRequest(`/callback/${secret}/${token}`, BODY, await sign(secret, BODY)),
        envWith({
          fetch: async (request) => {
            started = true;
            expect(new URL(request.url).pathname).toBe(`/callback/${secret}/${token}`);
            expect(await request.text()).toBe(BODY);
            return gate;
          },
        }),
        ctx,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      expect(started).toBe(true);
      expect(waited).toBeDefined();
      release(new Response("late"));
      await waited;
      await waitOnExecutionContext(ctx);
    } finally {
      logs.restore();
    }
    expect(logs.text()).not.toContain(secret);
    expect(logs.text()).not.toContain(token);
  }, 1000);

  it("does not call BotState when the signature is wrong", async () => {
    let called = false;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      callbackRequest("/callback/test-channel-secret/token", BODY, "not-a-signature"),
      envWith({
        fetch: async () => {
          called = true;
          return new Response("no");
        },
      }),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("hides the callback path when BotState rejects", async () => {
    const secret = "sec-reject-path";
    const token = "tok-reject-path";
    const ctx = createExecutionContext();
    const logs = captureConsole();
    try {
      const response = await worker.fetch(
        callbackRequest(`/callback/${secret}/${token}`, BODY, await sign(secret, BODY)),
        envWith({
          fetch: async () => {
            throw new Error(`failed ${secret} ${token}`);
          },
        }),
        ctx,
      );
      expect(response.status).toBe(200);
      const failure = await waitOnExecutionContext(ctx).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) {
        expect(failure.message).toBe("BotState failed");
        expect(failure.message).not.toContain(secret);
      }
    } finally {
      logs.restore();
    }
    expect(logs.text()).not.toContain(secret);
    expect(logs.text()).not.toContain(token);
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

function callbackRequest(path: string, body: string, signature: string): Request<unknown, IncomingRequestCfProperties> {
  return new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body,
  });
}

function envWith(stub: { fetch(request: Request): Promise<Response> }): Env {
  const botState = {
    idFromName: (name: string) => env.BOT_STATE.idFromName(name),
    get: () => stub,
  };
  return { ...env, BOT_STATE: botState } as unknown as Env;
}

function captureConsole(): { restore: () => void; text: () => string } {
  const lines: string[] = [];
  const spy = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((name) => console[name]);
  for (const name of methods) console[name] = spy;
  return {
    restore() {
      methods.forEach((name, index) => {
        const original = saved[index];
        if (original !== undefined) console[name] = original;
      });
    },
    text: () => lines.join("\n"),
  };
}
