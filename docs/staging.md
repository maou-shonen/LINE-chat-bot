# 部署 staging

這份是草稿。Cloudflare bot 執行部署。用哪個帳號由你決定。這份文件不執行部署。

不要跑 `wrangler login`。不要跑不帶 `--dry-run` 的 `wrangler deploy`。不要改 webhook、DNS、tunnel 或 NAS stack。不要對正式 LINE channel 發訊息。

## 設定

工作目錄是 `workers/`。設定檔是 `workers/wrangler.jsonc` 的 `env.staging`。

| 項目 | 值 |
| --- | --- |
| Worker 名稱 | `line-chat-bot-staging` |
| 網址 | `workers.dev`。沒有 route |
| 禁止 | `linebot.maou.app` 與任何正式 route |
| Durable Object | binding `BOT_STATE`，class `BotState` |
| Migration | `env.staging.migrations` 的 tag `v1`，`new_sqlite_classes` 是 `BotState`。Wrangler 不繼承頂層 `migrations`，所以寫在 staging 裡 |
| Observability | `logs.enabled` 為 true，`invocation_logs` 為 false。Invocation log 會記下 request URL，callback path 含 channel secret |
| `account_id` | 不寫進 `wrangler.jsonc`。由環境變數 `CLOUDFLARE_ACCOUNT_ID` 提供。設定檔裡的 `account_id` 會蓋過這個變數 |

## Secret

不要把值寫進 git，不要印出來。

必須先備好的 secret：

1. `IMPORT_SECRET`。匯入端點用。未設定時該端點應回 404。
2. 測試用 LINE channel secret。
3. 測試用 LINE channel access token。

測試用的 channel secret 與 token 必須來自另開的測試 channel。不得使用正式 channel。這兩項放在 webhook path，不是 wrangler secret。會寫進 Worker 的只有 `IMPORT_SECRET`。

`wrangler secret put` 會立刻建立並部署新版本。不要在下面的 dry-run 之前執行。通過檢查後，由 Cloudflare bot 在獲授權的部署步驟執行：

```bash
npx wrangler secret put IMPORT_SECRET --env staging
```

## 部署前檢查

在 `workers/` 執行：

```bash
npx wrangler deploy --dry-run --env staging
```

`--dry-run` 不發布。確認輸出裡的 Worker 名稱是 `line-chat-bot-staging`，有 `BOT_STATE`，而且沒有 `linebot.maou.app`。migration tag `v1` 改看 `workers/wrangler.jsonc` 的 `env.staging.migrations`，dry-run 不會印出 migration。

通過之後才由 Cloudflare bot 執行上面的 `wrangler secret put`，以及真正的 `wrangler deploy --env staging`。

## 回滾

Staging 還沒有接上正式 webhook。回滾只影響測試網址。

1. 在 Cloudflare dashboard 的 Workers 部署紀錄，把 `line-chat-bot-staging` 回到上一版。
2. 或在 `workers/` 對上一個已知 commit 再執行 `wrangler deploy --env staging`。
3. 若測試用 LINE webhook 已指向 staging，先把該測試 channel 的 webhook 改回空值或上一版測試網址，再回滾 Worker。不要改正式 channel 的 webhook。

## 成本

目標是停在 Workers Free 與 Durable Objects Free。數字來自 `docs/adr/0001-workers-database.md`（核對日 2026-11-19）。

| 指標 | 免費額度 | 估算（正式流量） |
| --- | --- | --- |
| Workers 請求 | 100,000 / 日 | 約 2,600 / 日 |
| Durable Objects 請求 | 100,000 / 日 | 約 2,600 / 日 |
| Rows read | 5,000,000 / 日 | 約 310,000 / 日 |
| Rows written | 100,000 / 日 | 約 7,800 / 日。匯入另計，含索引。每日上限扣掉日常後抓 80,000 write units，不是 80,000 筆資料列 |
| DO duration | 13,000 GB-s / 日 | 最壞整天常駐約 10,800 GB-s。實際應遠低於此 |
| 儲存 | 5 GB | 匯入前量正式庫大小 |

部署後看 Cloudflare dashboard 的 Workers 與 Durable Objects 用量，對上表記錄實測。DO duration 是唯一接近上限的項目。
