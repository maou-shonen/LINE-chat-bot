import { applyCountMessage } from "./handler";
import { renderReply, randomOrgUrl, type Rng } from "./gacha";
import {
  matchKeyword,
  normalizeKeywordMessage,
  playRng,
  UNKNOWN_REPLIES,
  type KeywordRow,
  type RngOp,
} from "./keywords";
import { createLineClient, deliver } from "./line-client";
import type { BotRepository } from "./repository";
import { applyRecall } from "./recall";
import { applyKeywordCommand } from "./commands/keywords";
import { applySettingsCommand, readReplyFlags, settleSleep } from "./commands/settings";

const HELP = `「說明」(本說明)
「學習=<關鍵字>=<內容>」
「刪除=<關鍵字>」
「列表」
「設定=<功能>=<開關/值>」(群)
「意見=<內容>」
「回憶」(群)
「愛醬睡覺」(群)
「愛醬起床」(群)

<>代表可以省略
省略後可以查詢說明
(群)代表群組限定

※如果使用愛醬攻擊別人產生問題
依照LINE官方紀錄為主處理
※作者絕對不會儲存你的對話內容
但不建議你在需要保密的地方使用
詳細說明 goo.gl/xMtima`;

const OPINION_HELP = `「回報=<內容>」
有任何建議、錯誤、檢舉都可以使用此功能傳送訊息給開發者
由於愛醬沒有主動傳送訊息的權限
回覆內容將在開發者回覆後任何一個有愛醬的地方於你說話後彈出
也可以使用此表單填寫
goo.gl/forms/YXPpl5TgT8A3SRs82`;

const DEFAULT_REPLY = `指令說明輸入「說明」
<個人服務>
直接傳圖給愛醬即可上傳到圖床
其他功能如果有建議請使用「回報」`;

const JOIN_USER = `只是個做好玩的機器人
用來群組打圖戰或嘴砲用
還有一些小功能(慢慢新增)
詳細輸入「說明」查詢
goo.gl/xMtima`;

const JOIN_GROUP = [
  `愛醬入侵此群組啦！
愛醬是嘴砲、圖包、小工具的機器人
不是聊天機器人喔
(對話模組製作中)
功能輸入「說明」查詢
詳細說明 goo.gl/xMtima`,
  `預設是沒有詞庫的
如需要使用共用詞庫輸入
「設定=全回應」開啟`,
];

const NAME = "愛醬";
const LOGS: Record<string, true> = { log: true, logs: true, 紀錄: true, 回憶: true };
const HELP_ORDERS: Record<string, true> = {
  "-?": true,
  "-h": true,
  help: true,
  說明: true,
  指令: true,
  命令: true,
};
const OPINION: Record<string, true> = {
  "-o": true,
  opinion: true,
  意見: true,
  建議: true,
  回報: true,
  檢舉: true,
};

const IMAGE_TYPES: Record<string, true> = { "image/jpeg": true, "image/png": true };

export async function handleCallback(
  repo: BotRepository,
  request: Request,
): Promise<void> {
  const route = new URL(request.url).pathname.match(/^\/callback\/([^/]+)\/(.+)$/);
  const token = route?.[2] === undefined ? "" : safeDecode(route[2]);
  let payload: unknown = {};
  try {
    payload = await request.json();
  } catch {
    payload = {};
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
  const events = (payload as { events?: unknown }).events;
  if (!Array.isArray(events)) return;
  const epoch = headerNumber(request, "x-frozen-epoch") ?? Date.now() / 1000;
  const now = request.headers.get("x-frozen-now") ?? "2023-11-14 22:13:20";
  const rng = parseRng(request.headers.get("x-fixture-rng"));
  const safe = request.headers.get("x-fixture-safe-browsing") ?? "clean";
  for (const event of events) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) continue;
    await handleEvent(repo, event as Record<string, unknown>, {
      token,
      epoch,
      now,
      rng,
      safe,
      fetch: fetch.bind(globalThis),
    });
  }
}

