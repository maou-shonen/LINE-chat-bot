# Workers 後續小 PR

這批只交付簽章閘門、`BotState` 的 SQLite schema，以及 `BotRepository`。指令、關鍵字、抽卡都不在這批。

下一個工程師要守住的契約有四條。

`POST /callback/{secret}/{token}` 用 path 上的 channel secret 做 HMAC-SHA256。通過才 `idFromName("global")` 轉給 `BotState`。失敗回 400，而且不進 DO。`GET /healthz` 不進 DO。
`user_settings` 與 `group_user` 的缺席範圍是空字串，不是 NULL。主鍵是複合鍵。
`getSettings` 查不到回 `{ options: {}, stored: false }`，不寫列。`upsertSettings` 把 patch 併進既有 JSON。合併結果沒有鍵就不插入。有鍵才寫一列。
`user_keyword` 保留 `anchor`、`length(anchor)` 索引，以及 `(id, keyword)` unique。`id` 仍可為 NULL，因為現行 SQLite unique 允許多個 NULL。匯入時不要把那些列併成一列。

## 後續 PR

每一個 PR 都要能單獨合併，而且都不要部署。

1. LINE reply client。把 reply 與 push 收成介面，測試用假的 fetch。還沒有指令行為。
2. `user`、`group`、`group_user` 的觸碰與計數。計數寫入走 repository，不要在 handler 裡直接 SQL。
3. 設定指令。`設定`、暫停、起床都呼叫 `BotRepository`。暫停寫的是非空 options，所以會落列。讀取仍不建空列。
4. 關鍵字新增、疊加、刪除、列表，以及 `keywords_logs`。
5. anchor probe 與比對。這一步要量 CPU。目標是單則訊息的 probe 加比對低於 10 ms。沒量過不要把抽卡疊上去。
6. 抽卡 DSL。權重、多發、保底、種子、百分比。
7. fixture 對接。見下一節。`fixtures/SCHEMA.md` 不存在之前不要寫這支 PR。
8. 分批匯入。每日寫入列扣掉日常用量後，上限抓 ADR 的 80k 列。NULL 範圍改成空字串。`user_settings` 與 `group_user` 丟掉代理鍵 `_id`。`options = '{}'` 的列不要匯。

`keywords_logs` 要不要留，或加保留期限，放在第 4 支 PR 決定。理由是寫入列額度，不是這批能先猜的。

## Fixtures

另一個任務會在 repo 的 `fixtures/` 產出 JSON，格式寫在該任務的 `fixtures/SCHEMA.md`。這批不讀那些檔，也不假設檔名。

對接方式是後續 PR 讀一份 fixture，呼叫 repository 與 handler，再比對 fixture 裡的預期回覆。比較的是呼叫端看得到的回覆與資料列，不是 SQL 字串。Python 黃金案例仍留在 `tests/golden/`，Workers 測試不要複製那份 Python harness。

## 部署前才處理

不要跑 `wrangler deploy` 或 `wrangler login`。`wrangler.jsonc` 的 account id 是 32 個 0，不是真實帳號。
不要加 `linebot.maou.app` 的 route，也不要改 webhook、DNS、tunnel 或 NAS stack。
callback path 含 channel secret 與 access token。這批沒有開 logpush，也沒有 `console.log`。部署 PR 在把 secret 移出 URL 之前，不要開 request log。
