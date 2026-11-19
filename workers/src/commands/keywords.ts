import {
  isProtectedReply,
  type KeywordDelete,
  type KeywordDeleteStatus,
  type KeywordLookup,
  type KeywordWrite,
  type KeywordWriteStatus,
} from "../repository";

export interface KeywordStore {
  upsertKeyword(input: KeywordWrite): Promise<KeywordWriteStatus>;
  deleteKeyword(input: KeywordDelete): Promise<KeywordDeleteStatus>;
  getKeyword(input: KeywordLookup): Promise<string | null>;
  listKeywords(scopeId: string | null): Promise<string[]>;
}

export interface KeywordCommandInput {
  text: string;
  groupId: string | null;
  userId: string | null;
  displayName: string | null;
  now: string;
}

export type KeywordCommandResult =
  | { kind: "pass" }
  | { kind: "reply"; messages: readonly string[] };

const NAME = "愛醬";
const OWN_WORDS: Record<string, true> = {
  me: true,
  my: true,
  myself: true,
  自己: true,
  個人: true,
  我: true,
};
const ORDER: Record<string, "add" | "plus" | "delete" | "list"> = {
  "-a": "add",
  add: "add",
  keyword: "add",
  新增: "add",
  關鍵字: "add",
  學習: "add",
  "-a+": "plus",
  "add+": "plus",
  "keyword+": "plus",
  "新增+": "plus",
  "關鍵字+": "plus",
  "學習+": "plus",
  "-d": "delete",
  delete: "delete",
  del: "delete",
  刪除: "delete",
  移除: "delete",
  "-l": "list",
  list: "list",
  列表: "list",
};
const BAN_KEYS = ["**", "** **", "愛醬**", "**愛醬**"];

const LEARN_HELP = [
  "「學習=<關鍵字>=<內容>」\n關鍵字可用雙米號<**>為萬用字元\n內容省略時可查詢內容\n內容中雙底線<__>隨機回話\n內容中雙直槓<||>分段(最多5)\n內容為圖片網址可傳圖(https)(jpg png)\n內容最尾有雙井號[##A=B]為參數A=B\n\n特別是隨機回話的子功能較多\n請查看詳細說明\n\n詳細說明 goo.gl/xMtima\n",
  "隨機回話的簡短說明\n「學習=<關鍵字>=<內容A__內容B>」\n內容每段最末尾可用[%]指定比重(默認1)\n例:AAA%10__BB%2__CCC\n出現AAA的機率7/13\n出現BBB的機率2/13\n出現CCC的機率1/13\n選項可用[##種子=N] N為數字(小時)\n例:##種子=24\n同一個人在24小時內隨機的內容會一樣\n※如果要多重觸發關鍵字後面要有【**】\n觸發方法是【關鍵字*數字】\n最大可以10000連發\n另一個參數是##百分比=數量\n在「全回應」模式下可以先玩看看\n愛醬 xx的能力\n愛醬 xx的血統\n愛醬 xx的未來\n",
] as const;

const LEARN_HELP_PLUS =
  "「學習+=<關鍵字>=<內容>」\n功能同「學習」\n差異為如果關鍵字已經存在\n內容將會用隨機的方式增加上去\n<栗子>\nadd=關鍵字=A\nadd+=關鍵字=B\nadd+=關鍵字=C\n<效果等同>\nadd=關鍵字=A__B__C\n通常用於隨機模式太過長分段添加\n或是臨時想要增加選項使用\n\n詳細說明 goo.gl/xMtima\n";

