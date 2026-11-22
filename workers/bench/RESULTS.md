# Probe CPU

列快取之後，六個案例的熱路徑和冷啟動第一則 p95 都低於 7ms。常用字 5000 字熱路徑 p95 是 4ms，冷啟動第一則 p95 是 5ms。每則訊息讀 0 列 SQLite。

`keywordRows` 加 `renderReply` 與 `selectKeywordReplies` 在常用字 5000 字上沒有可量到的差距。21 輪交錯，計時解析度 1ms。熱路徑兩邊 p50、p95、max 都是 5ms。冷啟動請求 p95 是 5ms，max 是 7ms。回覆是 `["hit"]`。同一次的拆分是掃描 1ms、取列 1ms、比對 1ms，`rowsRead` 是 0。`renderReply` 沒有超出這個 1ms 地板。機器 16 核，load average 1.18、0.80、0.73。再跑一次冷啟動 max 是 5ms。

方案 2 和方案 3 之後，常用字 5000 字的熱路徑 p95 仍是 63ms，冷路徑 p95 是 82ms。兩者都超過 Workers Free 10ms。長度 1 的位元圖和長度 2 的 trie 沒有拿掉長度 3 到 128 的滑動視窗，掃描還是約 40ms。下面先記直方圖那一輪。方案 2 和方案 3 在文末。

計時在 Durable Object 裡，用 `performance.now()`。回傳值是整數毫秒。冷啟動從 `storage.get` 回來之後才算。機器 16 核。量測前 load average 是 0.14、0.25、0.27。接著又跑一次。常用字 p50 仍是 51ms。0 填充的 5000 字第二次是 p50 18ms。均勻 CJK 第二次是 p50 6ms。下表是第一次，因為那次有掃描、取列、比對的拆分。

## 資料

列數 50,929。distinct anchor 24,711。`id` 都不是 NULL，全回應 probe 仍掃全部群組，bench 的 `scopeId` 是 null。

長度 1 到 12 用聚合的個數。長度 1 是 939，其中 CJK 851，其餘 88 個用數字、英文字母和標點。常用字是 hermitdave FrequencyWords 2018 `zh_cn_50k` 的詞頻加到字上，只留 CJK，取前 3500。前 851 字約佔該表 CJK 出現次數的 90.8%。長度 2 以上用這份表最前面的 400 字組成，避免和長度 1 撞字。

長度 12 以上的 499 個 anchor、54 種長度，聚合沒有逐筆。合成用 13 到 65 再加上 128。這是 54 種長度裡、又包含 128 的最短那組。個數從 82 降到 1，128 只有 1 個。若正式庫的空檔比這組長，掃描會更慢。做出來共 66 種長度，distinct 平均長度 3.981。先前說的平均 3.34 對不上這份直方圖。長度 1 到 12 本身的平均已經是 3.66。

多出來的 26,218 列從這 24,711 個 anchor 均勻重抽。重疊次數沒有聚合。一筆長度 10 固定成 `zzsentinel`，關鍵字是 `**zzsentinel**`，回覆是 `hit`。

0 填充的訊息中間放 `zzsentinel`。四種長度都選中 `hit`，候選 23 列。常用字訊息和均勻 CJK 訊息開頭也放 `zzsentinel`，其餘分別照字頻和 U+4E00 起 8192 個碼位均勻抽。常用字候選 3452 列。均勻 CJK 候選 534 列。回覆都有內容。沒有錯誤。

300 字以下用訊息子字串加 `anchor IN`。超過 300 字用記憶體裡的 anchor `Set` 和 66 種長度做滑動視窗。沒有縮短訊息。

## 熱路徑

21 輪交錯。百分位是 nearest rank，`ceil(p * 21) - 1`。

| 訊息 | p50 | p95 | max | min |
| --- | --- | --- | --- | --- |
| 24 字，0 填充 | 0ms | 1ms | 1ms | 0ms |
| 300 字，0 填充 | 3ms | 3ms | 4ms | 2ms |
| 1000 字，0 填充 | 4ms | 5ms | 6ms | 4ms |
| 5000 字，0 填充 | 20ms | 21ms | 23ms | 19ms |
| 5000 字，常用字頻率 | 51ms | 57ms | 62ms | 44ms |
| 5000 字，均勻 CJK | 6ms | 9ms | 10ms | 4ms |

