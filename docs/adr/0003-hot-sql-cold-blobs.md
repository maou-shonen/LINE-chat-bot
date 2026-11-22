# ADR-0003：資料模型改為「熱資料用 SQL，冷資料與關鍵字語料用 blob」

狀態：已接受，採用方案 C（2026-11-22，使用者確認）。
日期：2026-11-22（台北時間）
取代：ADR-0001 的「全部資料一列一列放進 DO SQLite」部分。DO 作為唯一狀態持有者的決定不變。

數字來源分三種，標在每個數字後面：

- **〔官方〕**：Cloudflare 文件，2026-11-22 讀取。
- **〔實測〕**：Cloudflare GraphQL 或 telemetry，或在 shonen-lab 對 2026-11-21 快照的唯讀量測。
- **〔估算〕**：由程式碼推算，尚未在 Cloudflare 上量過。

## 1. 問題

### 1.1 計費規則

- SQLite 的 rows written：每寫一列算 1，每個被動到的索引再加 1。列的大小不影響計數，1 KB 和 100 KB 都算 1 列〔官方：[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)，DO 沿用同一套〕。
- DO 的 KV API（`get`、`put`、`delete`、`list`）存在隱藏的 SQLite 表裡，以 rows 計費。每個 key 算 1 列。`setAlarm()` 算 1 列，刪除也算寫入〔官方：[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)〕。
- 單一 KV 值（key 加 value）上限 8 MB〔官方：[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)〕。
- Free 方案每天 100,000 rows written、5M rows read，每次請求 10 ms CPU，每次請求 50 個 subrequest，每個 isolate 128 MB 記憶體〔官方：DO pricing、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)〕。

結論：**寫入成本取決於「列數」，和資料量無關。** 把冷資料拆成一列一列，是在用最貴的方式存最不常用的東西。

### 1.2 現在每筆資料寫幾列（匯入）

| 表 | 來源列 | 每列 write units | 合計 |
|---|---|---|---|
| user_keyword | 50,929 | 4（列 + `anchor`、`length(anchor)`、`(id, keyword)` 三個索引）＋ probe cache 約 1 | 約 255,000 |
| keywords_logs | 65,416 | 2 | 130,832 |
| group_user | 57,543 | 2 | 115,086 |
| user | 43,848 | 2 | 87,696 |
| group | 4,407 | 2 | 8,814 |
| user_settings | 4,250（另有 51,236 列空的不匯） | 2 | 8,500 |
| import_batches | 1,136 批 | 2 | 2,272 |

- 匯入工具算出 556,916 units〔實測，dry-run〕。
- 第 1 天：匯入工具記 80,000 units，Cloudflare 記到 **100,532 rows written**〔實測，GraphQL `durableObjectsPeriodicGroups`，2026-11-21 15:45 UTC〕。多出來的約 20,500 列是每批 user_keyword 觸發的 probe cache delta 和 compaction。換算每一列關鍵字約多寫 1 列〔實測〕。
- 全部合計約 609,000 rows，每天 80,000 要 **7.6 天**〔估算，依實測比例〕。

### 1.3 資料大多是冷的〔實測，快照唯讀彙總〕

| | 全部 | 近一年有更新 | 近 30 天 |
|---|---|---|---|
| group | 4,407 | 約 80 | 35 |
| user | 43,848 | 約 830 | 307 |
| group_user（所屬群組近一年活躍） | 57,543 | 2,604 | 不適用 |
| keywords_logs | 65,416 | 192 | 不適用 |
| user_keyword（範圍屬於近一年活躍的群組或使用者） | 50,929 | 3,588 | 不適用 |
| user_settings（非空，近一年活躍群組） | 4,250 | 79 | 不適用 |

- 約 90% 的列最後一次更新在 2018–2020 年。
- 關鍵字例外。設定「全回應」時會比對全部 50,929 筆，所以整份關鍵字語料是熱的，但它是**讀多寫極少**：近一年只新增 192 次。

### 1.4 每則訊息寫幾列〔估算，依 repository.ts〕

一則群組文字訊息：

| 寫入 | rows written |
|---|---|
| `user` upsert `update_on` | 1 |
| `group` upsert `update_on` | 1 |
| `group_user` upsert `_count` | 1 |
| `setUserName`（每則都寫，名字沒變也寫） | 1 |
| 有回應時 `觸發` +1 | 1 |

