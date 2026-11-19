import type { CountMap } from "./counts";
import type { GroupUserRow } from "./repository";

const SCORE_DEFAULT: Record<string, number> = {
  調教: 30,
  觸發: 10,
  對話: 1,
  貼圖: 1,
  圖片: 1,
  網頁: 0.5,
  髒話: -10,
  字數: 0.1,
};

const OWN = ["me", "my", "myself", "自己", "個人", "我"];
const ALL = ["all", "full", "全部", "全", "所有", "完整"];
const SETS = ["set", "setting", "settings", "設定", "設置"];
const HELP =
  "「回憶=我」　　查詢自己\n「回憶=全部」　查詢全部\n「回憶=<名字>」查詢別人\n「回憶=設定」　查詢設定\n「回憶=清除=全部」　清除群組全對話次數紀錄 (無法復原)\n「回憶=清除=<名字>」　清除群組某人的對話次數紀錄 (無法復原)";

export interface RecallStore {
  readGroupWeights(groupId: string): Promise<CountMap>;
  writeGroupWeight(groupId: string, key: string, value: number): Promise<void>;
  listGroupUsers(groupId: string): Promise<GroupUserRow[]>;
  deleteGroupUsers(groupId: string, userId: string | null): Promise<void>;
}

export async function applyRecall(
  store: RecallStore,
  input: { groupId: string; userId: string | null; key: string | null; value: string | null },
): Promise<string> {
  const rows = await store.listGroupUsers(input.groupId);
  const weights = await store.readGroupWeights(input.groupId);
  if (input.key !== null && like(input.key, OWN)) {
    if (input.userId === null) return "權限不足\nhttps://goo.gl/zTwaL2\n";
    const row = rows.find((item) => item.uid === input.userId);
    return formatUser(row?.name ?? null, row?.counts ?? {}, weights);
  }
  if (input.key === "rank" || input.key === "排名" || input.key === "排行") {
    return rank(rows, weights);
  }
  if (input.key !== null && like(input.key, SETS)) {
    const lines = Object.keys(SCORE_DEFAULT).map(
      (key) => `${key} = ${weights[key] ?? SCORE_DEFAULT[key]}`,
    );
    return `目前分數設定為:\n${lines.join("\n")}\n\n調整方法為\n「回憶=類型=值」\n栗子\n回憶=對話=5`;
  }
  if (input.key !== null && input.key in SCORE_DEFAULT) {
    if (!isFloat(input.value)) return `<${input.value}>不是數字喔`;
    await store.writeGroupWeight(input.groupId, input.key, Number(input.value));
    return "設定完成";
  }
  if (input.key !== null && like(input.key, ALL)) {
    return formatAll(rows);
  }
  if (input.key === "clean" || input.key === "clear" || input.key === "清除") {
    if (input.value !== null && like(input.value, ALL)) {
      await store.deleteGroupUsers(input.groupId, null);
      return "好好好！愛醬就當作大家什麼都沒說過吧！";
    }
    const found = named(rows, input.value ?? "");
    if (found.length === 0) {
      return `找不到 <${input.value}>\n可能是\n1.名稱輸入錯誤\n2.該人沒有說過話\n3.權限不足`;
    }
    if (found.length > 1) return `查詢到 ${found.length} 人\n請輸入更完整的名稱`;
    const user = found[0];
    if (user === undefined) return HELP;
    await store.deleteGroupUsers(input.groupId, user.uid);
    return `${user.name}...是誰?`;
  }
  if (input.key) {
    const key = input.key.replace(/^[@ \n]+|[@ \n]+$/g, "");
    const found = named(rows, key);
    if (found.length === 0) {
      return `找不到 <${key}>\n可能是\n1.名稱輸入錯誤\n2.該人沒有說過話\n3.權限不足`;
    }
    if (found.length > 1) return `查詢到 ${found.length} 人\n請輸入更完整的名稱`;
    const user = found[0];
    if (user === undefined) return HELP;
    return formatUser(user.name, user.counts, weights);
  }
  return HELP;
}