0 填充的 5000 字這次慢，是因為 `0` 是長度 1 的 anchor。先前那組資料沒有把 `0` 放進 anchor，視窗直接跳過，所以看起來只要 1ms。

同一次執行裡，21 輪之後各拆了一次，不進上表。0 填充 5000 字是掃描 20ms、取列 0ms、比對 0ms。常用字是掃描 40ms、取列 6ms、比對 1ms。均勻 CJK 是掃描 5ms、取列 1ms、比對 0ms。比對不是上限。常用字慢在 66 種長度的切片，再加上 3452 列的取列。均勻 CJK 命中少，所以快。它不是這份 anchor 的最壞訊息。

## 冷啟動

blob 是 172511 bytes，1 塊。SQLite DO 的單筆上限是 key 加 value 合計 8MB，見 [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)，頁面標註 2026-11-13。1MB 才分塊。21 輪都先丟掉記憶體集合再反序列化。

| 冷啟動步驟 | p50 | p95 | max | min |
| --- | --- | --- | --- | --- |
| 只反序列化，常用字那輪 | 5ms | 6ms | 7ms | 5ms |
| 反序列化加常用字 5000 字 | 52ms | 56ms | 59ms | 51ms |
| 只反序列化，均勻 CJK 那輪 | 4ms | 5ms | 6ms | 4ms |
| 反序列化加均勻 CJK 5000 字 | 8ms | 9ms | 14ms | 7ms |

只反序列化低於 10ms。常用字的第一則超過。均勻 CJK 的 p95 是 9ms，max 是 14ms，max 超過。

## 先前的合成

改成這份直方圖之前，有兩輪不該再拿來當正式庫。一輪是長度 1 到 30 均勻，隨機英文字母 p50 23ms。一輪把長度 1 估成 7397，常用字範圍均勻抽，p50 27ms。長度 1 的實際個數是 939。

重跑是 `npm run bench`，在 `workers/`。

## 方案 2

直方圖那輪的常用字 5000 字 p95 是 57ms，沒有低於 10ms。接著把命中改成先收集 anchor。訊息和關鍵字完全相同、而且不是全回應時，先依 `keyword` 取列就回覆，不再把所有命中 anchor 的列撈出來。長訊息對不上整個關鍵字，所以這條捷徑沒有少撈列，還多了一次查詢。

load average 0.67、0.52、0.38。

| 訊息 | p50 | p95 | max |
| --- | --- | --- | --- |
| 5000 字，0 填充 | 20ms | 21ms | 22ms |
| 5000 字，常用字頻率 | 54ms | 59ms | 64ms |
| 5000 字，均勻 CJK | 8ms | 11ms | 12ms |
| 冷啟動後常用字 5000 字 | 54ms | 59ms | 60ms |

常用字拆開是掃描 42ms、取列 8ms、比對 1ms。掃描沒有變小。

## 方案 3

長度 1 改成位元圖，長度 2 改成兩層 trie。更長的 anchor 仍走原來的滑動視窗。比對結果的測試 6 項通過。

load average 0.88、0.61、0.41。

| 訊息 | p50 | p95 | max |
| --- | --- | --- | --- |
| 5000 字，0 填充 | 20ms | 22ms | 23ms |
| 5000 字，常用字頻率 | 54ms | 63ms | 72ms |
| 5000 字，均勻 CJK | 8ms | 11ms | 11ms |
| 冷啟動後常用字 5000 字 | 65ms | 82ms | 83ms |

常用字拆開仍是掃描 40ms、取列 8ms、比對 2ms。長度 1 和 2 只佔切片成本的一小段。長度 3 到 128 還在，所以沒有低於 10ms。方案 2 加方案 3 之後停在這裡。

## Aho-Corasick

所有長度都走同一台自動機，不再做滑動視窗。anchor 集合變了才整台重建，編成 typed-array blob 放 DO storage。冷啟動只反序列化。這次 blob 是 594360 bytes、1 塊。單筆上限仍是 key 加 value 8MB，超過 1MB 才分塊。最後一次重建（24711 個 anchor）是 8ms，算在寫入路徑，不是讀取路徑。

`performance.now()` 仍是整數毫秒。21 輪。全 0 的 5000 字不再塞 `zzsentinel`。

