# 把 Python SQLite 分批匯入 Durable Object

這份步驟把本機的一份 SQLite 複本轉成 Workers 的資料列，再分批 POST 到 staging。實際匯入需使用者同意，由 Cloudflare bot 執行。不要對正式帳號、正式 webhook 或 NAS 上的資料庫執行。

寫入額度用的是 Durable Object SQLite，算法與 [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) 相同。每一列插入算 1，每個會被更新的索引再加 1。`user_keyword` 的 `INTEGER PRIMARY KEY` 就是那一列本身，不加。每送出一批再加 2，那是 `import_batches` 那一列和它的主鍵索引。Free 方案每天 100,000 列寫入。扣掉 ADR 裡約 7,800 列的日常用量，預設上限是 80,000。`estimated_days` 是 `ceil(total_write_units / daily_write_limit)`。這個數字依索引個數估算。測試沒有讀到 Cloudflare 的 rows_written 計數器。第一批建立 `import_batches` 的 DDL 也沒有算進去。80,000 和 100,000 之間的空隙蓋得住那幾列。

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

先由 Cloudflare bot 在 staging 設定 secret。值不要寫進 git。`wrangler.jsonc` 裡的 `IMPORT_SECRET` 是空字串，空字串會讓 `POST /import` 回 404。

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
