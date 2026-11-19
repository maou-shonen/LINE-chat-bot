# 任務 N 報告

目標是只寫 staging 部署草稿與驗收清單，不部署。

- 分支：`docs/workers-staging`
- 設定與文件：`7bf725164a8738c6d632f405552371b9cdde32ef`
- 本報告：隨後的 commit。Push 目標是 `git@github.com:maou-shonen/LINE-chat-bot.git` 的 `docs/workers-staging`。沒有改 remote。

## 驗證

- `workers/wrangler.jsonc` 去掉行註解後，`json.loads` 成功。
- 沒有執行 `wrangler deploy`、`wrangler login`，也沒有執行 `wrangler deploy --dry-run`。
- `omp cleanse --all`：ruff 與 tsc 都不在 PATH，沒有跑成 checker。

## 未做

沒有開 PR。依 brief，PR 由你開。說明在 `PR_BODY.md`。Base 是 master，依賴 #48。