| 訊息 | 熱 p50 | 熱 p95 | 熱 max | 只反序列化 p95 | 反序列化加第一則 p95 | 該輪 request max |
| --- | --- | --- | --- | --- | --- | --- |
| 24 字，0 填充 | 2ms | 3ms | 3ms | 1ms | 4ms | 8ms |
| 300 字，0 填充 | 2ms | 3ms | 5ms | 1ms | 3ms | 3ms |
| 1000 字，0 填充 | 2ms | 3ms | 4ms | 1ms | 3ms | 4ms |
| 5000 字，全 0 | 2ms | 3ms | 3ms | 1ms | 3ms | 3ms |
| 5000 字，常用字頻率 | 10ms | 11ms | 11ms | 1ms | 10ms | 12ms |
| 5000 字，均勻 CJK | 4ms | 5ms | 6ms | 0ms | 4ms | 4ms |

常用字拆開是掃描 1ms、取列 8ms、比對 1ms。掃描掉下來了。剩下的是命中 anchor 很多時的 SQL 取列。常用字熱路徑 p95 11ms，沒有低於 10ms。冷路徑第一則的 p95 是 10ms，max 12ms。

## 列快取

取列不再走 `anchor IN`。寫入時把列編成 blob：anchor 與 keyword 的 hash 索引，加上 utf-16 原文。熱路徑用記憶體裡的 Map。冷啟動只掛上這個 blob 的 view，命中的列才做成字串。比對和抽選順序仍跟 SQL `ORDER BY _id` 同一套。

blob 是 3422330 bytes、4 塊。自動機仍是 594360 bytes、1 塊。單筆上限仍是 key 加 value 8MB，超過 1MB 才分塊。這次寫入路徑最後一次重建自動機是 12ms。load average 0.39、0.37、0.37。

`performance.now()` 仍是整數毫秒。21 輪。

| 訊息 | 熱 p50 | 熱 p95 | 熱 max | 只反序列化 p95 | 反序列化加第一則 p95 | 該輪 request max | 讀列 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 24 字，0 填充 | 0ms | 0ms | 0ms | 2ms | 2ms | 2ms | 0 |
| 300 字，0 填充 | 0ms | 0ms | 1ms | 1ms | 1ms | 1ms | 0 |
| 1000 字，0 填充 | 0ms | 0ms | 0ms | 1ms | 1ms | 1ms | 0 |
| 5000 字，全 0 | 0ms | 1ms | 1ms | 1ms | 1ms | 1ms | 0 |
| 5000 字，常用字頻率 | 3ms | 4ms | 4ms | 0ms | 5ms | 5ms | 0 |
| 5000 字，均勻 CJK | 1ms | 1ms | 1ms | 1ms | 1ms | 2ms | 0 |

常用字拆開是掃描 1ms、取列 0ms、比對 2ms。先前同一則是取列 8ms、3452 列。現在每則訊息讀 0 列。一天 500 萬則的話，列讀取是 0，對照先前約 3452 × 5e6 = 1.726e10 列。

`anchorOf`、`keywordLevel`、全回應模式下 `reply` 長度都用 code point，平手的 anchor 留第一個，對齊 Python `len`。讀取路徑沒有 300 字門檻，也沒有滑動視窗。滑動視窗只留在自動機測試的參考函式，窗口長度也是 code point。這份 bench 資料全是 BMP，讀取數字不受影響。

## 寫入

學習和刪除只改 SQLite、記憶體裡的列，再追加一份 delta。不重寫 3.4MB 列 blob，也不重建自動機。新 anchor 放進 pending，掃描時用 `includes`，和自動機的命中併起來。既有 anchor 不進 pending。

CPU 從 `storage.get` 回來才算，和讀取同一口徑。21 輪。load average 沿用這一輪機器，約 0.4。

| 寫入 | 熱 p95 | 冷 CPU p95 | 冷的 storage.get p95 |
| --- | --- | --- | --- |
| 新 anchor | 1ms | 1ms | 10ms |
| 既有 anchor | 1ms | 1ms | 10ms |
| 刪除 | 1ms | 1ms | 12ms |

冷的 get 是把約 3.4MB 列 blob 讀回來，不計進 CPU。CPU 都是 1ms。

匯入把 `putKeywords` 每 1000 列叫一次。不會每批重建。delta 或 pending 達到 32 筆就在該次寫入裡跑一段 compaction，並排 DO alarm，每 10ms 再跑一段，直到回到門檻以下。單段最大 3ms。50929 列這次是 490 段。寫入不會把進行中的 compaction 作廢；段與段之間新增的列留在 delta。

