import { readFileSync } from "node:fs";
import { formatMessages, type FormattedMessage } from "../src/line-client.ts";

type GoldenRow = { name?: unknown; calls?: unknown };

const fixturePath = process.argv[2] ?? new URL("../../fixtures/suite.json", import.meta.url);
const rows = rowsFrom(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown);
const required = [
  "image_reply_jpg_head_jpeg",
  "image_reply_txt_head_html",
  "image_reply_imgur_no_head",
  "image_11_imgur",
  "sticker_group",
];
const seen = new Set<string>();
let matched = 0;

for (const row of rows) {
  if (!isRow(row) || typeof row.name !== "string") throw new Error("fixture row missing name");
  seen.add(row.name);
  const calls = row.calls ?? [];
  if (!Array.isArray(calls)) throw new Error(`${row.name} calls must be an array`);
  if (row.name === "sticker_group" && calls.length !== 0) {
    throw new Error("sticker_group must not send a LINE message");
  }
  for (const call of calls) {
    const messages = callMessages(row.name, call);
    const reproduced = reproduce(messages);
    if (!same(reproduced, messages)) {
      throw new Error(
        `${row.name} payload mismatch\n got ${JSON.stringify(reproduced)}\n want ${JSON.stringify(messages)}`,
      );
    }
    matched += 1;
  }
}

for (const name of required) {
  if (!seen.has(name)) throw new Error(`fixture missing ${name}`);
}

const imgurText = messagesNamed(rows, "image_11_imgur");
const imgurUrl = imgurText[0];
if (imgurUrl === undefined || imgurUrl.type !== "text") throw new Error("image_11_imgur must be text");
const formatted = formatMessages({
  messages: [imgurUrl.text],
  format: true,
  isImageReady: () => false,
});
if (formatted[0]?.type !== "image") {
  throw new Error("an imgur URL must stay an image when format is on");
}

if (matched < 1) throw new Error("fixture comparison matched nothing");
console.log(`fixture calls matched: ${matched}`);

function reproduce(messages: FormattedMessage[]): FormattedMessage[] {
  if (messages.every(isText)) {
    const inputs = messages.map((message) => message.text);
    const asText = formatMessages({
      messages: inputs,
      format: true,
      isImageReady: () => false,
    });
    if (same(asText, messages)) return asText;
    return formatMessages({ messages: inputs, format: false });
  }
  if (messages.every(isImage)) {
    return formatMessages({
      messages: messages.map((message) => message.originalContentUrl),
      format: true,
      isImageReady: () => true,
    });
  }
  throw new Error(`unsupported fixture payload ${JSON.stringify(messages)}`);
}

function messagesNamed(source: GoldenRow[], name: string): FormattedMessage[] {
  for (const row of source) {
    if (!isRow(row) || row.name !== name) continue;
    const calls = row.calls;
    if (!Array.isArray(calls) || calls.length !== 1) throw new Error(`${name} must have one call`);
    const call = calls[0];
    if (call === undefined) throw new Error(`${name} missing call`);
    return callMessages(name, call);
  }
  throw new Error(`missing ${name}`);
}

function callMessages(name: string, call: unknown): FormattedMessage[] {
  if (!Array.isArray(call) || call.length !== 3 || !Array.isArray(call[2])) {
    throw new Error(`${name} call must be [kind, target, messages]`);
  }
  return call[2].map((message) => parseMessage(name, message));
}

function parseMessage(name: string, message: unknown): FormattedMessage {
  if (!isRow(message) || typeof message.type !== "string") {
    throw new Error(`${name} has a non-object message`);
  }
  if (message.type === "text" && typeof message.text === "string") {
    return { type: "text", text: message.text };
  }
  if (
    message.type === "image" &&
    typeof message.originalContentUrl === "string" &&
    typeof message.previewImageUrl === "string"
  ) {
    return {
      type: "image",
      originalContentUrl: message.originalContentUrl,
      previewImageUrl: message.previewImageUrl,
    };
  }
  throw new Error(`${name} has an unexpected message type ${message.type}`);
}

function rowsFrom(parsed: unknown): GoldenRow[] {
  if (Array.isArray(parsed)) return parsed.filter(isRow);
  if (isRow(parsed) && Array.isArray(parsed.steps)) {
    return parsed.steps.filter(isRow).map((step) => ({
      name: step.name,
      calls: isRow(step.expect) ? step.expect.calls : [],
    }));
  }
  throw new Error("unsupported fixture file");
}

function same(left: unknown, right: unknown): boolean {
  return canon(left) === canon(right);
}

function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canon(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isText(message: FormattedMessage): message is { type: "text"; text: string } {
  return message.type === "text";
}

function isImage(
  message: FormattedMessage,
): message is { type: "image"; originalContentUrl: string; previewImageUrl: string } {
  return message.type === "image";
}

function isRow(value: unknown): value is GoldenRow & Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
