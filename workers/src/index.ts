import { BotState, GLOBAL_BOT_STATE } from "./bot-state";
import { parseCallbackPath, verifyLineSignature } from "./line";

export { BotState };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
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
        if (!ok) return new Response("bad signature", { status: 400 });
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