- 每則約 4–5 列。每天約 2,600 個事件，估計約 9,000–10,000 rows written，佔上限 10%。ADR-0001 估的是 7,800。
- 第一次出現的使用者或群組，還要多寫主鍵索引列。2026-11-21 15:44 的 6 次測試請求寫了 42 列〔實測〕，含建立假 user 和 group 列。
- **日常寫入不是問題，問題在一次性的匯入。**

### 1.5 查到的嚴重缺陷（和架構無關，任何方案都要修）

`dispatch.ts` 的 `currentName()` 呼叫 `repo.inspectTouch()`，也就是 `readTouch()`。它每次都全表讀取 user、group、group_user：

- 正式資料量下每次讀 **105,798 列**，在 shonen-lab 的 node:sqlite 上約 **125 ms** CPU〔實測，用快照模擬同樣的查詢〕。
- 幾乎每則群組文字都會走到這裡。結果是 10 ms CPU 必定超過，5M rows read 大約 47 則訊息就用完。
- 本機 bench 和 fixture 的資料量很小，所以沒抓到。
- 修法：改成 `SELECT name FROM user WHERE id = ?`。**已修（#63，a4623f6）**：每則群組文字讀 5–8 列，和表的大小無關；名字沒變時不寫入（miniflare cursor 計數）。

### 1.6 關鍵字 probe cache 在完整語料下〔實測，shonen-lab node，用 workers/src 的 aho.ts 和 keyword-rows.ts 建置〕

| 項目 | 數值 |
|---|---|
| 關鍵字 | 50,929 |
| anchor | 24,711 |
| Aho-Corasick 編碼後 | 1.29 MB |
| row blob | 10.86 MB |
| 建自動機 | 43 ms（compaction 以每步 ≤3 ms 分步，約要 15 步） |
| 編碼 row blob | 79 ms（約 27 步） |
| 解碼（冷啟動） | 自動機 0.7 ms，row blob 約 0 ms（typed array 視圖） |
| 5,000 字訊息 probe | 0.39 ms（624 個候選 anchor） |

這是 V8 on node，不是 workerd，只能當量級參考。

## 2. 方案比較

共同前提：

- 1.5 的缺陷一律要修。
- `setUserName` 改成名字有變才寫，每天約省 1,450 列〔估算〕。
- 目前 DO 裡匯入一半的資料（約 2 萬列關鍵字加 cache）不要用 `deleteAll()` 清。刪除算寫入〔官方〕，清掉約要 10 萬列。改用新的 DO 名稱（例如 `idFromName("v2")`），舊物件約 10 MB 放著，零寫入。

### A. 現況（一列一列進 DO SQLite）

| 項目 | 內容 |
|---|---|
| 匯入 | 約 609,000 rows，**7.6 天**〔估算，依 1.2 實測比例〕 |
| 日常 | 寫約 9–10k/日〔估算〕；讀 1.5 修完後約 31 萬/日（ADR-0001 估算） |
| 10 ms 風險 | 1.5 修完後低。probe 0.39 ms〔實測〕 |
| 回滾 | 要把全部 SQL 表匯出，再和 NAS 做差異 |
| 改動量 | 0（只修 1.5） |

### B. 修剪版（還是一列一列，砍掉不必要的列和索引）

- keywords_logs 歷史不匯，Workers 只寫新列。歷史留在 NAS 快照，或以 blob 封存。
- `user_keyword` 拿掉 `ix_user_keyword_anchor` 和 `ix_user_keyword_anchor_len`。`anchorUsedByOther` 和 `DISTINCT length(anchor)` 改用 probe cache 的 `byAnchor` 和長度表。每列從 4 降到 2。
- 匯入期間不做 per-batch delta 和 compaction，匯完再建一次 cache。

| 項目 | 內容 |
|---|---|
| 匯入 | user_keyword 101,858 + group_user 115,086 + user 87,696 + group 8,814 + settings 8,500 + 批次約 2,000 ≈ 324,000 rows，**約 4 天**〔估算〕 |
| 日常 | 同 A |
| 10 ms 風險 | 同 A |
| 回滾 | 同 A |
| 改動量 | 小到中。要改 schema（DROP INDEX，需要 DO migration 或新 DO 名稱）、改匯入流程 |

### C. 混合：熱資料 SQL，冷資料和關鍵字語料用 DO KV blob（建議）

