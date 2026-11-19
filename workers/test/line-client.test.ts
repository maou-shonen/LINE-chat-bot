import { describe, expect, it } from "vitest";
import {
  LineApiError,
  createLineClient,
  deliver,
  formatMessages,
  type LineClient,
} from "../src/line-client";

const TOKEN = "test-token";

describe("formatMessages", () => {
  it("turns a plain string into one text message", () => {
    expect(formatMessages({ messages: "hide2" })).toEqual([{ type: "text", text: "hide2" }]);
  });

  it("strips edge pipes, underscores, spaces, and newlines", () => {
    expect(formatMessages({ messages: " |hello_ \n" })).toEqual([{ type: "text", text: "hello" }]);
    expect(formatMessages({ messages: "a|b" })).toEqual([{ type: "text", text: "a|b" }]);
  });

  it("skips blank and non-string items, then uses the placeholder", () => {
    expect(formatMessages({ messages: [null, "  ", 1] })).toEqual([
      { type: "text", text: "<此為空白內容>\n<由設定錯誤引發>" },
    ]);
  });

  it("caps a reply at five messages", () => {
    const messages = ["a", "b", "c", "d", "e", "f"];
    expect(formatMessages({ messages }).map((message) => message.type === "text" && message.text)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("truncates a long text the way the Python client does", () => {
    const body = "字".repeat(1500);
    expect(formatMessages({ messages: `${body}更多` })).toEqual([
      { type: "text", text: `${body}\n<字數過多 後略>` },
    ]);
  });

  it("sends a probed jpeg URL as an image and a non-image URL as text", () => {
    const jpeg = "https://example.com/a.jpg";
    const textUrl = "https://example.com/d.txt";
    expect(formatMessages({ messages: jpeg, isImageReady: () => true })).toEqual([
      { type: "image", originalContentUrl: jpeg, previewImageUrl: jpeg },
    ]);
    expect(formatMessages({ messages: textUrl, isImageReady: () => false })).toEqual([
      { type: "text", text: textUrl },
    ]);
  });

  it("treats an imgur URL as an image without calling the probe", () => {
    let probed = 0;
    const url = "https://i.imgur.com/abc.jpg";
    expect(
      formatMessages({
        messages: url,
        isImageReady: () => {
          probed += 1;
          return false;
        },
      }),
    ).toEqual([{ type: "image", originalContentUrl: url, previewImageUrl: url }]);
    expect(probed).toBe(0);
  });

  it("repairs imgur http and mobile hosts before choosing image", () => {
    expect(formatMessages({ messages: "http://m.imgur.com/abc" })).toEqual([
      {
        type: "image",
        originalContentUrl: "https://i.imgur.com/abc",
        previewImageUrl: "https://i.imgur.com/abc",
      },
    ]);
  });

  it("does not append .jpg to an extension-less imgur URL", () => {
    const url = "https://i.imgur.com/abc";
    expect(formatMessages({ messages: url })[0]).toEqual({
      type: "image",
      originalContentUrl: url,
      previewImageUrl: url,
    });
  });

  it("keeps a URL as text when formatting is off", () => {
    const url = "https://i.imgur.com/golden.jpg";
    expect(formatMessages({ messages: url, format: false, isImageReady: () => true })).toEqual([
      { type: "text", text: url },
    ]);
  });

  it("treats a throwing probe as not an image", () => {
    expect(
      formatMessages({
        messages: "https://example.com/a.jpg",
        isImageReady: () => {
          throw new Error("probe down");
        },
      }),
    ).toEqual([{ type: "text", text: "https://example.com/a.jpg" }]);
  });
});

describe("LINE reply and push", () => {
  it("posts the Python reply body and bearer token", async () => {
    const seen = installFetch();
    const client = clientWith(seen.fetch);
    await client.reply({ replyToken: "RT1", messages: [{ type: "text", text: "hi" }] });
    expect(seen.calls).toEqual([
      {
        url: "https://api.line.me/v2/bot/message/reply",
        auth: `Bearer ${TOKEN}`,
        json: { replyToken: "RT1", messages: [{ type: "text", text: "hi" }] },
      },
    ]);
  });

  it("posts the Python push body", async () => {
    const seen = installFetch();
    const client = clientWith(seen.fetch);
    await client.push({ to: "U9", messages: [{ type: "text", text: "hello" }] });
    expect(seen.calls).toEqual([
      {
        url: "https://api.line.me/v2/bot/message/push",
        auth: `Bearer ${TOKEN}`,
        json: { to: "U9", messages: [{ type: "text", text: "hello" }] },
      },
    ]);
  });

  it("posts a sticker object unchanged", async () => {
    const seen = installFetch();
    const client = clientWith(seen.fetch);
    const sticker = { type: "sticker" as const, packageId: "1", stickerId: "1" };
    await client.reply({ replyToken: "rt-sticker", messages: [sticker] });
    expect(seen.calls[0]?.json).toEqual({ replyToken: "rt-sticker", messages: [sticker] });
  });

  it("uses the injected API base and does not call global fetch", async () => {
    const seen = installFetch();
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("unexpected network fetch");
    };
    try {
      const client = createLineClient({
        token: TOKEN,
        apiBase: "https://line.example/",
        fetch: seen.fetch,
      });
      await client.push({ to: "U9", messages: [{ type: "text", text: "hi" }] });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen.calls[0]?.url).toBe("https://line.example/v2/bot/message/push");
  });

  it("raises on a non-2xx reply without including the token", async () => {
    const seen = installFetch(400);
    const client = clientWith(seen.fetch);
    const error = await client
      .reply({ replyToken: "RT1", messages: [{ type: "text", text: "hi" }] })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    if (!(error instanceof LineApiError)) throw error;
    expect(error.status).toBe(400);
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("deliver", () => {
  it("replies once with every formatted message when a reply token is present", async () => {
    const seen = installFetch();
    const client = clientWith(seen.fetch, () => true);
    const sent = await deliver(client, {
      to: "U1",
      messages: ["https://example.com/a.jpg", "hello"],
      replyToken: "rt-1",
      canPush: true,
    });
    expect(sent).toBe(true);
    expect(seen.calls).toHaveLength(1);
    expect(seen.calls[0]?.url).toBe("https://api.line.me/v2/bot/message/reply");
    expect(seen.calls[0]?.json).toEqual({
      replyToken: "rt-1",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/a.jpg",
          previewImageUrl: "https://example.com/a.jpg",
        },
        { type: "text", text: "hello" },
      ],
    });
  });

  it("does not push when reply fails, even if push is allowed", async () => {
    const seen = installFetch(400);
    const client = clientWith(seen.fetch);
    const sent = await deliver(client, {
      to: "U1",
      messages: ["hello"],
      replyToken: "rt-expired",
      canPush: true,
    });
    expect(sent).toBe(false);
    expect(seen.calls.map((call) => call.url)).toEqual(["https://api.line.me/v2/bot/message/reply"]);
  });

  it("pushes one formatted message at a time when there is no reply token", async () => {
    const seen = installFetch();
    const client = clientWith(seen.fetch, (url) => url.endsWith(".jpg"));
    const sent = await deliver(client, {
      to: "U9",
      messages: ["https://example.com/a.jpg", "hello"],
      replyToken: "",
      canPush: true,
    });
    expect(sent).toBe(true);
    expect(seen.calls.map((call) => call.url)).toEqual([
      "https://api.line.me/v2/bot/message/push",
      "https://api.line.me/v2/bot/message/push",
    ]);
    expect(seen.calls[0]?.json).toEqual({
      to: "U9",
      messages: [
        {
          type: "image",
          originalContentUrl: "https://example.com/a.jpg",
          previewImageUrl: "https://example.com/a.jpg",
        },
      ],
    });
    expect(seen.calls[1]?.json).toEqual({
      to: "U9",
      messages: [{ type: "text", text: "hello" }],
    });
  });

  it("accepts one string the way Bot.push does", async () => {
    const seen = installFetch();
    const client = clientWith(seen.fetch);
    const sent = await deliver(client, {
      to: "U1",
      messages: "hello",
      replyToken: "rt-1",
      canPush: false,
    });
    expect(sent).toBe(true);
    expect(seen.calls[0]?.json).toEqual({
      replyToken: "rt-1",
      messages: [{ type: "text", text: "hello" }],
    });
  });

  it("keeps pushing later messages after one push fails", async () => {
    const seen = installFetch(500, 200);
    const client = clientWith(seen.fetch);
    const sent = await deliver(client, {
      to: "U9",
      messages: ["first", "second"],
      canPush: true,
    });
    expect(sent).toBe(true);
    expect(seen.calls).toHaveLength(2);
  });

  it("sends nothing for an empty list or when push is disabled", async () => {
    const seen = installFetch();
    const client = clientWith(seen.fetch);
    expect(await deliver(client, { to: "U9", messages: [], canPush: true })).toBe(false);
    expect(await deliver(client, { to: "U9", messages: ["hi"], canPush: false })).toBe(false);
    expect(seen.calls).toEqual([]);
  });
});

function clientWith(fetchImpl: typeof fetch, isImageReady?: (url: string) => boolean): LineClient {
  return createLineClient({ token: TOKEN, fetch: fetchImpl, isImageReady });
}

function installFetch(...statuses: number[]) {
  const calls: { url: string; auth: string | null; json: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : "";
    calls.push({
      url,
      auth: headers.get("authorization"),
      json: raw === "" ? null : JSON.parse(raw),
    });
    const status = statuses[calls.length - 1] ?? statuses.at(-1) ?? 200;
    return new Response("{}", { status });
  };
  return { calls, fetch: fetchImpl };
}