const NO_PERMISSION = "權限不足\nhttps://goo.gl/zTwaL2\n";
const QUERY_HIT = "<key> = <value>";
const QUERY_MISS = "喵喵喵? 愛醬不記得 <<key>>";
const BAN_REPLY = `請不要使用這些關鍵字喔\n${BAN_KEYS.join("、")}`;
const HASH_REJECT = "由於規則問題 沒辦法使用##開頭的內容喔";
const WILD_PROTECT = "為了避免過度觸發\n保護模式關鍵字不接受前後**喔";
const DELETE_HELP = "格式:\n刪除=<關鍵字>";
const PROTECT_MESSAGE = "此關鍵字已被保護\n只有原設定者可以修改";
const LEVEL_NEGATIVE = "\n愛醬非常不建議這種會過度觸發的詞喔\n請慎用";
const LEVEL_ZERO = "\n這種容易觸發的詞容易造成過多訊息喔\n請注意使用";
const LEVEL_HIGH = "\n這種詞命中率較低喔 請善加利用萬用字元雙米號";
const STAR_HINT = "\n愛醬發現你似乎要使用萬用字元?\n如果是的話請把 *(單米號) 換成 **(雙米號)";
const UNDER_HINT = "\n愛醬發現你似乎要使用隨機模式?\n如果是的話請把 _(單底線) 換成 __(雙底線)";
const PERSONAL_NOTICE =
  "\n現在個人詞庫預設是不會在群組觸發的喔\n請在群組設定開啟全回應模式(預設開)或開啟個人詞庫(預設關)";
const PROTECT_NOTICE = "\n(此為保護關鍵字 只有你可以刪除及修改 為了避免爭議 建議不要濫用)";
const LIST_SELF = "現在群組中預設不使用個人詞庫\n有需要請用「設定」開啟";
const LIST_GROUP = "「列表=我」查詢自己";

type ParsedOrder = { order: string; key: string | null; value: string | null };

type Classified =
  | { kind: "add"; plus: boolean; key: string | null; value: string | null }
  | { kind: "delete"; key: string | null }
  | { kind: "list"; key: string | null }
  | { kind: "pass" };

export async function applyKeywordCommand(
  store: KeywordStore,
  input: KeywordCommandInput,
): Promise<KeywordCommandResult> {
  const parsed = classify(input.text);
  switch (parsed.kind) {
    case "pass":
      return { kind: "pass" };
    case "add":
      return addKeyword(store, input, parsed.plus, parsed.key, parsed.value);
    case "delete":
      return deleteKeyword(store, input, parsed.key);
    case "list":
      return listKeyword(store, input, parsed.key);
    default: {
      const unreachable: never = parsed;
      return unreachable;
    }
  }
}

async function addKeyword(
  store: KeywordStore,
  input: KeywordCommandInput,
  plus: boolean,
  key: string | null,
  value: string | null,
): Promise<KeywordCommandResult> {
  if (key === null) {
    return { kind: "reply", messages: plus ? [LEARN_HELP_PLUS] : LEARN_HELP };
  }
  let keyword = collapseStars(key.toLowerCase());
  if (value === null) {
    const reply = await store.getKeyword({ scopeId: input.groupId ?? input.userId, keyword });
    return {
      kind: "reply",
      messages: [reply === null ? fill(QUERY_MISS, keyword) : fill(QUERY_HIT, keyword, reply)],
    };
  }
  const collapsed = value.replace(/\|{3,}/g, "||").replace(/_{3,}/g, "__");
  if (BAN_KEYS.includes(keyword)) return { kind: "reply", messages: [BAN_REPLY] };
  if (collapsed.startsWith("##")) return { kind: "reply", messages: [HASH_REJECT] };
  if (keyword !== NAME && keyword.startsWith(NAME)) {
    keyword = stripEnds(keyword.slice(NAME.length));
  }
  if (isProtectedReply(collapsed) && keyword.startsWith("**") && keyword.endsWith("**")) {
    return { kind: "reply", messages: [WILD_PROTECT] };
  }
  try {
    const status = await store.upsertKeyword({
      scopeId: input.groupId ?? input.userId,
      author: input.userId,
      keyword,
      reply: collapsed,
      plus,
      now: input.now,
    });
    if (status === "protected") {
      return { kind: "reply", messages: [`學習失敗: ${PROTECT_MESSAGE}`] };
    }
  } catch (error) {
    return { kind: "reply", messages: [`學習失敗: ${errorText(error)}`] };
  }
  return { kind: "reply", messages: [learnNotice(input, keyword, collapsed)] };
}