**關鍵字語料**
- 在 shonen-lab 離線用同一份 TS 程式建好自動機和 row blob。
- 用 KV `put` 寫進 DO：用 1 MB 分塊是 13 塊，用 ≤8 MB 分塊約 3 塊，另加 meta，總共 ≤16 rows。
- `user_keyword` SQL 表只放切換後的新增、修改、刪除（現有 overlay、delta、compaction 機制已經支援）。
- 「列表」「查詢」「刪除」改讀 blob 加 overlay。row blob 已經有依範圍（id）的索引。

**群組冷資料**
- 每個群組一個 KV 值，內容是 group 列、它的 group_user、群組的 user_settings、成員名字。
- 共 4,407 rows。平均 1.8 KB，最大 110 KB（659 人）〔實測〕。

**私訊使用者**
- 所有 user 列和私訊設定（`group_id` 為空）依 id 的 FNV-1a 低 8 bit 分成 256 塊。群組成員也可能私訊，只放不在群組裡的 3,791 人會在第一次私訊時缺列。群組 blob 仍帶成員名字，hydration 不必為了群組去讀 user 塊。key 數仍是 256。

**keywords_logs 歷史**
- 13.9 MB，用 2 個 KV 值封存，或放 R2。只追加，請求路徑不讀（ADR-0002）。

**第一次碰到時才搬進 SQL（lazy hydration）**
- 某群組或使用者第一次有事件時，讀它的 blob（1 row read），在同一個 transaction 裡寫進 SQL。
- 平均約 2 ×（13 + 1 + 成員）≈ 60 rows。最大群組約 2,600 rows，只寫一次。
- 近一年活躍約 80 個群組，總共約 5–10k rows，分散在多天〔估算〕。

| 項目 | 內容 |
|---|---|
| 匯入 | 約 4,700 rows，**不到 1 天**（約一天額度的 5%）〔估算，依 1.3 實測〕 |
| 日常寫入 | 同 A，加上 hydration 的一次性寫入 |
| 日常讀取 | 比 A 少，SQL 表只有熱資料 |
| 10 ms 風險 | 低（v4，見 §4）。冷啟動只讀 automaton 與 meta，第一則私訊 process CPU 0–20 ms（10 ms 解析度）；5000 字暖路徑 p95 4 ms。冷啟動後第一則若是 5000 字且命中大量 anchor，仍要讀完 14.8 MB row chunk，p95 24 ms。hydration 最大群組（659 人）第一則 wall 2–3 ms，8 個 alarm 步驟合計 15–20 ms，SQL rows written 2,664〔實測〕。最大的幾個群組要分批，用 alarm 續做 |
| 記憶體 | v4 冷啟動第一則 process RSS 增加 7.0–11.4 MB〔實測〕，128 MB 上限〔官方〕內 |
| 回滾 | 簡單。沒被碰過的 blob 和 NAS 原資料一樣，只要匯出 SQL 熱表（切換後才建立或改過的列）加上關鍵字 overlay |
| 改動量 | 中到大。要做：離線建置與上傳工具、repository 的 hydration 層、關鍵字指令改讀 blob、新的匯入端點（寫 KV）。dispatch 和 fixture 不用動 |

