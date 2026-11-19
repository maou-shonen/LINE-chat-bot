docs(workers): 起草 staging 設定與切換前驗收清單

## Why

Workers 骨架還不能部署。先把 staging 的名稱、Durable Object migration、不記 request URL 的 log，以及切換前要勾的項目寫下來。部署與正式 webhook 切換都不在這支 PR。

依賴 PR #48。請先 review #48。Base 是 master。CI 只在 base 為 master 時觸發。

## What

- `workers/wrangler.jsonc` 的 `env.staging`：Worker 名稱 `line-chat-bot-staging`，`workers_dev` 為 true，沒有 route，也沒有 `linebot.maou.app`。
- `account_id` 維持 32 個 0。
- Staging 自帶 `migrations` tag `v1`（`BotState`）。Wrangler 不繼承頂層 migrations。
- Observability 開啟 logs，`invocation_logs` 為 false。Callback path 含 channel secret，不能記 request URL。
- `docs/staging.md`：部署草稿、secret 清單、dry-run、回滾、免費額度。
- `docs/acceptance-checklist.md`：功能、184/184、CPU、額度、匯入、安全、切換前條件、已知差異。

## Scope

只寫文件與設定。沒有 `wrangler login`，沒有 `wrangler deploy`，沒有改 webhook、DNS、tunnel 或 NAS。沒有使用正式 LINE token。

Secret 是 `IMPORT_SECRET`，加上另開測試 channel 的 channel secret 與 access token。不得用正式 channel。

## Verification

`workers/wrangler.jsonc` 去掉 `//` 註解後可被 JSON 解析。沒有跑 `wrangler deploy --dry-run --env staging`。本機沒有已登入的 Cloudflare 帳號，dry-run 留在 `docs/staging.md`，由 Cloudflare bot 在選定帳號後執行。`omp cleanse --all` 沒有可用的 ruff 或 tsc。

## Self-review

- 正確性：staging 的 DO binding 與 migration 都寫在 `env.staging`，不靠繼承。`invocation_logs: false` 關掉會記錄 URL 的 invocation log。自訂 `console.log` 仍可能印出 URL。目前程式沒有這種 log。部署前記得再搜一次。
- 範圍：沒有加正式 route，沒有改頂層 production 的 `workers_dev`。
- 已知行為，TS 版要照舊，這支 PR 只寫進清單，沒有改程式：
  1. 第一次在群組學習時，回覆可能是「None 新增」。顯示名稱在組回覆之後才查。
  2. 「設定=全圖片」的說明文字與實際行為不一致。
- `keywords_logs` 保留，清單有列。
- 風險：`workers.dev` 網址仍含帳號子網域。那不是 secret，但測試 channel 的 webhook 不要指向正式網域。未設定 `IMPORT_SECRET` 回 404 是驗收條件，這支 PR 沒有實作匯入端點。