async function deleteKeyword(
  store: KeywordStore,
  input: KeywordCommandInput,
  key: string | null,
): Promise<KeywordCommandResult> {
  if (key === null) return { kind: "reply", messages: [DELETE_HELP] };
  let keyword = key;
  if (keyword !== NAME && keyword.startsWith(NAME)) {
    keyword = stripEnds(keyword.slice(NAME.length));
  }
  keyword = keyword.toLowerCase();
  const parts = [`${speaker(input)} 刪除 <${keyword}>`];
  try {
    if (input.groupId !== null) {
      const status = await store.deleteKeyword({
        scopeId: input.groupId,
        author: input.userId,
        keyword,
      });
      if (status === "protected") return { kind: "reply", messages: [`刪除失敗: ${PROTECT_MESSAGE}`] };
      if (status === "deleted") parts.push(" 成功");
    }
    if (input.userId !== null) {
      const status = await store.deleteKeyword({
        scopeId: input.userId,
        author: input.userId,
        keyword,
      });
      if (status === "protected") return { kind: "reply", messages: [`刪除失敗: ${PROTECT_MESSAGE}`] };
      if (status === "deleted") parts.push(" 成功");
    }
  } catch (error) {
    return { kind: "reply", messages: [`刪除失敗: ${errorText(error)}`] };
  }
  if (parts.length === 1) return { kind: "reply", messages: [`喵喵喵? 愛醬不記得<${keyword}>`] };
  return { kind: "reply", messages: [parts.join("")] };
}

async function listKeyword(
  store: KeywordStore,
  input: KeywordCommandInput,
  key: string | null,
): Promise<KeywordCommandResult> {
  if (input.groupId === null || (key !== null && OWN_WORDS[key] === true)) {
    if (input.userId === null) return { kind: "reply", messages: [NO_PERMISSION] };
    const words = await store.listKeywords(input.userId);
    return { kind: "reply", messages: [`${LIST_SELF}\n${words.join("\n")}`] };
  }
  const words = await store.listKeywords(input.groupId);
  return { kind: "reply", messages: [`${LIST_GROUP}\n${words.join("\n")}`] };
}

function learnNotice(input: KeywordCommandInput, keyword: string, value: string): string {
  const parts = [`${speaker(input)} 新增 <${keyword}> `];
  const level = learnLevel(keyword);
  if (level < 0) parts.push(LEVEL_NEGATIVE);
  else if (level === 0) parts.push(LEVEL_ZERO);
  else if (level >= 7) parts.push(LEVEL_HIGH);
  if (keyword.includes("*") && !keyword.includes("**")) parts.push(STAR_HINT);
  if (value.includes("_") && countToken(value, "__") === 0) parts.push(UNDER_HINT);
  if (input.groupId === null) parts.push(PERSONAL_NOTICE);
  else if (isProtectedReply(value)) parts.push(PROTECT_NOTICE);
  return parts.join("");
}

function classify(text: string): Classified {
  const parsed = parseOrder(normalize(text));
  const effect = ORDER[parsed.order];
  if (effect === "add" || effect === "plus") {
    return { kind: "add", plus: effect === "plus", key: parsed.key, value: parsed.value };
  }
  if (effect === "delete") return { kind: "delete", key: parsed.key };
  if (effect === "list") return { kind: "list", key: parsed.key };
  return { kind: "pass" };
}

function speaker(input: KeywordCommandInput): string {
  if (input.userId === null) return "";
  return input.displayName ?? "None";
}

function fill(template: string, key: string, value = ""): string {
  return template.replace("<key>", key).replace("<value>", value);
}

function collapseStars(keyword: string): string {
  let next = keyword;
  while (next.includes("***")) next = next.replaceAll("***", "**");
  return next;
}

// shortcut: JS length is UTF-16 units, upgrade when a keyword contains a non-BMP character
function learnLevel(keyword: string): number {
  return keyword.length - countToken(keyword, "**") * 3;
}

function countToken(value: string, token: string): number {
  return value.split(token).length - 1;
}

function normalize(text: string): string {
  return text.replaceAll('"', "\uFF02").replaceAll("'", "\u2019").replaceAll(";", "\uFF1B");
}

function parseOrder(message: string): ParsedOrder {
  const parts = message.split("=");
  const head = parts[0] ?? "";
  const keyRaw = parts.length > 1 ? stripEnds(parts[1] ?? "") : "";
  const valueRaw = parts.length > 2 ? stripEnds(parts.slice(2).join("=")) : "";
  return {
    order: head.toLowerCase(),
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

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

