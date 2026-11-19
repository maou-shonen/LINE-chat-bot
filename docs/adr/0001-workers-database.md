# ADR-0001：Workers 版資料庫選 Durable Object SQLite（D1 為備案）

狀態：已接受。本文件隨 workers 骨架進入 repo。決定與下方表格的數字沿用 2026-11-19 草案。
日期：2026-11-19（台北時間）

## 背景

現行系統是 Python 加 SQLite（WAL）單檔，跑在 NAS docker，image sha-7c888b1 之後的版本。
流量是 NAS 實測推估。每日約 2,600 個 webhook 事件，其中群組文字訊息約 1,450 則。尖峰約平均 3 倍。
目標是在 Cloudflare Workers Free 方案內長期運作。
每則群組文字訊息的查詢包含 group 與 group_user 讀寫（計數）、user_settings 多次 get、user_keyword 依群組列出，以及全回應 anchor probe（`anchor IN (...)` 加上 anchor_lengths）。

## Free 方案限制

2026-11-19 對過官方文件。表內數字沒有改。核對記錄在文末。

| 項目 | Workers | D1 | Durable Objects（SQLite） |
|---|---|---|---|
| 請求 | 100k/日 | 不適用 | 100k/日 |
| CPU | 10ms/次 | 不適用 | 10ms/次（同 Worker 規則） |
| 讀取列 | 不適用 | 5M/日 | 5M/日 |
| 寫入列 | 不適用 | 100k/日 | 100k/日 |
| 儲存 | 不適用 | 5GB | 5GB |
| 時長 | 不適用 | 不適用 | 13,000 GB-s/日 |

## 估算

估算的前提是修好 user_settings 索引，而且不再寫空預設列。

請求約 2,600 次 Worker，加上約 2,600 次 DO。只有需要資料庫的事件才進 DO。各約 3%。
讀取列約 31 萬/日（6%）。寫入列約 7,800/日（8%）。尖峰 3 倍仍低於 25%。
DO 時長的最壞情況是整天常駐。86,400 秒乘 0.125 GB 等於 10,800 GB-s，低於 13,000（83%）。實際只在有事件時活著，遠低於此。這是 DO 唯一需要盯的指標。驗收時要量。
資料匯入的寫入列算額度。每日上限 100k。扣掉日常用量，匯入每天上限抓 80k 列，需要分批。先前估計 4 到 5 天。

## 選項比較

| | DO SQLite | D1 |
|---|---|---|
| 查詢延遲 | 同行程同步 SQLite。單則訊息十幾次小查詢幾乎零延遲。 | 每次查詢一次網路往返。十幾次累加會變慢。batch 可以緩解，但要重構流程。 |
| 一致性 | 單一 DO 序列化執行，天然避免計數競態。現行 Python 靠 SQLite 鎖。 | 需要自己用 batch 或 transaction 處理。 |
| CPU 10ms | 查詢在 DO 內。Worker 只驗簽轉送。DO 也是 10ms，但不用等網路。 | Worker 等 I/O 不算 CPU，但 JSON 解析和抽卡仍算。 |
| 匯入 | 要寫匯入端點。分批 POST，DO 內 transaction。 | `wrangler d1 execute --file` 直接匯。 |
| 備份與回溯 | SQLite DO 有 PITR（30 天，需確認 Free 是否可用）。 | Time Travel（Free 7 天）。 |
| 檢視資料 | 要自己做 debug 端點或匯出。 | Dashboard 或 wrangler 直接查。 |
| 擴展 | 單一 DO 處理全部流量。每日 2,600 沒有壓力。 | 無單點問題。 |

## 決定

採用 Durable Object SQLite。單一 DO，類別 `BotState`，`idFromName("global")`，持有全部資料。
理由是每則訊息有多次小查詢和計數寫入。同步 in-process SQLite 最省延遲，一致性也最簡單。額度與 D1 相同。多出的 DO 時長在最壞情況也在上限內。

D1 是備案。若驗收時 DO 時長或 PITR 在 Free 不可用而造成問題，資料層用 repository 介面隔離，可以換成 D1 實作。schema 與 fixtures 維持同一份。

## 連帶的 schema 決定

TypeScript 版一開始就這樣設計。

`user_settings` 用 `group_id TEXT NOT NULL DEFAULT ''` 與 `user_id TEXT NOT NULL DEFAULT ''` 取代 NULL，主鍵是 `(group_id, user_id)`。查詢直接 `WHERE group_id = ? AND user_id = ?`，命中主鍵。現行 Python 的 unique index 是 `coalesce(...)` 運算式索引，但查詢寫 `group_id = ?`，用不到，所以每次全表掃 5.5 萬列。
讀取設定不建立空列。查不到就回預設值。只有 update 才 upsert。匯入時丟掉 `options = '{}'` 的空預設列。
`group_user` 同理。`gid` 與 `uid` 都是 NOT NULL，再加上複合主鍵。
`user_keyword` 保留 `anchor` 欄位與索引，也保留 `(id, keyword)` unique。
`keywords_logs` 這批先建表。要不要保留，或加保留期限，留給後續 PR。寫入列額度是取捨的理由。

## 待驗證

這些項目不阻擋決定。

1. Free 方案 SQLite DO 的 PITR 是否真的可以還原。文件說 SQLite-backed class 有 30 天 PITR API，而且 Free 只能建立 SQLite-backed class。這批沒有在 Free 帳號上呼叫還原。
2. 超過 300 字訊息的 anchor probe，以及一萬抽，在 Workers 上的 CPU 時間。目標低於 10ms。需要 miniflare 或 wrangler dev 量。
3. 尖峰小時事件數與私訊量。現在是估計值。
4. Free 方案單一 DO 的儲存上限。limits 表寫每個 object 10 GB，帳號合計 5 GB。同一頁 FAQ 寫 Free 寫入在 1 GB 失敗。5 GB 是帳號合計，表內數字不變。匯入前要量正式庫大小。

## 官方文件核對

核對日是 2026-11-19。決定與表內數字沒有因為核對而改。

Workers Free 的請求是 100,000/日，CPU 是 10 ms。來源是 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。
Durable Objects Free 的請求是 100,000/日，時長是 13,000 GB-s/日。來源是 [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)，頁面標註 2026-11-13。時長計費按 128 MB 分配，所以估算裡的 0.125 GB 與文件一致。
SQLite 讀取列 5 million/日、寫入列 100,000/日、儲存 5 GB，同一頁。
DO limits 頁把 CPU 預設寫成 30 秒，並寫 Durable Objects 與 Worker 使用同一套每次呼叫的 CPU 上限。Free 方案綁住的是 Workers 的 10 ms。表內 10 ms 維持不變。來源是 [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)，頁面標註 2026-11-13。