門檻滿的時候，常用字 5000 字熱 p95 6ms、冷第一則 p95 6ms。同一狀態下再寫一筆（含那段 compaction）p95 1ms。

學習、疊加、刪除指令和 import 批次都走同一份 delta。import 寫進的 anchor 若是空白，會補成 code point 版 `anchorOf`，跟學習指令同一份函式。這次合併後重跑：常用字熱/冷 p95 都是 5ms，門檻上的讀取 p95 都是 6ms，寫入 p95 最高 2ms。compaction 單段最大 3ms。

# Option C（2026-11-22）

這節量 option C 的真實 blob。資料來自 2026-11-21 快照，只存在 `/tmp/c-blob-build-current` 和本機 workerd，沒有進 repo。機器 16 核，量測時 load average 0.22–0.24。沒有連 Cloudflare。

## 方法

- `npm run bench:c`：miniflare 載入真實 blob。用 `storage.sql.exec` 的 cursor 計 rows read/written，`performance.now()` 計 wall。5 次執行，下表是 5 次的最小到最大。
- `npm run bench:local`：起 `wrangler dev --local`，用 HTTP 打本機 Worker。從 `/proc` 讀 workerd process 的 utime 加 stime 當 CPU（100 Hz），以及 VmRSS。冷啟動是重啟 workerd 後的第一個請求，3 次。
- workerd 沒有 isolate CPU 或 heap 指標。CPU 是整個 process，包含 Worker entry 和 DO isolate 啟動，解析度 10 ms。

## 冷啟動關鍵字 blob

真實 blob 的 chunk 是 15,873,670 bytes，2 個 meta 另計，15 個 key 合計 15,873,772 bytes。最大 row chunk 1,300,000 bytes，probe 1,292,596 bytes。每次冷啟動 16 個 `get`（15 個 blob key 加 delta meta）。

| 指標 | 冷啟動 | 暖路徑 |
|---|---|---|
| wall | 43.9–48.1 ms | 6.1–6.5 ms |
| workerd process CPU | 50–60 ms | 0–20 ms |
| RSS 增量 | +42.8–44.0 MB | +0.8–0.95 MB |

isolate 內 3 輪 decode 是 2–4 ms，decode 只掛 view，沒有複製 15.9 MB。冷啟動的 wall 花在 16 次 KV `get` 和序列化，不是解碼。

## Hydration（659 人）

真實群組 blob 167,184 bytes。第一則訊息觸發 hydration，`HYDRATE_BATCH` 是 80，總共 8 個 alarm 步驟。

| 指標 | 第一則 | 每個 alarm | 合計 |
|---|---|---|---|
| wall | 2–3 ms | 最大 2–5 ms | 15–20 ms |
| rows read | 64 | | 64 |
| rows written | | | 2,664 |

hydrate 後的群組文字訊息是 1–2 ms、5 rows read、3 rows written。

## 一般訊息

| 訊息 | wall | rows read | rows written |
|---|---|---|---|
| 私訊，keyword 冷（DO 內） | 2 ms | 0 | 4 |
| 私訊，暖 | 0–1 ms | 1 | 1 |
| 群組文字，已 hydrate | 1–2 ms | 5 | 3 |
| 觸發回覆（keyword overlay，LINE fetch 為測試替身） | 1–2 ms | 5–6 | 3 |

## `/import/kv`

| key | 大小 | DO 內 wall | HTTP wall | process CPU |
|---|---|---|---|---|
| probe chunk | 1,292,596 B | 9–10 ms | 12.8–13.7 ms | 0–30 ms |
| row chunk | 1,300,000 B | 8–9 ms | 13.2–14.7 ms | 0–20 ms |
| log chunk | 999,985 B | 10–13 ms | 13.9–15.3 ms | 0–30 ms |
| 最大群組 | 167,184 B | 3–4 ms | 6.0–6.8 ms | 0–10 ms |

全部 4,717 個 blob、50,763,999 bytes（manifest 另計）一次上傳：12.7 s wall、13.0 s process CPU、RSS 峰值 +550 MB（1 次）。這是 4,717 個請求的瞬時峰值，不是常駐。

## 上傳量與儲存

- put 數 4,718（4,717 個 key 加 `c-manifest`），約每日 100k rows written 的 4.7%。
- value 50,764,147 bytes（含 manifest），key 184,391 bytes，合計 50.95 MB。
- 明細：關鍵字 15.87 MB、`keywords_logs` 15.03 MB、群組 14.09 MB、使用者 5.77 MB。
- 單一 key 最大 1,300,000 bytes，低於 8 MB 上限。

