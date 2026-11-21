import { COLD_BOT_STATE } from "./blob-store";
import { BotState, GLOBAL_BOT_STATE } from "./bot-state";
import { IMPORT_SECRET_HEADER, importGate } from "./import-plan";
import { parseCallbackPath, verifyLineSignature } from "./line";

export { BotState };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (request.method === "GET" && url.pathname === "/ping") {
      return new Response("pong");
    }
    if (request.method === "POST" && url.pathname === "/import") {
      return forwardImport(request, env);
    }
    if (request.method === "POST" && url.pathname === "/import/kv") {
      return forwardImport(request, env, "/import/kv", COLD_BOT_STATE);
    }
    if (request.method === "POST") {
      const route = parseCallbackPath(url.pathname);
      if (route !== null) {
        const body = await request.arrayBuffer();
        const ok = await verifyLineSignature({
          secret: route.secret,
          body,
          signature: request.headers.get("x-line-signature"),
        });
        if (!ok) return new Response(null, { status: 400 });
        const stub = env.BOT_STATE.get(env.BOT_STATE.idFromName(GLOBAL_BOT_STATE));
        const forwarded = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body,
        });
        ctx.waitUntil(
          stub.fetch(forwarded).then(
            () => undefined,
            () => {
              throw new Error("BotState failed");
            },
          ),
        );
        return new Response("ok");
      }
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function forwardImport(
  request: Request,
  env: Env,
  pathname = "/import",
  objectName = GLOBAL_BOT_STATE,
): Promise<Response> {
  const presented = request.headers.get(IMPORT_SECRET_HEADER);
  const gate = importGate(env.IMPORT_SECRET, presented);
  if (gate === "disabled") return new Response("not found", { status: 404 });
  if (gate !== "ok" || presented === null) {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await request.arrayBuffer();
  const stub = env.BOT_STATE.get(env.BOT_STATE.idFromName(objectName));
  const headers = new Headers({ "content-type": "application/json" });
  headers.set(IMPORT_SECRET_HEADER, presented);
  return stub.fetch(
    new Request(new URL(pathname, request.url), {
      method: "POST",
      headers,
      body,
    }),
  );
}
