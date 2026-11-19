import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BotState } from "../src/bot-state";
import {
  applyKeywordCommand,
  type KeywordCommandInput,
  type KeywordCommandResult,
} from "../src/commands/keywords";
import { parseKeywordWrite } from "../src/repository";

const NOW = "2023-11-14 22:13:20";
const LATER = "2023-11-14 22:13:21";

const LEARN_HELP = [
  "「學習=<關鍵字>=<內容>」\n關鍵字可用雙米號<**>為萬用字元\n內容省略時可查詢內容\n內容中雙底線<__>隨機回話\n內容中雙直槓<||>分段(最多5)\n內容為圖片網址可傳圖(https)(jpg png)\n內容最尾有雙井號[##A=B]為參數A=B\n\n特別是隨機回話的子功能較多\n請查看詳細說明\n\n詳細說明 goo.gl/xMtima",
  "隨機回話的簡短說明\n「學習=<關鍵字>=<內容A__內容B>」\n內容每段最末尾可用[%]指定比重(默認1)\n例:AAA%10__BB%2__CCC\n出現AAA的機率7/13\n出現BBB的機率2/13\n出現CCC的機率1/13\n選項可用[##種子=N] N為數字(小時)\n例:##種子=24\n同一個人在24小時內隨機的內容會一樣\n※如果要多重觸發關鍵字後面要有【**】\n觸發方法是【關鍵字*數字】\n最大可以10000連發\n另一個參數是##百分比=數量\n在「全回應」模式下可以先玩看看\n愛醬 xx的能力\n愛醬 xx的血統\n愛醬 xx的未來",
];
const LEARN_HELP_PLUS =
  "「學習+=<關鍵字>=<內容>」\n功能同「學習」\n差異為如果關鍵字已經存在\n內容將會用隨機的方式增加上去\n<栗子>\nadd=關鍵字=A\nadd+=關鍵字=B\nadd+=關鍵字=C\n<效果等同>\nadd=關鍵字=A__B__C\n通常用於隨機模式太過長分段添加\n或是臨時想要增加選項使用\n\n詳細說明 goo.gl/xMtima";
const BAN_REPLY = "請不要使用這些關鍵字喔\n**、** **、愛醬**、**愛醬**";
const PROTECT_FAIL = "學習失敗: 此關鍵字已被保護\n只有原設定者可以修改";
const DELETE_FAIL = "刪除失敗: 此關鍵字已被保護\n只有原設定者可以修改";
const PERSONAL =
  "現在個人詞庫預設是不會在群組觸發的喔\n請在群組設定開啟全回應模式(預設開)或開啟個人詞庫(預設關)";

