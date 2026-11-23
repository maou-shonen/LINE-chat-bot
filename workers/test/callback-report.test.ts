import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { COLD_BOT_STATE } from "../src/blob-store";
import type { BotState } from "../src/bot-state";
import { handleCallback, type DispatchEnv } from "../src/dispatch";
import type { BotRepository, TouchAndCount } from "../src/repository";

const OPINION_DONE = "訊息已經傳送啦\n回覆內容將在開發者回覆後任何一個有愛醬的地方於你說話後彈出";
const OPINION_UNSET = "回報功能尚未設定，著急的話請直接聯絡開發者";
const ERROR_REPLY = "愛醬出錯了！\n作者可能會察看此錯誤報告";
const DEVELOPER: DispatchEnv = { DEVELOPER_USER_ID: "D-developer", DEVELOPER_BOT_TOKEN: "T-developer" };
const GROUP = { type: "group", groupId: "C-report", userId: "U-report" };
const CALLBACK = "http://example.com/callback/test-secret/test-token";

type Call = [kind: string, target: string, messages: unknown];

let savedFetch: typeof fetch | null = null;

afterEach(() => {
  if (savedFetch !== null) globalThis.fetch = savedFetch;
  savedFetch = null;
  vi.restoreAllMocks();
});

describe("回報 and exception reporting", () => {
  it("counts 回報 and pushes the developer payload", async () => {
    const { repo, counts } = fakeRepo();
    const calls = stubLine({});
    await handleCallback(repo, callbackRequest([textEvent("回報=hello feedback", "rt-opinion")]), DEVELOPER);

    expect(counts).toHaveLength(1);
    expect(counts[0]?.delta).toEqual({ 觸發: 1 });
    expect(calls.map((call) => call[0])).toEqual(["push", "reply"]);
    const push = calls[0];
    expect(push?.[1]).toBe("D-developer");
    const lines = messageText(push?.[2]).split("\n");
    expect(lines.slice(1)).toEqual(["C-report", "U-report", "回報=hello feedback"]);
    expect(lines[0]).toMatch(/^[0-9a-f]{8}$/);
    expect(calls[1]?.[1]).toBe("rt-opinion");
    expect(messageText(calls[1]?.[2])).toBe(OPINION_DONE);
  });

  it("counts 回報 and replies unset when the developer is not configured", async () => {
    const { repo, counts } = fakeRepo();
    const calls = stubLine({});
    await handleCallback(repo, callbackRequest([textEvent("意見=hello", "rt-unset")]), {});

    expect(counts[0]?.delta).toEqual({ 觸發: 1 });
    expect(calls.map((call) => call[0])).toEqual(["reply"]);
    expect(calls[0]?.[1]).toBe("rt-unset");
    expect(messageText(calls[0]?.[2])).toBe(OPINION_UNSET);
  });

  it("reports an exception to the developer and the group without logging its message", async () => {
    const { repo, counts } = fakeRepo({ userName: async () => { throw new Error("boom"); } });
    const calls = stubLine({});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleCallback(repo, callbackRequest([textEvent("hello", "rt-error")]), DEVELOPER);

    expect(counts[0]?.delta).toEqual({ 對話: 1, 髒話: 0, 字數: 5 });
    expect(calls.map((call) => call[0])).toEqual(["push", "reply"]);
    expect(calls[0]?.[1]).toBe("D-developer");
    expect(messageText(calls[0]?.[2])).toBe("<愛醬BUG>\nboom");
    expect(calls[1]?.[1]).toBe("rt-error");
    expect(messageText(calls[1]?.[2])).toBe(ERROR_REPLY);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain("event failed type=message error=Error");
    expect(logged).not.toContain("boom");
  });

  it("still tells the group when the developer is not configured", async () => {
    const { repo } = fakeRepo({ userName: async () => { throw new Error("boom"); } });
    const calls = stubLine({});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleCallback(repo, callbackRequest([textEvent("hello", "rt-error-unset")]), {});

    expect(calls.map((call) => call[0])).toEqual(["reply"]);
    expect(messageText(calls[0]?.[2])).toBe(ERROR_REPLY);
    expect(warn.mock.calls.flat().join(" ")).toContain("error report not configured error=Error");
  });

  it("does not reject when the developer push fails", async () => {
    const { repo } = fakeRepo({ userName: async () => { throw new Error("boom"); } });
    const calls = stubLine({ failPush: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleCallback(repo, callbackRequest([textEvent("hello", "rt-push-down")]), DEVELOPER);

    // Python skips the chat reply when push_developer raises.
    expect(calls.map((call) => call[0])).toEqual(["push"]);
  });

  it("returns 200 when the LINE report calls fail", async () => {
    stubLine({ failReply: true, failProfile: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify({ destination: "x", events: [textEvent("回報=hi", "rt-500")] });
    const signature = await sign("test-secret", body);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(CALLBACK, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Line-Signature": signature },
        body,
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await waitOnExecutionContext(ctx);
    const stub = env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE)) as DurableObjectStub<BotState>;
    expect((await stub.inspectTouch()).counts["C-report\0U-report"]).toEqual({ 觸發: 1 });
  });
});

function fakeRepo(overrides: Partial<BotRepository> = {}): {
  repo: BotRepository;
  counts: TouchAndCount[];
} {
  const counts: TouchAndCount[] = [];
  const repo = {
    touchAndCount: async (input: TouchAndCount) => { counts.push(input); },
    userName: async () => "ProbeUser",
    setUserName: async () => {},
    ...overrides,
  } as unknown as BotRepository;
  return { repo, counts };
}

function stubLine(options: { failPush?: boolean; failReply?: boolean; failProfile?: boolean }): Call[] {
  if (savedFetch === null) savedFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/v2/bot/message/push") {
      const body = await jsonBody(init?.body);
      calls.push(["push", String(body.to), body.messages]);
      if (options.failPush === true) throw new Error("line down");
      return Response.json({});
    }
    if (url.pathname === "/v2/bot/message/reply") {
      const body = await jsonBody(init?.body);
      calls.push(["reply", String(body.replyToken), body.messages]);
      if (options.failReply === true) throw new Error("line down");
      return Response.json({});
    }
    if (/^\/v2\/bot\/(group|room)\/.+\/member\/.+$/.test(url.pathname)) {
      if (options.failProfile === true) throw new Error("line down");
      return Response.json({ displayName: "ProbeUser" });
    }
    throw new Error(`unmocked ${url.origin}${url.pathname}`);
  };
  return calls;
}

function callbackRequest(events: unknown[]): Request {
  return new Request(CALLBACK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination: "x", events }),
  });
}

function textEvent(text: string, replyToken: string): Record<string, unknown> {
  return {
    type: "message",
    replyToken,
    source: GROUP,
    timestamp: 1,
    message: { type: "text", id: `mid-${replyToken}`, text },
  };
}

async function jsonBody(body: BodyInit | null | undefined): Promise<Record<string, unknown>> {
  return typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : {};
}

function messageText(messages: unknown): string {
  const first = Array.isArray(messages) ? messages[0] : undefined;
  return first !== null && typeof first === "object" && "text" in first && typeof first.text === "string"
    ? first.text
    : "";
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
  return btoa(String.fromCharCode(...mac));
}
