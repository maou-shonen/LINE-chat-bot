# 把 Python SQLite 分批匯入 Durable Object

這份步驟把本機的一份 SQLite 複本轉成 Workers 的資料列，再分批 POST 到 staging。實際匯入需使用者同意，由 Cloudflare bot 執行。不要對正式帳號、正式 webhook 或 NAS 上的資料庫執行。

寫入額度用的是 Durable Object SQLite，算法與 [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) 相同。索引會再算一列寫入（[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) 的 SQLite rows written 沿用同一套）。每一列插入算 1，每個會被更新的索引再加 1。`schema.ts` 的計數是 `user`、`group`、`group_user`、`keywords_logs`、`user_settings` 各 1（主鍵索引），`user_keyword` 3（`anchor`、`length(anchor)`、`(id, keyword)`）。`user_keyword` 的 `INTEGER PRIMARY KEY` 就是那一列本身，不加。每送出一批再加 2，那是 `import_batches` 那一列和它的主鍵索引。Free 方案每天 100,000 列寫入。扣掉 ADR 裡約 7,800 列的日常用量，預設上限是 80,000 write units。`estimated_days` 是 `ceil(total_write_units / daily_write_limit)`。

以來源列全數匯入計算：user 43,848 × 2、group 4,407 × 2、group_user 57,543 × 2、keywords_logs 65,415 × 2、user_keyword 50,929 × 4、user_settings 55,486 × 2，再加每批 200 列的 1,392 批 × 2，合計 659,898 write units，9 天。`user_settings` 的空 options 不匯，實際更少。測試沒有讀到 Cloudflare 的 rows_written 計數器。第一批建立 `import_batches` 的 DDL 也沒有算進去。80,000 和 100,000 之間的空隙蓋得住那幾列。

轉換規則如下。

- `group_user.gid`、`group_user.uid`、`user_settings.group_id`、`user_settings.user_id` 的 NULL 改成空字串。
- `user_settings` 和 `group_user` 不匯入代理鍵 `_id`。
- `options` 是 NULL、空白或 `{}` 的 `user_settings` 列不匯。
- `user_keyword.id` 可以是 NULL。那些列各自保留，不併成一列。`anchor` 的 NULL 改成空字串。
- `group` 的 `_count`、`_setting`、`_admin`，以及 `group_user` 的 `_count`、`_setting`，NULL 改成 `{}`。DO 這些欄位是 NOT NULL，直接插入 NULL 會失敗。

## 先看會匯多少

把正式庫複製到這台機器。路徑不要指到 NAS。在 `workers/` 執行：

```bash
npm run import -- --sqlite /path/to/copy.db --dry-run
```

輸出只有每表的來源列數、實際匯入列數、略過列數和 `write_units`。沒有關鍵字內容，也不會寫 checkpoint，也不會送 HTTP。

Node 需要 22.13 或更新，因為腳本用 `node:sqlite` 的唯讀開啟。

## 使用者同意之後

先由 Cloudflare bot 在 staging 設定 secret。值不要寫進 git，也不要寫進 `wrangler.jsonc`。同名的 var 會和 `wrangler secret` 衝突。沒有設定 `IMPORT_SECRET` 時，`POST /import` 回 404。

```bash
npx wrangler secret put IMPORT_SECRET --env staging
```

然後在 `workers/` 執行。secret 從環境變數讀，終端機不會印出來。

```bash
IMPORT_SECRET='(staging secret)' npm run import -- \
  --sqlite /path/to/copy.db \
  --checkpoint /path/to/import-checkpoint.json \
  --endpoint https://<staging-host>/import
```

`--endpoint` 的路徑必須是 `/import`。除了 `localhost`、`127.0.0.1` 和 `[::1]`，只接受 https。不要把 secret 放在 URL 裡。

預設每批 200 列，每天 80,000 個 write units。`--batch-size` 最大 1000。同一份 checkpoint 不能改 batch size。改了會拒絕續跑，避免同一段資料用新的 batch id 再寫一次。

每一批的 id 是 `資料表:起始列:結束列`。DO 在同一個 `transactionSync` 裡寫入整批。相同 id 再送一次不會多插列。客戶端沒收到回應就重跑時，會把該批原本的 write units 算進今天的用量。

中斷或到達當日上限時，checkpoint 停在最後一批成功的位置。連線失敗、4xx 或 5xx 都不會前進。隔天 00:00 UTC 之後用同一個指令再跑。SQLite 檔的列數若和 checkpoint 不一致，工具會停下來，不續跑。

checkpoint 只記路徑、列數和位移。它不記 secret，也不記訊息內容。

## 正式匯入（2026-11-21 起）

正式匯入的對象是 `line-chat-bot`，不是 staging。DO 綁定在各自的 script 上，所以要匯進最後接 webhook 的那個 Worker。

- 機器：shonen-lab。所有檔案放在 `~/linebot-import/`（權限 700）。
- 快照：`line-snapshot-20261121.db`，唯讀。checkpoint 會比對列數，所以整個匯入期間都用這一份。
- 程式：固定在 worktree `~/projects/LINE-chat-bot/.worktree/import`（ff79de6），不跟著分支移動。
- 每日指令：`~/linebot-import/run-import.sh`。用 flock 避免重複執行，log 寫在 `~/linebot-import/logs/import-YYYYMMDD.log`（只有列數）。
- 排程：每天 00:10 UTC（台北 08:10）以後跑一次。跑到當日上限會自己停，隔天用同一個指令續跑，重跑也安全。
- 上限：匯入 `user_keyword` 那幾天是 64,000，之後 80,000。關鍵字列會額外寫 probe cache，第 1 天實測 80,000 units 對應 100,532 rows，超過免費額度。
- 匯入順序：`user_keyword`、`user_settings`、`group`、`group_user`、`user`、`keywords_logs`。

快照之後的差異回填和切換步驟，見 [cutover.md](cutover.md)。