**C 的變體：冷資料放 R2，不放 DO KV**
- 匯入改用 R2 PutObject，約 4,700 次，DO rows 是 0。R2 免費額度是每月 1M Class A、10M Class B、10 GB〔官方：[R2 pricing](https://developers.cloudflare.com/r2/pricing/)〕。
- 代價：多綁一個服務；hydration 和冷啟動要多一次 subrequest（Free 上限 50/請求〔官方〕）。
- 帳號是否已啟用 R2、啟用要不要付款資訊：**未驗證**。
- 多省的只有約 4,700 rows（不到一天額度的 5%），不值得。

**Workers KV 放關鍵字 blob**
- Free 方案每天 1,000 次寫入、100,000 次讀取〔官方：[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)〕，最終一致。
- 適合不可變的基準語料，但 DO 自己的 KV 已經夠用，不另外引入。

### C 的每日免費額度用量

日常量以 ADR-0001 的流量為準：每天約 2,600 個 webhook 事件、約 1,450 則群組文字。尖峰約 3 倍。

| 服務／指標 | Free 上限〔官方〕 | C 的日常用量 | 佔比 | 來源 |
|---|---|---|---|---|
| Workers 請求 | 100,000/日（[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)） | ≤2,600（LINE 一次 webhook 可能帶多個事件，實際更少） | ≤2.6% | 估算 |
| Workers CPU | 10 ms/請求 | 入口 p50 約 1.1–1.5 ms，最大 3.0 ms | 不適用 | 實測（GraphQL，2026-11-21） |
| DO 請求（含 RPC、alarm） | 100,000/日（[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)） | 約 2,600 + 少量 compaction alarm | 約 3% | 估算 |
| DO rows written（含 SQL 索引、DO KV `put`/`delete`、`setAlarm`） | 100,000/日（同上，註 2–4） | 約 8,000：每則群組文字在名字沒變時寫 3 列，名字有變 4 列，第一次見到的使用者 6 列，有回應時另加 1 列「觸發」；另有 hydration 一次性約 5–10k，分散在多天 | 約 8%，尖峰約 24% | 每則列數為實測（#63，miniflare），日量為估算 |
| DO rows read（含 DO KV `get`） | 5,000,000/日（同上） | 每則群組文字 5–8 列（#63 修正後，miniflare cursor 計數），約 2,600 × 8 ≈ 21k；關鍵字冷啟動每次 `get` ≤16 個 key | <1% | 每則列數為實測（miniflare），日量為估算 |
| DO 儲存 | 帳號 5 GB；單一 DO 上限 10 GB（[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)） | 4,718 個 key，value 50.76 MB，加 key 50.95 MB，熱資料 SQL 另計 | 約 1% | 實測（快照建置的 blob 檔案大小） |
| DO duration | 13,000 GB-s/日（DO pricing） | 未量測。最壞情況整天常駐約 10,800 GB-s（83%），實際只在有事件時活著 | 不適用 | 未量測（ADR-0001 估算） |
| Workers KV | 讀 100,000/日、寫 1,000/日（[KV pricing](https://developers.cloudflare.com/kv/platform/pricing/)） | 不使用 | 0 | 不適用 |
| D1 | 讀 5M/日、寫 100k/日（[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)） | 不使用 | 0 | 不適用 |
| R2 | 每月 10 GB、Class A 1M、Class B 10M（[R2 pricing](https://developers.cloudflare.com/r2/pricing/)） | 不使用（C 的 R2 變體才會用） | 0 | 不適用 |

一次性匯入（C）：約 4,700 DO rows written，佔一天額度約 5%〔估算〕。

### 沒有「本機整批灌入」的捷徑

- **DO SQLite 不能從外部載入。** Storage API 只能在 Durable Object 自己的程式裡使用〔官方：DO pricing「The Durable Objects Storage API is only accessible from within Durable Objects」〕。沒有上傳 SQLite 檔的 API，資料一定要經由 DO 的請求，以 SQL 或 KV 寫入，照列計費。C 的做法是在本機先把資料打包成少量大 blob，再送進 DO，用「key 數」換掉「列數」。
- **D1 的匯入照樣逐列計費。** D1 沒有上傳 `.sqlite3` 檔的方式，要先用 `sqlite3 .dump` 轉成 SQL，再用 `wrangler d1 execute --file` 執行〔官方：[Import and export data](https://developers.cloudflare.com/d1/best-practices/import-export-data/)〕。wrangler 沒有 `d1 import` 子命令〔官方：[wrangler d1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)〕。執行的每個 `INSERT`，包括把既有資料灌進新資料庫，都算 rows written，索引另計〔官方：D1 pricing FAQ「Do queries I run from the dashboard or Wrangler (the CLI) count as billable usage?」〕。

### D. 換成 D1

- D1 的計費和 DO 一樣按列計，索引另計。`wrangler d1 execute --file` 或匯入時的每個 `INSERT` 都要算〔官方：D1 pricing FAQ「Do queries I run from the dashboard or Wrangler count…」〕。**一次匯入沒有免費的路。**
- D1 和 DO 的定價頁各自列每天 100k 寫入。兩者是否共用額度：未驗證。

| 項目 | 內容 |
|---|---|
| 匯入 | 不修剪約 557k，每天 100k 約 5.6 天；套用 B 的修剪約 3.2 天〔估算〕 |
| 日常 | 列數同 A。每則訊息十幾次查詢，每次都是網路往返（ADR-0001） |
| 10 ms 風險 | 等 I/O 不算 CPU〔官方〕。但 probe cache 還是需要一個 blob 儲存（DO 或 KV），等於兩套儲存 |
| 回滾 | 最簡單，有 `wrangler d1 export` |
| 改動量 | 大。repository 要改成 D1 batch，同步 transaction 的計數邏輯要重寫 |

### 總表

| | 匯入天數 | 匯入 rows | 日常寫入 | 10 ms 風險 | 回滾 | 改動量 |
|---|---|---|---|---|---|---|
| A 現況 | 7.6 | 約 609k | 9–10k/日 | 低（修 1.5 後） | 難 | 0 |
| B 修剪 | 約 4 | 約 324k | 9–10k/日 | 低 | 難 | 小到中 |
| **C 混合（DO KV）** | **<1** | **約 4.7k** | 9–10k/日加一次性 hydration | 低到中 | **簡單** | 中到大 |
| D D1 | 3.2–5.6 | 324k–557k | 9–10k/日 | 低（但要兩套儲存） | 最簡單 | 大 |

## 3. 建議

採用 **C（熱 SQL、冷 blob、關鍵字語料離線建置）**，順序如下：

1. **先修 1.5**（`currentName` 改單列查詢）和 `setUserName` 只在名字變了才寫。不管選哪個方案都必須做，而且這是切換的阻擋項。
2. 停用現在的逐列匯入（排程已暫停），不再續跑。
3. 實作 C：離線建置與上傳、hydration、關鍵字指令讀 blob 加 overlay。在 workers.dev 用新的 DO 名稱匯入，不到一天就能完成。
4. 差異回填和回滾工具改成只處理熱 SQL 表加關鍵字 overlay。範圍比原計畫小很多。

為什麼不是 B：它省一半天數，但仍然要 4 天，回滾還是要全表匯出。冷資料逐列存放的根本問題沒解決。

為什麼不是 D：計費模型一樣，搬過去只換到網路延遲，外加兩套儲存。

## 4. 量測結果（2026-11-22，本機 workerd）

方法：`workers/bench/c-measure.bench.ts` 跑 miniflare，載入快照建置的真實 blob，用 `storage.sql.exec` cursor 計 rows read/written，`performance.now()` 計 wall。`workers/bench/c-local.mjs` 起 `wrangler dev --local`，從 `/proc` 讀 workerd process CPU（100 Hz）和 RSS。沒有連 Cloudflare。16 核，load average 0.22–0.24。完整表格見 `workers/bench/RESULTS.md`。

| 項目 | 數字 | 單位 |
|---|---|---|
| 關鍵字 blob | chunk 15,873,670 bytes，2 個 meta 另計，15 個 key，最大 row chunk 1,300,000 bytes，每次冷啟動 16 個 `get` | — |
| 冷啟動解碼（isolate 內，3 輪） | 2–4 ms | wall |
| 冷啟動後第一則私訊（重啟 workerd） | wall 43.9–48.1 ms，process CPU 50–60 ms，RSS +42.8–44.0 MB（3 次） | 混合 |
| 同一則暖路徑 | wall 6.1–6.5 ms，process CPU 0–20 ms，RSS +0.8–0.95 MB | 混合 |
| 659 人群 hydration，第一則 | 2–3 ms wall；SQL 64 rows read、2,664 rows written，含 8 個 alarm 步驟 | wall／rows |
| 每個 hydration alarm | 最大 2–5 ms；8 步合計 15–20 ms | wall |
| hydrate 後群組文字訊息 | 1–2 ms，5 rows read、3 rows written | 混合 |
| 私訊（keyword 已載入） | 2 ms，0 rows read、4 rows written；暖 0–1 ms，1 read、1 write | 混合 |
| 觸發回覆（keyword overlay，LINE fetch 以測試替身） | 1–2 ms，5–6 rows read、3 rows written | 混合 |
| `/import/kv` 最大 key | 1.0–1.3 MB：DO 內 8–13 ms wall；經 HTTP 13–15 ms wall、process CPU 0–30 ms | 混合 |
| 全部 4,717 個 blob（50.76 MB）| 12.7 s wall、13.0 s process CPU、RSS 峰值 +550 MB（1 次） | 混合 |
| 上傳 put 數 | 4,718（含 manifest），約每日 100k 寫入額度的 4.7% | rows written |
| DO 儲存 | value 50,764,147 bytes（含 manifest），key 184,391 bytes，合計 50.95 MB | bytes |

限制：

- workerd 沒有 isolate CPU 或 heap 指標。CPU 是整個 workerd process 的 utime 加 stime，解析度 10 ms；小於 10 ms 的值會落在 0–10 ms。
- 冷啟動第一則包含 Worker entry 和 DO isolate 啟動，不只 blob 讀取。暖路徑是同一個 process 的第二則。
- rows read/written 是 SQLite cursor 計數，和計費基礎一致；KV `get` 的列數另計（冷啟動 16 個）。
- 上傳的 550 MB RSS 是 4,717 個請求的瞬時峰值，不是常駐。
- 還沒量：台北 08:00 後 workers.dev 的實際 rows written 與 GraphQL CPU；D1 與 DO 是否共用 100k 寫入額度；R2 啟用狀態。

### v4.1：lazy row chunk + phase timing（2026-11-22 深夜，取代上表）

v3 的冷啟動一次 `get` 15.9 MB（automaton 1.29 MB 加 row table 14.6 MB），process CPU 50–60 ms、RSS +43 MB。v4 把 row table 拆成 8 個依 anchor hash 分區、可獨立解碼的 chunk，冷啟動只讀 meta、automaton、delta meta；命中才讀需要的 chunk，並在記憶體快取。v4.1 再把 meta 與 delta meta 合成一次 multi-get、row chunk 也一次 multi-get，快取同一訊息的 anchor hits，長訊息只解碼可能命中的列（這份語料 1591 候選降到 467 列）。

| 項目 | v4.1 | v3 |
|---|---|---|
| 關鍵字 blob | 10 個 key，16,077,526 bytes（meta 361 bytes 另計）；8 個 row chunk，最大 1,987,892 bytes | 15 個 key，15,873,772 bytes |
| 冷啟動 `get` | 2（meta+delta meta、aho） | 16 |
| 冷啟動 decode | 0 ms | 2–4 ms |
| 冷啟動第一則私訊 | wall 15.1–18.3 ms；process CPU 20 ms；RSS +8.0–12.4 MB | wall 43.9–48.1 ms；CPU 50–60 ms；RSS +42.8–44.0 MB |
| 5000 字真實語料，暖 | p50 3 ms、p95 4 ms；scan 1、fetch 2、match 1 ms；完整 callback 6.9–8.5 ms | 約 30 ms（Cloudflare，扣冷啟動） |
| 5000 字真實語料，冷 | p50 17 ms、p95 21 ms（讀完 8 個 chunk、14.8 MB） | 未量 |
| compaction 單段 | 最大 3–4 ms（偶發 13 ms wall 尖峰），50,929 列約 235–293 段 | 最大 3 ms |
| 上傳 | 4,712 個 blob key、50,968,114 bytes；build 的 puts 是 4,713（含 manifest），只重傳有變動的 11 個 put | 4,718 個 put |

`PHASE_TIMING=1` 時 DO 會印 `phase {json}`，只有固定名稱、毫秒與計數。本機樣本：`startup` constructor 0 ms、migrate 0–1 ms；`cacheLoad` coldGet 2–3 ms、aho get 1–2 ms、decode 0 ms；冷短訊息 `callback.total` 9–12 ms；冷長訊息 27 ms（chunk multi-get 18–19 ms、decode 0、match 1）；暖長訊息 3–4 ms（rowsGet 2–3、match 0–1、2 次 probe）。分段點在 I/O 邊界；Cloudflare 的 `Date.now()` 在同步 CPU 期間不會前進，這些 span 是 wall/I/O 邊界，不是純 CPU，CPU 仍要看 `wrangler tail` 的 `cpuTime`。

限制：workerd 的 process CPU 解析度是 10 ms，冷啟動 10–30 ms 只能說約 1–3 個 tick；模組初始化在 workerd 的 `Date.now()` 下不可觀測。冷啟動後第一則若本身就是 5000 字且命中大量 anchor，仍需讀完所有 row chunk，這是 lazy chunk 的資料量下限。暖 miss 的 9–18 ms 尖峰在本機沒有重現，需在 CF 上用 phase 行定位。完整表格、phase 欄位與重跑指令見 `workers/bench/RESULTS.md` 的「Option C v4.1」。