async function handleEvent(
  repo: BotRepository,
  event: Record<string, unknown>,
  clock: {
    token: string;
    epoch: number;
    now: string;
    rng: RngOp[];
    safe: string;
    fetch: typeof fetch;
  },
): Promise<void> {
  const type = event.type;
  const source = sourceIds(event.source);
  const replyToken = typeof event.replyToken === "string" ? event.replyToken : null;
  if (type === "follow") {
    await send(clock, source.userId, replyToken, [JOIN_USER]);
    return;
  }
  if (type === "join") {
    await send(clock, source.groupId, replyToken, JOIN_GROUP);
    return;
  }
  if (type === "unfollow" || type === "leave" || type === "postback") return;
  if (type !== "message") return;
  const message = event.message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) return;
  const record = message as Record<string, unknown>;
  const kind = record.type;
  if (kind === "sticker") {
    await applyCountMessage(repo, { kind: "sticker", source }, clock.now);
    await refreshName(repo, source, clock);
    return;
  }
  if (kind === "image") {
    await applyCountMessage(repo, { kind: "image", source }, clock.now);
    if (source.groupId === null && source.userId !== null && typeof record.id === "string") {
      const link = await uploadImage(clock.fetch, record.id, clock.token);
      await send(clock, source.userId, replyToken, [link], false);
    }
    await refreshName(repo, source, clock);
    return;
  }
  if (kind !== "text" || typeof record.text !== "string") return;
  const text = record.text;
  await applyCountMessage(repo, { kind: "text", text, source }, clock.now);
  const replies = await decide(repo, text, source, clock);
  const target = source.groupId ?? source.userId;
  if (replies !== null && target !== null) {
    await send(clock, target, replyToken, replies);
  }
  await refreshName(repo, source, clock);
}

async function decide(
  repo: BotRepository,
  text: string,
  source: { userId: string | null; groupId: string | null },
  clock: { epoch: number; now: string; rng: RngOp[]; safe: string; fetch: typeof fetch; token: string },
): Promise<readonly string[] | null> {
  const normalized = text.replaceAll('"', "\uFF02").replaceAll("'", "\u2019").replaceAll(";", "\uFF1B");
  const parsed = parseOrder(normalized);
  if (source.groupId !== null) {
    const settings = await applySettingsCommand(repo, {
      text: normalized,
      groupId: source.groupId,
      userId: source.userId,
      epoch: clock.epoch,
    });
    if (settings.kind === "reply") return settings.messages;
    if (LOGS[parsed.order] === true) {
      return [
        await applyRecall(repo, {
          groupId: source.groupId,
          userId: source.userId,
          key: parsed.key,
          value: parsed.value,
        }),
      ];
    }
  }
  if (HELP_ORDERS[parsed.order] === true) return [HELP];
  const name = source.userId === null ? null : await currentName(repo, source.userId);
  const keywords = await applyKeywordCommand({
    upsertKeyword: (input) => repo.upsertKeyword(input),
    deleteKeyword: (input) => repo.deleteKeyword(input),
    getKeyword: (input) => repo.getKeyword(input),
    listKeywords: (scopeId) => repo.listKeywords(scopeId),
  }, {
    text: normalized,
    groupId: source.groupId,
    userId: source.userId,
    displayName: name,
    now: clock.now,
  });
  if (keywords.kind === "reply") return keywords.messages;
  if (OPINION[parsed.order] === true) {
    return [parsed.key === null ? OPINION_HELP : "回報功能尚未設定，著急的話請直接聯絡開發者"];
  }
  return mainReply(repo, normalized, source, clock);
}