## 重跑

```bash
cd workers
npm run blobs -- --sqlite ~/linebot-import/line-snapshot-20261121.db --out /tmp/c-blob-build-current
C_BLOB_DIR=/tmp/c-blob-build-current C_SNAPSHOT=~/linebot-import/line-snapshot-20261121.db npm run bench:c
C_BLOB_DIR=/tmp/c-blob-build-current npm run bench:local
```

結果只印列數、位元組和時間，不印訊息、名稱、關鍵字或 id。

# Option C v4.1：phase timing + 冷啟動/長訊息（2026-11-22 深夜）

這一輪在 v4 的 lazy row chunk 上加入 `PHASE_TIMING=1` 分段計時，並把冷啟動的 meta/delta meta 與 row chunk 讀取合併成 multi-get、快取同一訊息的 anchor 命中、長訊息只解碼可能命中的列。格式仍是 version 4，舊 gen 1 / v3 的 key 不再讀取。

## 格式

- 10 個 key：`keyword-cache-meta`（JSON，361 bytes）、`keyword-aho-1-0`（1,292,596 bytes）、`keyword-rows-1-0..7`。
- row chunk 8 塊，合計 14,784,930 bytes，最大 1,987,892 bytes。單一 key 仍低於 8 MB。
- row chunk 內容是自己可解碼的 v4 格式：header、依 anchor hash 排序的 group、keyword hash 索引、pool、每列含全域 ordinal 的 rowMeta、UTF-16 字元池。
- 冷啟動固定 2 個 `get`：meta 與 delta meta 用一次 multi-get，automaton 再一次。沒有命中就不讀 row chunk；命中時只讀該 anchor 的 chunk（一次 multi-get），同一個 chunk 只讀一次，之後留在記憶體。
- overlay 套在 lazy base 上。delta 只在套用到的 anchor 上載入 chunk；compaction 時先分批載入全部 chunk，再分批掃描、配置、填入與排序，最後一次換 meta。
- `emptyAnchor` 記在 meta。沒有空 anchor 的語料，空字串命中不會載入任何 chunk。

## 冷啟動與長訊息

`npm run bench:c`（miniflare、真實 blob）：

| 項目 | 數字 |
|---|---|
| 冷啟動 keyword blob | 10 個 key，16,077,526 bytes（meta 361 bytes 另計）；每輪 2 個 `get`（meta、aho） |
| 冷啟動 decode | 0 ms（automaton 零複製 view） |
| 冷啟動 request（decode 後） | 0–1 ms |
| 5000 字，真實語料，1591 候選 | scan 1 ms、fetch 2 ms、match 1 ms |
| 同一則暖路徑 | p50 3 ms、p95 4 ms、max 4 ms |
| 同一則冷路徑 | p50 17 ms、p95 21 ms、max 22 ms（要載入全部 8 個 row chunk） |
| compaction 單段 | 280–293 段，最大 3 ms（偶發 13 ms wall 尖峰） |

`bench/probe.bench.ts`（合成 50,929 列、24,711 anchor、3452 候選）：

| 訊息 | 熱 p50 | 熱 p95 | 熱 max | 冷 request p95 |
|---|---|---|---|---|
| 5000 字，常用字頻率 | 4 ms | 5 ms | 6 ms | 10 ms |
| 5000 字，均勻 CJK | 1 ms | 1 ms | 1 ms | 5 ms |
| 24 / 300 / 1000 字 | 0 ms | 0–1 ms | 1 ms | 2 ms |
| at-cap（32 pending）冷 | 5 ms | 5 ms | — | 8 ms |

`npm run bench:local`（`wrangler dev --local`，重啟 workerd，3 次）：

| 項目 | v4 | 舊版（v3） |
|---|---|---|
| 冷啟動第一則私訊 wall | 15.1–18.3 ms | 43.9–48.1 ms |
| 冷啟動 process CPU | 20 ms（10 ms 解析度） | 50–60 ms |
| 冷啟動 RSS 增量 | +8.0–12.4 MB | +42.8–44.0 MB |
| 暖路徑 wall | 4.5–4.7 ms | 6.1–6.5 ms |
| 5000 字第一則 wall | 30.6–31.8 ms | 未量 |
| 5000 字暖路徑 wall | 6.9–8.5 ms | 未量 |
| 5000 字暖路徑 process CPU | 10–20 ms（10 ms 解析度） | 未量 |

