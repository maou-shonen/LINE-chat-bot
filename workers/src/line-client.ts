// shortcut: length is UTF-16 code units, not Python code points. Upgrade if a reply can contain non-BMP text.

const PLACEHOLDER = "<此為空白內容>\n<由設定錯誤引發>";
const TRUNCATION_MARK = "\n<字數過多 後略>";
const TEXT_LIMIT = 1500;
const MESSAGE_CAP = 5;
const REPLY_PATH = "/v2/bot/message/reply";
const PUSH_PATH = "/v2/bot/message/push";

export type LineText = { type: "text"; text: string };
export type LineImage = {
  type: "image";
  originalContentUrl: string;
  previewImageUrl: string;
};
export type LineSticker = {
  type: "sticker";
  packageId: string;
  stickerId: string;
};
export type LineMessage = LineText | LineImage | LineSticker;
export type FormattedMessage = LineText | LineImage;

export class LineApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`LINE API ${status}`);
    this.name = "LineApiError";
    this.status = status;
  }
}

export function formatMessages(input: {
  messages: string | readonly unknown[];
  format?: boolean;
  isImageReady?: (url: string) => boolean;
}): FormattedMessage[] {
  const format = input.format !== false;
  const probe = input.isImageReady ?? (() => false);
  const source = typeof input.messages === "string" ? [input.messages] : input.messages;
  const contents: FormattedMessage[] = [];
  for (const item of source) {
    if (typeof item !== "string") continue;
    const message = stripEdges(item);
    if (message === "") continue;
    contents.push(format ? shape(message, probe) : { type: "text", text: message });
  }
  if (contents.length === 0) {
    contents.push({ type: "text", text: PLACEHOLDER });
  }
  return contents.slice(0, MESSAGE_CAP);
}

export interface LineClient {
  format(input: {
    messages: string | readonly unknown[];
    format?: boolean;
  }): FormattedMessage[];
  reply(input: { replyToken: string; messages: readonly LineMessage[] }): Promise<void>;
  push(input: { to: string; messages: readonly LineMessage[] }): Promise<void>;
}

export function createLineClient(input: {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
  isImageReady?: (url: string) => boolean;
}): LineClient {
  const apiBase = (input.apiBase ?? "https://api.line.me").replace(/\/+$/, "");
  const doFetch = input.fetch ?? fetch;
  const isImageReady = input.isImageReady;
  return {
    format(args) {
      return formatMessages({ ...args, isImageReady });
    },
    reply(args) {
      return post(doFetch, input.token, `${apiBase}${REPLY_PATH}`, {
        replyToken: args.replyToken,
        messages: args.messages,
      });
    },
    push(args) {
      return post(doFetch, input.token, `${apiBase}${PUSH_PATH}`, {
        to: args.to,
        messages: args.messages,
      });
    },
  };
}

export async function deliver(
  client: Pick<LineClient, "format" | "reply" | "push">,
  input: {
    to: string;
    messages: unknown;
    replyToken?: string | null;
    canPush: boolean;
    format?: boolean;
  },
): Promise<boolean> {
  const list = Array.isArray(input.messages) ? [...input.messages] : [input.messages];
  if (list.length === 0) return false;
  const format = input.format !== false;
  const replyToken = input.replyToken;
  if (typeof replyToken === "string" && replyToken.length > 0) {
    try {
      await client.reply({
        replyToken,
        messages: client.format({ messages: list, format }),
      });
      return true;
    } catch {
      return false;
    }
  }
  if (!input.canPush) return false;
  while (list.length > 0) {
    const next = list.shift();
    try {
      await client.push({
        to: input.to,
        messages: client.format({ messages: [next], format }),
      });
    } catch {
      // Python logs the failure and still pushes the rest.
    }
  }
  return true;
}

function shape(message: string, probe: (url: string) => boolean): FormattedMessage {
  const repaired = repairImageUrl(message);
  if (repaired.startsWith("https:")) {
    if (repaired.includes("imgur.com") || imageReady(probe, repaired)) {
      return {
        type: "image",
        originalContentUrl: repaired,
        previewImageUrl: repaired,
      };
    }
    return { type: "text", text: repaired };
  }
  if (repaired.length < TEXT_LIMIT) return { type: "text", text: repaired };
  return { type: "text", text: repaired.slice(0, TEXT_LIMIT) + TRUNCATION_MARK };
}

function repairImageUrl(message: string): string {
  if (!message.includes("imgur.com")) return message;
  return message.replaceAll("http:", "https:").replaceAll("m.imgur.com", "i.imgur.com");
}

function imageReady(probe: (url: string) => boolean, url: string): boolean {
  try {
    return probe(url);
  } catch {
    return false;
  }
}

function stripEdges(value: string): string {
  return value.replace(/^[|_ \n]+|[|_ \n]+$/g, "");
}

async function post(
  doFetch: typeof fetch,
  token: string,
  url: string,
  body:
    | { replyToken: string; messages: readonly LineMessage[] }
    | { to: string; messages: readonly LineMessage[] },
): Promise<void> {
  const response = await doFetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new LineApiError(response.status);
}