async function mainReply(
  repo: BotRepository,
  text: string,
  source: { userId: string | null; groupId: string | null },
  clock: { epoch: number; now: string; rng: RngOp[]; safe: string; fetch: typeof fetch },
): Promise<readonly string[] | null> {
  if (text.includes("http:") || text.includes("https:")) {
    if (source.groupId !== null) return safeBrowsing(clock.fetch, text, clock.safe);
  }
  let message = stripEnds(text.toLowerCase());
  if (message === "") return null;
  const script = playRng(clock.rng);
  const rng: Rng = script;
  if (source.groupId !== null && message !== NAME && message.startsWith(NAME)) {
    const stripped = stripEnds(message.slice(NAME.length));
    const forced = await probe(repo, stripped, source.groupId, source.userId, false, false, rng, clock);
    if (forced !== null) {
      script.finish();
      await bumpTrigger(repo, source, clock.now);
      return forced;
    }
    const personal = source.userId === null
      ? null
      : await probe(repo, stripped, source.userId, source.userId, false, false, rng, clock);
    if (personal !== null) {
      script.finish();
      await bumpTrigger(repo, source, clock.now);
      return personal;
    }
  }
  if (source.groupId !== null) {
    const sleep = await settleSleep(repo, { groupId: source.groupId, epoch: clock.epoch });
    if (sleep.kind === "expired") {
      script.finish();
      return sleep.messages;
    }
    if (sleep.kind === "sleeping") {
      script.finish();
      return null;
    }
  }
  const userFlags = source.groupId === null || source.userId === null
    ? { 個人詞庫: false, 別理我: false }
    : await readUserFlags(repo, source.groupId, source.userId);
  if (source.groupId === null || userFlags.個人詞庫) {
    if (source.userId !== null) {
      const hit = await probe(repo, message, source.userId, source.userId, false, false, rng, clock);
      if (hit !== null) {
        script.finish();
        await bumpTrigger(repo, source, clock.now);
        return hit;
      }
    }
  }
  if (source.groupId !== null && source.userId !== null && !userFlags.別理我) {
    const hit = await probe(repo, message, source.groupId, source.userId, false, false, rng, clock);
    if (hit !== null) {
      script.finish();
      await bumpTrigger(repo, source, clock.now);
      return hit;
    }
  }
  if (message.startsWith(NAME) || source.groupId === null) {
    const groupFlags = source.groupId === null
      ? { 全回應: false, 全圖片: false }
      : await readGroupFlags(repo, source.groupId);
    if (source.groupId === null || groupFlags.全回應) {
      let body = message;
      if (message !== NAME && message.startsWith(NAME)) body = stripEnds(message.slice(NAME.length));
      const excludeUrl = source.groupId !== null && !groupFlags.全圖片;
      const hit = await probe(repo, body, null, source.userId, true, excludeUrl, rng, clock);
      if (hit !== null) {
        script.finish();
        await bumpTrigger(repo, source, clock.now);
        return hit;
      }
      if (source.groupId !== null) {
        const unknown = script.choice(UNKNOWN_REPLIES);
        script.finish();
        return [unknown];
      }
    } else if (source.groupId !== null) {
      const unknown = script.choice(UNKNOWN_REPLIES);
      script.finish();
      return [`${unknown}\n(全回應模式關閉)\n使用「設定」開啟`];
    }
  }
  script.finish();
  if (source.groupId === null) return [DEFAULT_REPLY];
  return null;
}

async function probe(
  repo: BotRepository,
  message: string,
  scopeId: string | null,
  userId: string | null,
  allReply: boolean,
  excludeUrl: boolean,
  rng: Rng,
  clock: { now: string; fetch: typeof fetch },
): Promise<string[] | null> {
  const normalized = normalizeKeywordMessage(message, false);
  const stored = scopeId === null ? await repo.listProbeRows(normalized) : await repo.listKeywordRows(scopeId);
  const rows = stored.map((row) => ({
    id: row.scopeId,
    keyword: row.keyword,
    reply: row.reply,
    anchor: row.anchor,
  }));
  const winner = normalized === "" ? null : matchKeyword(normalized, rows, { allReply, excludeUrl }, rng);
  if (winner === null) return null;
  const org = randomOrgUrl(winner, normalized);
  let randomOrg: ((request: { url: string }) => string) | undefined;
  if (org !== null) {
    const response = await clock.fetch(org);
    const text = await response.text();
    randomOrg = () => text;
  }
  return renderReply({
    reply: winner,
    message: normalized,
    userId: userId ?? "",
    now: new Date(`${clock.now.replace(" ", "T")}Z`),
    rng,
    randomOrg,
  });
}

async function readUserFlags(repo: BotRepository, groupId: string, userId: string) {
  await repo.touchSettings({ groupId, userId });
  const flags = await readReplyFlags(repo, { groupId, userId });
  return { 個人詞庫: flags.個人詞庫, 別理我: flags.別理我 };
}

async function readGroupFlags(repo: BotRepository, groupId: string) {
  await repo.touchSettings({ groupId, userId: "" });
  const flags = await readReplyFlags(repo, { groupId, userId: null });
  return { 全回應: flags.全回應, 全圖片: flags.全圖片 };
}

async function bumpTrigger(
  repo: BotRepository,
  source: { userId: string | null; groupId: string | null },
  now: string,
): Promise<void> {
  if (source.groupId === null) return;
  await repo.touchAndCount({ source, now, delta: { 觸發: 1 } });
}

async function currentName(repo: BotRepository, userId: string): Promise<string | null> {
  const rows = await repo.inspectTouch();
  return rows.users.find((user) => user.id === userId)?.name ?? null;
}

async function refreshName(
  repo: BotRepository,
  source: { userId: string | null; groupId: string | null },
  clock: { token: string; fetch: typeof fetch },
): Promise<void> {
  if (source.userId === null || source.groupId === null) return;
  const headers = { authorization: `Bearer ${clock.token}` };
  const groupUrl = `https://api.line.me/v2/bot/group/${source.groupId}/member/${source.userId}`;
  let name: string | null = null;
  const group = await clock.fetch(groupUrl, { headers });
  if (group.ok) {
    const body = (await group.json()) as { displayName?: unknown };
    if (typeof body.displayName === "string") name = body.displayName;
  } else {
    const roomUrl = `https://api.line.me/v2/bot/room/${source.groupId}/member/${source.userId}`;
    const room = await clock.fetch(roomUrl, { headers });
    if (room.ok) {
      const body = (await room.json()) as { displayName?: unknown };
      if (typeof body.displayName === "string") name = body.displayName;
    }
  }
  if (name !== null) await repo.setUserName(source.userId, name);
}