## Phase timing

`PHASE_TIMING=1` 時，DO 會在每個操作結束時印一行 `phase {json}`。只有固定的 phase 名稱、毫秒數與計數，沒有訊息、id、關鍵字或回覆。預設是 `0`。

| phase | 本機樣本 |
|---|---|
| `startup` constructor / migrate | 0 ms / 0–1 ms；模組初始化在 workerd 的 `Date.now()` 下不可觀測 |
| `cacheLoad` coldGet / ahoChunkGet / ahoDecode | 2–3 ms / 1–2 ms / 0 ms（aho 1,292,596 bytes） |
| 冷啟動短訊息 `callback.total` | 9–12 ms |
| 冷啟動短訊息 `keywordMatches` | cache 3–5 ms；chunkGet 2–3 ms；rows 0 ms |
| 冷啟動 5000 字 `callback.total` | 27 ms |
| 冷啟動 5000 字 chunk multi-get | 18–19 ms（7 chunks、12,886,360 bytes）；decode 0 ms；match 1 ms |
| 暖 5000 字 `callback.total` | 3–4 ms；rowsGet 2–3 ms；match 0–1 ms |
| 暖 5000 字 probe | 2 次 probe；第一次 rows 1–2 ms、第二次 0–1 ms；hits cache 命中；candidates 1591、matched 467 |

分段點放在 storage 與網路 I/O 的邊界。Cloudflare 的 `Date.now()` 在同步 CPU 期間不會前進，所以這些 span 是 wall/I/O 邊界，不是純 CPU；真正的 CPU 要看 `wrangler tail` 的 `cpuTime`。本機 `wrangler dev` 的模組初始化在 `Date.now()` 下不可觀測。

重跑：

```bash
C_PHASE=1 C_ROUNDS=1 npm run bench:local
```

要量 Cloudflare，部署時把 `PHASE_TIMING` 設成 `"1"`，送短訊息、暖長訊息、冷長訊息，再用 `wrangler tail` 讀 `phase` 行。量完把 `PHASE_TIMING` 設回 `"0"`。

## 上傳

- 新 build：4,712 個 blob key、50,968,114 bytes；build 的 puts 是 4,713（含 `c-manifest`）。4,703 個非關鍵字 key 內容不變，只有 `c-manifest` 變。
- 舊 build 有 15 個關鍵字 key，新 build 有 10 個；新舊 key 名稱完全不同。
- 只重傳有變動的 key：10 個新關鍵字 key 加 `c-manifest`，共 11 個 put（約每日 100k 寫入的 0.011%）。
- 全量上傳：4,713 個 put（含 `c-manifest`；`bench:local` 不含 manifest 是 4,712）、12.6 s wall、13.0 s process CPU、RSS 峰值 +560 MB。這是 4,712 個請求的瞬時峰值，不是常駐。
- 舊的 15 個 gen 1 key 沒有刪除端點，會留在 DO storage（約 15.9 MB）。可接受就留著，要清需另開管理路徑。

## 限制

- workerd 沒有 isolate CPU；process CPU 解析度 10 ms，10–30 ms 只能說「約 1–3 個 tick」。冷啟動 decode 本身在 c-measure 是 0 ms。
- 冷啟動的 JS 分段（migrate 加 callback，cacheLoad 在 callback 內）合計約 9–13 ms，其餘是 Worker/DO isolate 啟動與模組初始化；這部分在本機的 `Date.now()` 不可觀測，需用 Cloudflare `cpuTime` 對照。
- 冷啟動後第一則若是 5000 字且命中大量 anchor，會讀完全部 8 個 row chunk（14.8 MB），`bench:c` 的冷長訊息 p95 是 21 ms。這是 lazy chunk 的資料量下限，不是 probe 的成本；暖長訊息 p95 4 ms（c-measure 的 select 路徑），完整 callback 是 6.9–8.5 ms（bench:local）。
- `listKeywords`、`inspectKeywords` 冷啟動會載入全部 chunk；scoped list 冷路徑約 24–27 ms wall。
- 暖 miss 的 9–18 ms 尖峰在本機沒有重現；`PHASE_TIMING` 會把 `touch.sql`、`refresh`、`cacheLoad`、`alarm`、`callback.total` 分開，CF 上可直接看是哪一段。
- `bench:local` 的長訊息已加固定 rng，回覆才會完成；舊表的 10.6–12.4 ms 可能是 DO 端在 `rng script missing choice` 失敗後的 process CPU，不是有效回覆（推測）。
- `bench:c` 的 request 是 wall；10 ms 以下的差異受 miniflare 排程影響。`bench:local` 的 CPU 是整個 process。