function formatUser(name: string | null, counts: CountMap, weights: CountMap): string {
  let score = 0;
  for (const [key, weight] of Object.entries(SCORE_DEFAULT)) {
    score += (counts[key] ?? 0) * (weights[key] ?? weight);
  }
  const shown = score > 0 ? score : 0;
  return [
    `愛醬記得 ${name ? name : "你"}`,
    `調教愛醬 ${Math.trunc(counts["調教"] ?? 0)} 次`,
    `跟愛醬說話 ${Math.trunc(counts["觸發"] ?? 0)} 次`,
    `有 ${Math.trunc(counts["對話"] ?? 0)} 次對話`,
    `有 ${Math.trunc(counts["貼圖"] ?? 0)} 次貼圖`,
    `有 ${Math.trunc(counts["圖片"] ?? 0)} 次圖片`,
    `有 ${Math.trunc(counts["網頁"] ?? 0)} 次傳送門`,
    `講過 ${Math.trunc(counts["髒話"] ?? 0)} 次「幹」`,
    `總計 ${Math.trunc(counts["字數"] ?? 0)} 個字`,
    "----------",
    `總分 ${Math.trunc(shown)}`,
  ].join("\n");
}

function formatAll(rows: GroupUserRow[]): string {
  const total: Record<string, number> = { 人數: 0 };
  for (const key of Object.keys(SCORE_DEFAULT)) total[key] = 0;
  for (const row of rows) {
    total["人數"] = (total["人數"] ?? 0) + 1;
    for (const key of Object.keys(SCORE_DEFAULT)) {
      total[key] = (total[key] ?? 0) + (row.counts[key] ?? 0);
    }
  }
  return [
    "愛醬記得這個群組...",
    `有 ${Math.trunc(total["人數"] ?? 0)} 個人說過話`,
    `愛醬被調教 ${Math.trunc(total["調教"] ?? 0)} 次`,
    `跟愛醬說話 ${Math.trunc(total["觸發"] ?? 0)} 次`,
    `有 ${Math.trunc(total["對話"] ?? 0)} 次對話`,
    `有 ${Math.trunc(total["貼圖"] ?? 0)} 次貼圖`,
    `有 ${Math.trunc(total["圖片"] ?? 0)} 次圖片`,
    `有 ${Math.trunc(total["網頁"] ?? 0)} 次傳送門`,
    `講過 ${Math.trunc(total["髒話"] ?? 0)} 次「幹」`,
    `總計 ${Math.trunc(total["字數"] ?? 0)} 個字`,
  ].join("\n");
}

function rank(rows: GroupUserRow[], weights: CountMap): string {
  const ranked: Array<{ name: string | null; score: number }> = [];
  for (const row of rows) {
    if (row.uid === "") continue;
    let score = 0;
    for (const [key, weight] of Object.entries(SCORE_DEFAULT)) {
      score += (row.counts[key] ?? 0) * (weights[key] ?? weight);
    }
    let placed = false;
    for (let i = 0; i < Math.min(ranked.length, 10); i += 1) {
      const current = ranked[i];
      if (current !== undefined && score > current.score) {
        ranked.splice(i, 0, { name: row.name, score });
        placed = true;
        break;
      }
    }
    if (!placed && ranked.length < 3) ranked.push({ name: row.name, score });
  }
  if (ranked.length < 3) return "群組說話的不足3人\n(沒有權限等同不存在)";
  return ranked
    .slice(0, 10)
    .map((user, index) => `第${index + 1}名 ${Math.trunc(user.score)} 分！\n${user.name} `)
    .join("\n\n");
}

function named(rows: GroupUserRow[], value: string): GroupUserRow[] {
  const exact = rows.find((row) => row.name !== null && row.name === value);
  if (exact !== undefined) return [exact];
  return rows.filter((row) => row.name !== null && value !== "" && row.name.includes(value));
}

function like(value: string, group: readonly string[]): boolean {
  return group.includes(value);
}

function isFloat(value: string | null): boolean {
  if (value === null) return false;
  return /^(?:(?:\d+_)*\d+(?:\.(?:\d+_)*\d*)?|\.(?:\d+_)*\d+)(?:[eE][+-]?(?:\d+_)*\d+)?$/.test(value);
}