describe("keyword commands", () => {
  it("replies None on the first learn when the stored name is missing", async () => {
    const state = freshState();
    expect(await shown(state, "學習=hi问候=helloReply", { displayName: null })).toEqual([
      "None 新增 <hi问候>",
    ]);
    const rows = await state.inspectKeywords();
    expect(rows.keywords).toEqual([
      {
        scopeId: "C1",
        author: "U1",
        keyword: "hi问候",
        reply: "helloReply",
        anchor: "hi问候",
      },
    ]);
    expect(rows.logs).toEqual([
      { scopeId: "C1", keyword: "hi问候", reply: "helloReply", createOn: NOW },
    ]);
    expect((await state.inspectTouch()).counts).toEqual({});
  });

  it("queries, misses, and returns the two learn-help bubbles", async () => {
    const state = freshState();
    await shown(state, "學習=hi问候=helloReply");
    expect(await shown(state, "學習=hi问候")).toEqual(["hi问候 = helloReply"]);
    expect(await shown(state, "學習=沒有這個鍵")).toEqual(["喵喵喵? 愛醬不記得 <沒有這個鍵>"]);
    expect(await shown(state, "學習")).toEqual(LEARN_HELP);
    expect(await shown(state, "學習+")).toEqual([LEARN_HELP_PLUS]);
    expect(await shown(state, "學習=")).toEqual(LEARN_HELP);
    expect((await state.inspectKeywords()).logs).toHaveLength(1);
  });

  it("stores collapsed replies, lowercased keys, and the longest anchor", async () => {
    const state = freshState();
    await shown(state, "學習=QA=va\"l'ue;z");
    await shown(state, "學習=pipes=a|||b");
    await shown(state, "學習=under=a_____b");
    await shown(state, "學習=a***=kept");
    await shown(state, "學習=ab**cd=tie");
    await shown(state, "學習=aa**b=left");
    await shown(state, "學習=a**bb=right");
    await shown(state, "學習=ab**😀😀=emoji");

    expect(await shown(state, "學習=qa")).toEqual(["qa = va＂l’ue；z"]);
    expect(await shown(state, "學習=pipes")).toEqual(["pipes = a||b"]);
    expect(await shown(state, "學習=under")).toEqual(["under = a__b"]);
    expect(await shown(state, "學習=a***")).toEqual(["a** = kept"]);
    expect(await shown(state, "刪除=a***")).toEqual(["喵喵喵? 愛醬不記得<a***>"]);
    expect(await shown(state, "刪除=a**")).toEqual(["ProbeUser 刪除 <a**> 成功"]);

    const rows = await state.inspectKeywords();
    expect(rows.keywords.find((row) => row.keyword === "ab**cd")?.anchor).toBe("ab");
    expect(rows.keywords.find((row) => row.keyword === "aa**b")?.anchor).toBe("aa");
    expect(rows.keywords.find((row) => row.keyword === "a**bb")?.anchor).toBe("bb");
    expect(rows.keywords.find((row) => row.keyword === "ab**😀😀")?.anchor).toBe("ab");
  });

  it("strips the name prefix on write and delete, but not on query", async () => {
    const state = freshState();
    expect(await shown(state, "學習=愛醬QA=bar")).toEqual(["ProbeUser 新增 <qa>"]);
    expect(await shown(state, "學習=愛醬QA")).toEqual(["喵喵喵? 愛醬不記得 <愛醬qa>"]);
    expect(await shown(state, "學習=qa")).toEqual(["qa = bar"]);
    expect(await shown(state, "刪除=愛醬QA")).toEqual(["ProbeUser 刪除 <qa> 成功"]);
  });

  it("rejects banned keys, hash replies, and protected wildcards without writing", async () => {
    const state = freshState();
    expect(await shown(state, "學習=**=x")).toEqual([BAN_REPLY]);
    expect(await shown(state, "學習=***=x")).toEqual([BAN_REPLY]);
    expect(await shown(state, "學習=愛醬***=x")).toEqual([BAN_REPLY]);
    expect(await shown(state, "學習=hk=##abc")).toEqual(["由於規則問題 沒辦法使用##開頭的內容喔"]);
    expect(await shown(state, "學習=**nope**=x##保護")).toEqual([
      "為了避免過度觸發\n保護模式關鍵字不接受前後**喔",
    ]);
    expect(await state.inspectKeywords()).toEqual({ keywords: [], logs: [] });
  });

  it("warns on trigger level, single star, and single underscore", async () => {
    const state = freshState();
    expect(await shown(state, "學習=z**=fuzzyV")).toEqual([
      "ProbeUser 新增 <z**> \n這種容易觸發的詞容易造成過多訊息喔\n請注意使用",
    ]);
    expect(await shown(state, "學習=sharedx=sharedV")).toEqual([
      "ProbeUser 新增 <sharedx> \n這種詞命中率較低喔 請善加利用萬用字元雙米號",
    ]);
    expect(await shown(state, "學習=**a**b**=too")).toEqual([
      "ProbeUser 新增 <**a**b**> \n愛醬非常不建議這種會過度觸發的詞喔\n請慎用",
    ]);
    expect(await shown(state, "學習=a*b=star_")).toEqual([
      "ProbeUser 新增 <a*b> \n愛醬發現你似乎要使用萬用字元?\n如果是的話請把 *(單米號) 換成 **(雙米號)\n愛醬發現你似乎要使用隨機模式?\n如果是的話請把 _(單底線) 換成 __(雙底線)",
    ]);
    expect(await shown(state, "學習=ok=a_b__c")).toEqual(["ProbeUser 新增 <ok>"]);
    await shown(state, "學習=k=$&");
    expect(await shown(state, "學習=k")).toEqual(["k = $&"]);
    expect(await shown(state, "學習=😀**=x")).toEqual([
      "ProbeUser 新增 <😀**> \n這種容易觸發的詞容易造成過多訊息喔\n請注意使用",
    ]);
  });

  it("protects the tail after the last ##, including a substring match", async () => {
    const state = freshState();
    expect(await shown(state, "學習=pk1=secret##保護")).toEqual([
      "ProbeUser 新增 <pk1> \n(此為保護關鍵字 只有你可以刪除及修改 為了避免爭議 建議不要濫用)",
    ]);
    expect(await shown(state, "學習=pk1=hack", { userId: "U2" })).toEqual([PROTECT_FAIL]);
    expect(await shown(state, "學習+=pk1=extra", { userId: "U2" })).toEqual([PROTECT_FAIL]);
    expect(await shown(state, "刪除=pk1", { userId: "U2" })).toEqual([DELETE_FAIL]);
    expect((await state.inspectKeywords()).keywords[0]?.reply).toBe("secret##保護");

    expect(await shown(state, "學習=pk1=secret2##保護")).toEqual([
      "ProbeUser 新增 <pk1> \n(此為保護關鍵字 只有你可以刪除及修改 為了避免爭議 建議不要濫用)",
    ]);
    expect(await shown(state, "刪除=pk1")).toEqual(["ProbeUser 刪除 <pk1> 成功"]);
    expect((await state.inspectKeywords()).keywords.map((row) => row.keyword)).toEqual([]);
    expect((await state.inspectKeywords()).logs.map((row) => row.reply)).toEqual([
      "secret##保護",
      "secret2##保護",
    ]);

    await shown(state, "學習=soft=v##不保護");
    expect(await shown(state, "學習=soft=hack", { userId: "U2" })).toEqual([PROTECT_FAIL]);
  });

  it("prepends a plus fragment and logs that fragment, not the stack", async () => {
    const state = freshState();
    expect(await shown(state, "學習+=wt2=base")).toEqual(["ProbeUser 新增 <wt2>"]);
    expect(await shown(state, "學習+=wt2=extra", { now: LATER })).toEqual(["ProbeUser 新增 <wt2>"]);
    const rows = await state.inspectKeywords();
    expect(rows.keywords).toEqual([
      { scopeId: "C1", author: "U1", keyword: "wt2", reply: "extra__base", anchor: "wt2" },
    ]);
    expect(rows.logs).toEqual([
      { scopeId: "C1", keyword: "wt2", reply: "base", createOn: NOW },
      { scopeId: "C1", keyword: "wt2", reply: "extra", createOn: LATER },
    ]);
  });

  it("deletes the group row and the personal row, and misses with no space", async () => {
    const state = freshState();
    await shown(state, "學習=k=group");
    await shown(state, "學習=k=mine", { groupId: null, userId: "U1" });
    expect(await shown(state, "刪除=k")).toEqual(["ProbeUser 刪除 <k> 成功 成功"]);
    expect(await state.inspectKeywords()).toEqual({
      keywords: [],
      logs: [
        { scopeId: "C1", keyword: "k", reply: "group", createOn: NOW },
        { scopeId: "U1", keyword: "k", reply: "mine", createOn: NOW },
      ],
    });
    expect(await shown(state, "刪除=不存在的key")).toEqual(["喵喵喵? 愛醬不記得<不存在的key>"]);
    expect(await shown(state, "刪除")).toEqual(["格式:\n刪除=<關鍵字>"]);
  });

  it("stops a group protect failure before deleting the personal row", async () => {
    const state = freshState();
    await shown(state, "學習=k=secret##保護");
    await shown(state, "學習=k=mine", { groupId: null });
    expect(await shown(state, "刪除=k", { userId: "U2" })).toEqual([DELETE_FAIL]);
    expect((await state.inspectKeywords()).keywords.map((row) => row.scopeId).sort()).toEqual([
      "C1",
      "U1",
    ]);
  });

  it("lists the group in insertion order, and lists self only for own-words", async () => {
    const state = freshState();
    for (const text of ["學習=pre**=WV", "學習=**suf=WS", "學習=**both**=WB", "學習=a**b=AB"]) {
      await shown(state, text);
    }
    await shown(state, "學習=mine=pv", { groupId: null });
    expect(await shown(state, "列表")).toEqual(["「列表=我」查詢自己\npre**\n**suf\n**both**\na**b"]);
    expect(await shown(state, "列表=我")).toEqual([
      "現在群組中預設不使用個人詞庫\n有需要請用「設定」開啟\nmine",
    ]);
    expect(await shown(state, "列表=ME")).toEqual(["「列表=我」查詢自己\npre**\n**suf\n**both**\na**b"]);
    expect(await shown(state, "列表", { groupId: null, displayName: null })).toEqual([
      `現在群組中預設不使用個人詞庫\n有需要請用「設定」開啟\nmine`,
    ]);
    expect(await shown(state, "列表=我", { userId: null })).toEqual([
      "權限不足\nhttps://goo.gl/zTwaL2",
    ]);
  });

  it("accepts every add, plus, list, and delete alias", async () => {
    const state = freshState();
    const adds = ["-a=ka=va", "add=kb=vb", "keyword=kc=vc", "新增=kd=vd", "關鍵字=ke=ve", "ADD=kf=vf"];
    const pluses = ["-a+=kpa=vpa", "add+=kpb=vpb", "keyword+=kpc=vpc", "新增+=kpd=vpd", "關鍵字+=kpe=vpe"];
    for (const text of [...adds, ...pluses]) {
      const key = text.split("=")[1];
      expect(await shown(state, text)).toEqual([`ProbeUser 新增 <${key}>`]);
    }
    expect(await shown(state, "-l")).toEqual([
      "「列表=我」查詢自己\nka\nkb\nkc\nkd\nke\nkf\nkpa\nkpb\nkpc\nkpd\nkpe",
    ]);
    expect(await shown(state, "LIST")).toEqual([
      "「列表=我」查詢自己\nka\nkb\nkc\nkd\nke\nkf\nkpa\nkpb\nkpc\nkpd\nkpe",
    ]);
    expect(await shown(state, "-d=ka")).toEqual(["ProbeUser 刪除 <ka> 成功"]);
    expect(await shown(state, "delete=kb")).toEqual(["ProbeUser 刪除 <kb> 成功"]);
    expect(await shown(state, "del=kc")).toEqual(["ProbeUser 刪除 <kc> 成功"]);
    expect(await shown(state, "移除=kd")).toEqual(["ProbeUser 刪除 <kd> 成功"]);
  });

  it("adds a personal library notice in direct messages and does not add the protect notice", async () => {
    const state = freshState();
    expect(
      await shown(state, "學習=dmk=dmv##保護", { groupId: null, userId: "U_dm", displayName: null }),
    ).toEqual([`None 新增 <dmk> \n${PERSONAL}`]);
    const rows = await state.inspectKeywords();
    expect(rows.keywords[0]).toMatchObject({ scopeId: "U_dm", author: "U_dm", keyword: "dmk" });
    expect(rows.logs[0]).toMatchObject({ scopeId: "U_dm", reply: "dmv##保護" });
  });

  it("passes unrelated text and does not claim a spaced order", async () => {
    const state = freshState();
    expect(await command(state, "說明")).toEqual({ kind: "pass" });
    expect(await command(state, " 學習=a=b")).toEqual({ kind: "pass" });
    expect(await command(state, "hello")).toEqual({ kind: "pass" });
    expect(await state.inspectKeywords()).toEqual({ keywords: [], logs: [] });
  });

  it("rejects a keyword write that is not the repository shape", () => {
    expect(() =>
      parseKeywordWrite({ scopeId: "C1", author: "U1", reply: "r", plus: false, now: NOW }),
    ).toThrow(/keyword/);
  });
});

function freshState(): DurableObjectStub<BotState> {
  const id = env.BOT_STATE.idFromName(`keywords-${crypto.randomUUID()}`);
  return env.BOT_STATE.get(id);
}

function command(
  state: DurableObjectStub<BotState>,
  text: string,
  extra: Partial<KeywordCommandInput> = {},
): Promise<KeywordCommandResult> {
  const input: KeywordCommandInput = {
    text,
    groupId: "C1",
    userId: "U1",
    displayName: "ProbeUser",
    now: NOW,
    ...extra,
  };
  return applyKeywordCommand(state, input);
}

async function shown(
  state: DurableObjectStub<BotState>,
  text: string,
  extra: Partial<KeywordCommandInput> = {},
): Promise<string[]> {
  const result = await command(state, text, extra);
  if (result.kind !== "reply") throw new Error(`expected a reply for ${text}`);
  return result.messages.map(lineText).filter((message) => message !== "");
}

function lineText(message: string): string {
  const strip = "|_ \n";
  let start = 0;
  let end = message.length;
  while (start < end && strip.includes(message[start] ?? "")) start += 1;
  while (end > start && strip.includes(message[end - 1] ?? "")) end -= 1;
  return message.slice(start, end);
}