## 重跑

```bash
cd workers
npm run blobs -- --sqlite ~/linebot-import/line-snapshot-20261121.db --out /tmp/c-blob-build-v4
C_BLOB_DIR=/tmp/c-blob-build-v4 npm run bench:c
C_BLOB_DIR=/tmp/c-blob-build-v4 npm run bench:local
npm run bench
```

結果只印列數、位元組和時間，不印訊息、名稱、關鍵字或 id。


# Option C v5：row chunk 64 塊（2026-11-22）

這一輪把關鍵字 row chunk 從 8 塊切成 64 塊，冷啟動短訊息只讀命中 anchor 的那一塊，不再讀 1.9 MB。格式仍是 version 4，meta 的 `rowChunks` 改成 64。

## 格式

- 66 個 key：`keyword-cache-meta`、`keyword-aho-1-0`（1,292,596 bytes，內容和 v4 相同）、`keyword-rows-1-0..63`。
- row chunk 合計 14,786,050 bytes。最小 159,642、中位數 220,544、平均 231,032、最大 511,046 bytes。
- 比 v4 多 1,120 bytes，是 56 個 20-byte header。
- 重切驗證：50,929 列、50,929 個 ordinal、keyword hash 集合、anchor 分組大小都和 v4 相同。
- `keywordChunk` 依 meta 的 chunk 數取 anchor hash 高位。舊的 8 塊 meta 用 3 bits 讀，新的 64 塊用 6 bits 讀，升級不用清 cache。
- key 數 66，低於 `KEYWORD_BLOB_KEY_LIMIT` 128。allowlist 不用改。
- 讀取時一次 multi-get 讀完缺少的 chunk（最多 64 個 key，低於 128 上限）。冷啟動短訊息只有 1 塊，仍是 1 次 get。

## 冷啟動與長訊息

`npm run bench:local`，同一份程式，只換 `C_BLOB_DIR`，每個設定 10 次 workerd 重啟（ABBA 兩輪，每輪 5 次）：

| 項目 | 8 塊 v4 blob | 64 塊 v5 blob |
|---|---|---|
| 冷啟動短訊息 wall | 14.2–19.7 ms | 11.2–15.2 ms |
| 冷啟動短訊息 CPU（10 ms 解析度） | 10–30 ms | 0–20 ms |
| 冷啟動短訊息 RSS | +7.1–14.7 MB | +4.5–7.1 MB |
| 冷啟動短訊息讀取 | 1 塊 1,898,570 bytes | 1 塊 198,858 bytes |
| 暖短訊息 wall | 4.1–5.7 ms | 4.2–6.5 ms |
| 冷 5000 字 wall | 29.7–33.3 ms | 38.9–41.6 ms |
| 冷 5000 字讀取 | 7 塊 12,886,360 bytes | 63 塊 14,587,192 bytes |
| 暖 5000 字 wall | 6.4–7.8 ms | 6.5–7.6 ms |

`chunkBytes` 是該次實際讀到的 bytes，不是檔案大小。短訊息只命中一個 anchor，落在哪一塊會決定單塊大小。

`npm run bench:c`（miniflare、真實 blob、每次 3 輪，各跑 2 次）：

| 項目 | 8 塊 | 64 塊 |
|---|---|---|
| 冷啟動 keyword key | 10 個、16,077,526 bytes | 66 個、16,078,646 bytes |
| 每輪冷啟動 get | 2 | 2 |
| 5000 字暖 p50 / p95 | 2–3 / 3–4 ms | 2 / 3 ms |
| 5000 字冷 p50 | 18–19 ms | 22–23 ms |
| 5000 字冷 p95 | 22 ms | 26–27 ms |
| 5000 字冷 max | 24–26 ms | 28–29 ms |

## Compaction

`npm run bench`（合成 50,929 列、24,711 anchor）4 次：

| 項目 | 8 塊 | 64 塊 |
|---|---|---|
| compaction 段數 | 280–293 | 325–364 |
| 單段 max | 3 ms | 2.00 ms |