async function send(
  clock: { token: string; fetch: typeof fetch },
  to: string | null,
  replyToken: string | null,
  messages: readonly string[],
  format = true,
): Promise<void> {
  if (to === null) return;
  const ready = await imageReady(clock.fetch, messages);
  const client = createLineClient({
    token: clock.token,
    fetch: clock.fetch,
    isImageReady: (url) => ready.get(url) === true,
  });
  await deliver(client, { to, messages, replyToken, canPush: false, format });
}

async function imageReady(doFetch: typeof fetch, messages: readonly string[]): Promise<Map<string, boolean>> {
  const ready = new Map<string, boolean>();
  for (const message of messages) {
    if (!message.startsWith("https:") || message.includes("imgur.com")) continue;
    if (ready.has(message)) continue;
    try {
      const response = await doFetch(message, { method: "HEAD" });
      const type = response.headers.get("content-type");
      ready.set(message, type !== null && IMAGE_TYPES[type] === true);
    } catch {
      ready.set(message, false);
    }
  }
  return ready;
}

async function uploadImage(doFetch: typeof fetch, messageId: string, token: string): Promise<string> {
  const content = await doFetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const bytes = await content.arrayBuffer();
  const body = new FormData();
  body.set("image", new File([bytes], `line-${messageId}`));
  const uploaded = await doFetch("https://api.imgur.com/3/image", {
    method: "POST",
    headers: { authorization: "Client-ID " },
    body,
  });
  const json = (await uploaded.json()) as { data?: { link?: unknown } };
  if (typeof json.data?.link !== "string") throw new Error("imgur");
  return json.data.link;
}

async function safeBrowsing(doFetch: typeof fetch, message: string, mode: string): Promise<string[] | null> {
  const urls = message.match(/https?:\/\/(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*(),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+/g) ?? [];
  await doFetch("https://safebrowsing.googleapis.com/v4/threatMatches:find?key=", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client: { clientId: "mao line bot", clientVersion: "1.0" },
      threatInfo: {
        threatTypes: [
          "MALWARE",
          "SOCIAL_ENGINEERING",
          "UNWANTED_SOFTWARE",
          "POTENTIALLY_HARMFUL_APPLICATION",
          "THREAT_TYPE_UNSPECIFIED",
        ],
        platformTypes: ["ANY_PLATFORM"],
        threatEntryTypes: ["URL"],
        threatEntries: urls.map((url) => ({ url })),
      },
    }),
  });
  if (mode !== "threat") return null;
  return ["Google網址檢查：危險！\n", "網址:http://evil.invalid/\n類型:惡意軟件\n"];
}

function sourceIds(value: unknown): { userId: string | null; groupId: string | null } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { userId: null, groupId: null };
  }
  const record = value as Record<string, unknown>;
  const userId = typeof record.userId === "string" ? record.userId : null;
  if (record.type === "group") {
    return { userId, groupId: typeof record.groupId === "string" ? record.groupId : null };
  }
  if (record.type === "room") {
    return { userId, groupId: typeof record.roomId === "string" ? record.roomId : null };
  }
  if (record.type === "user") return { userId, groupId: null };
  return { userId: null, groupId: null };
}

function parseOrder(message: string): { order: string; key: string | null; value: string | null } {
  const parts = message.split("=");
  const keyRaw = parts.length > 1 ? stripEnds(parts[1] ?? "") : "";
  const valueRaw = parts.length > 2 ? stripEnds(parts.slice(2).join("=")) : "";
  return {
    order: (parts[0] ?? "").toLowerCase(),
    key: parts.length > 1 && keyRaw.length > 0 ? keyRaw : null,
    value: parts.length > 2 && valueRaw.length > 0 ? valueRaw : null,
  };
}

function stripEnds(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === " " || value[start] === "\n")) start += 1;
  while (end > start && (value[end - 1] === " " || value[end - 1] === "\n")) end -= 1;
  return value.slice(start, end);
}

function parseRng(raw: string | null): RngOp[] {
  if (raw === null || raw.length === 0) return [];
  const value = JSON.parse(raw) as RngOp[];
  return Array.isArray(value) ? value : [];
}

function headerNumber(request: Request, name: string): number | null {
  const raw = request.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type { KeywordRow };
