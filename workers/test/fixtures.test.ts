import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src";
import type { BotState } from "../src/bot-state";
import { COLD_BOT_STATE } from "../src/blob-store";
import suiteJson from "../../fixtures/suite.json";

interface Step {
  name: string;
  request: { method: string; path: string; headers?: Record<string, string>; body?: string };
  rng?: unknown[];
  random_org?: number[];
  safe_browsing?: string;
  epoch?: number;
  head_map?: Record<string, string>;
  expect: {
    status: number;
    body: string;
    calls: unknown[];
    db?: { keywords?: unknown; settings?: unknown; counts?: unknown };
  };
}

interface Suite {
  harness: {
    frozen_now: string;
    epoch: number;
    profile_display_name: string;
    room_profile_status: number;
    imgur_link: string;
    image_content_b64: string;
    head_defaults: Array<[string, string]>;
    head_fallback: string;
  };
  defaults: { safe_browsing: string };
  steps: Step[];
}

const suite = suiteJson as unknown as Suite;

describe("fixture suite", () => {
  it("replays every step", async () => {
    const failures: string[] = [];
    const stub = env.BOT_STATE.get(env.BOT_STATE.idFromName(COLD_BOT_STATE)) as DurableObjectStub<BotState>;
    for (const step of suite.steps) {
      try {
      const calls = installFetch(step);
      const ctx = createExecutionContext();
      const headers = new Headers(step.request.headers ?? {});
      headers.set("x-fixture-rng", JSON.stringify(step.rng ?? []));
      headers.set("x-frozen-epoch", String(step.epoch ?? suite.harness.epoch));
      headers.set("x-frozen-now", suite.harness.frozen_now.replace("T", " "));
      headers.set(
        "x-fixture-safe-browsing",
        step.safe_browsing ?? suite.defaults.safe_browsing,
      );
      const response = await worker.fetch(
        new Request(`http://example.com${step.request.path}`, {
          method: step.request.method,
          headers,
          body: step.request.body,
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      const body = await response.text();
      if (response.status !== step.expect.status || body !== step.expect.body) {
        failures.push(`${step.name} http ${response.status} ${JSON.stringify(body)}`);
      }
      const slices = await stub.fixtureSlices();
      if (step.expect.db?.keywords !== undefined && !same(sortTriples(slices.keywords), step.expect.db.keywords)) {
        failures.push(`${step.name} keywords`);
      }
      if (step.expect.db?.settings !== undefined && !same(sortTriples(keptSettings(slices.settings)), keptSettings(step.expect.db.settings))) {
        failures.push(`${step.name} settings ${diffRows(sortTriples(keptSettings(slices.settings)), keptSettings(step.expect.db.settings))}`);
      }
      if (step.expect.db?.counts !== undefined && !same(slices.counts, step.expect.db.counts)) {
        failures.push(`${step.name} counts`);
      }
      if (!same(calls, step.expect.calls)) {
        failures.push(`${step.name} calls got ${JSON.stringify(calls).slice(0, 180)}`);
      }
      restoreFetch();
      } catch (error) {
        restoreFetch();
        failures.push(`${step.name} threw ${error instanceof Error ? error.message : "error"}`);
      }
      if (failures.length > 12) break;
    }
    expect(failures).toEqual([]);
  });
});

let savedFetch: typeof fetch | null = null;

function installFetch(step: Step): unknown[] {
  const calls: unknown[] = [];
  if (savedFetch === null) savedFetch = globalThis.fetch;
  const image = Uint8Array.from(atob(suite.harness.image_content_b64), (ch) => ch.charCodeAt(0));
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.origin === "https://api.line.me" && url.pathname === "/v2/bot/message/reply") {
      const body = await readJson(init?.body);
      calls.push(["reply", textField(body, "replyToken"), field(body, "messages")]);
      return Response.json({});
    }
    if (url.origin === "https://api.line.me" && url.pathname === "/v2/bot/message/push") {
      const body = await readJson(init?.body);
      calls.push(["push", textField(body, "to"), field(body, "messages")]);
      return Response.json({});
    }
    if (url.origin === "https://api.line.me" && /^\/v2\/bot\/group\/.+\/member\/.+$/.test(url.pathname)) {
      return Response.json({ displayName: suite.harness.profile_display_name });
    }
    if (url.origin === "https://api.line.me" && /^\/v2\/bot\/room\/.+\/member\/.+$/.test(url.pathname)) {
      return Response.json({}, { status: suite.harness.room_profile_status });
    }
    if (url.origin === "https://api-data.line.me" && url.pathname.endsWith("/content")) {
      return new Response(image);
    }
    if (url.origin === "https://api.imgur.com" && url.pathname === "/3/image") {
      return Response.json({ data: { link: suite.harness.imgur_link } });
    }
    if (url.origin === "https://safebrowsing.googleapis.com") return Response.json({});
    if (url.hostname === "www.random.org") {
      const num = Number(url.searchParams.get("num") ?? "1");
      const vals = step.random_org ?? Array.from({ length: num }, () => 0);
      return new Response(`${vals.slice(0, num).join("\n")}\n`);
    }
    if (method === "HEAD") {
      return new Response(null, { headers: { "content-type": headType(step, url.href) } });
    }
    throw new Error(`unmocked ${method} ${url.origin}${url.pathname}`);
  };
  return calls;
}

function restoreFetch(): void {
  if (savedFetch !== null) globalThis.fetch = savedFetch;
}

function headType(step: Step, href: string): string {
  const mapped = step.head_map?.[href];
  if (mapped !== undefined) return mapped;
  for (const pair of suite.harness.head_defaults) {
    const suffix = pair[0];
    const type = pair[1];
    if (suffix !== undefined && type !== undefined && href.endsWith(suffix)) return type;
  }
  return suite.harness.head_fallback;
}

async function readJson(body: BodyInit | null | undefined): Promise<unknown> {
  if (typeof body !== "string") return {};
  return JSON.parse(body) as unknown;
}

function field(body: unknown, key: string): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const found = Object.entries(body).find(([name]) => name === key);
  return found === undefined ? undefined : found[1];
}

function textField(body: unknown, key: string): string {
  const value = field(body, key);
  return typeof value === "string" ? value : "";
}

function keptSettings(rows: unknown): Array<readonly unknown[]> {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is readonly unknown[] => Array.isArray(row) && row[2] !== "{}");
}

function sortTriples(rows: ReadonlyArray<readonly unknown[]>): unknown[] {
  return [...rows].sort((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      const left = a[i] === null || a[i] === undefined ? "" : String(a[i]);
      const right = b[i] === null || b[i] === undefined ? "" : String(b[i]);
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return 0;
  });
}

function diffRows(got: unknown, want: unknown): string {
  const left = Array.isArray(got) ? got.map((row) => JSON.stringify(row)) : [];
  const right = Array.isArray(want) ? want.map((row) => JSON.stringify(row)) : [];
  const extra = left.filter((row) => !right.includes(row));
  const missing = right.filter((row) => !left.includes(row));
  return `extra ${extra.slice(0, 4).join(" | ")} missing ${missing.slice(0, 4).join(" | ")}`;
}

function same(got: unknown, want: unknown): boolean {
  return JSON.stringify(got) === JSON.stringify(want);
}