64 塊把一次 compaction 拆成更多段，每段更小。單段 max 2 ms，低於 10 ms 目標。合成 5000 字的冷 request p95（RENDER 與 COLD）是 10–13 ms。`probe.bench.ts` 的兩個冷 wall 門檻由 12 調到 15，反應 64 塊多出的 1–2 ms。

## 建置與 key 變動

- 新 build 在 `/tmp/c-blob-build-v5`，4,769 個 put（含 `c-manifest`），keywordKeys 66、keywordBytes 16,078,646。
- 和 v4 比：`keyword-aho-1-0` 內容相同；9 個 key 內容改變（meta 加 rows 0–7）；56 個新 key（rows 8–63）；0 個 key 移除。
- 只重傳變動的 key 是 66 個 put（65 個 keyword key 加 `c-manifest`）。
- 沒有孤兒 key 要刪。rows 0–7 同名覆寫，rows 8–63 新增，KV 端沒有舊 key 需要刪除端點。
- 部署順序：先上讀取端（能依 meta 讀 8 或 64 塊），再匯入 v5 blob。舊版程式讀到 64 塊的 meta 只會找 0–7 塊，會漏關鍵字。匯入期間 rows 0–7 會先被覆寫，meta 最後才翻，有即時流量時會有一個短暫漏字窗口。這次沒有 deploy，也沒有匯入 Cloudflare。

## 預載

`npm run bench:local` 加 `C_PHASE=1`、3 輪。冷啟動第一個請求後排一個 +50 ms alarm，每個 alarm 載 2 塊，直到 64 塊都載完。第一個請求本身仍同步載入命中的 1 塊。

| 項目 | 數值 |
|---|---|
| alarm 段數（每輪） | 32 |
| 每段 prefetch wall | 中位數 2 ms、max 5 ms |
| 每段 prefetch 塊數 | 2（最後一段 1） |
| 每段 prefetch bytes | 中位數 453,524、max 700,912 |
| 每輪預載總量 | 63 塊、14,587,192 bytes |
| 冷啟動取樣窗 process CPU（10 ms 解析度） | 190–200 ms，含 500 ms settle 內的 32 段 alarm |
| 冷啟動取樣窗 RSS | +28.2–33.1 MB |

預載完成後，同一輪的暖短訊息和 5000 字訊息 `chunksMissing` 都是 0。冷 5000 字 wall 從 38.9–41.6 ms 降到 10.3–11.9 ms，因為 500 ms 的 settle 足夠跑完 32 段；若長訊息在第一則後 50 ms 內到達，仍要同步載入缺塊。暖短訊息 wall 是 5.2–5.7 ms。冷啟動短訊息 wall 是 15.2–19.7 ms（上一輪 11.2–15.2 ms）；這一輪沒有單獨拆 `getAlarm`/`setAlarm` 的成本，差距含排程噪聲。

## 限制

- 冷啟動會預載全部 64 塊，RSS 多 28–33 MB，process CPU 在 32 段 alarm 內約 190–200 ms。要先確認 DO 記憶體與 CPU 預算可以接受，再開預載。
- 預載完成前，冷 5000 字仍會變慢。320 個命中 anchor 落在 63/64 個分區，讀到 63 塊共 14.59 MB；v4 讀 7/8 塊共 12.89 MB。本機 wall 從 29.7–33.3 ms 升到 38.9–41.6 ms。
- 冷長訊息要一次讀 64 塊。一次 multi-get 的冷 5000 字是 45–49 ms；先前每批 16 個 key 併發 4 次是 39–42 ms。CI 在併發版本掉過一次 chunk value（`keyword row chunk was missing`），本機重跑沒再現，已退回單次 get，短訊息不受影響。
- `listKeywords`、`inspectKeywords` 冷啟動仍會載入全部 64 塊，沒有另外量。
- 非 2 的次方的 `rowChunks` 會被 meta 驗證拒絕，當成沒有 cache。

## 重跑

```bash
cd workers
npm run blobs -- --sqlite ~/linebot-import/line-snapshot-20261121.db --out /tmp/c-blob-build-v5
C_BLOB_DIR=/tmp/c-blob-build-v5 npm run bench:c
C_BLOB_DIR=/tmp/c-blob-build-v5 npm run bench:local
npm run bench
```

結果只印列數、位元組和時間，不印訊息、名稱、關鍵字或 id。
