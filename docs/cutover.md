# 切換到 Cloudflare Workers：差異回填、切換、回滾

這份是 NAS（Python）切到 Workers 的操作手冊。**切 webhook 或 DNS 必須使用者同時在線，並且當下明確說「切」**，即使之前說過「正常就直接切換」也一樣。建議在半夜進行（台北 02:00–05:00，訊息量最低）。

## 目前狀態（2026-11-22）

- Worker：`line-chat-bot`，網址 `https://line-chat-bot.shonen.workers.dev`。帳號 maou.app（`c6da325399bfa8210d6994c51555c61c`）。沒有 route，也沒綁 `linebot.maou.app`。
- Secret：`IMPORT_SECRET`、`GOOGLE_SAFE_BROWSING_KEY`、`IMGUR_CLIENT_ID`、`DEVELOPER_USER_ID`、`DEVELOPER_BOT_TOKEN`。後四個從 NAS `.env` 用管線送入。LINE channel secret 和 access token **不是** Worker secret。它們在 webhook 路徑 `/callback/{secret}/{token}` 裡，NAS `.env` 也沒有，只存在 LINE console 的 webhook URL 中。
- 匯入：快照 `shonen-lab:~/linebot-import/line-snapshot-20261121.db`（2026-11-21 23:38 台北，SQLite backup API 唯讀取得，integrity ok）。每天跑一次 `~/linebot-import/run-import.sh`，見 [import.md](import.md)。

## 0. 切換前的必要條件（全部打勾才可以排切換）

- [ ] 匯入完成：`run-import.sh` 的 log 出現 `done`，且 checkpoint 的每個 offset 都等於 counts。
- [ ] 差異回填工具已完成並測過（下面第 1 節）。現在的 `/import` 是純 `INSERT`，不能更新或刪除既有列，所以不能直接拿來回填差異。
- [ ] 回滾用的匯出工具已完成並測過（下面第 4 節）。DO 目前沒有匯出端點。
- [ ] 尚未移植的行為已確認可接受，或已補上：
  - Python 的 `回報` 會 `_count({"觸發": 1})`，Workers 沒有。
  - Python 發生例外時會 `push_developer("<愛醬BUG>…")` 並回覆群組，Workers 只記一筆 error log。
- [ ] Cloudflare 免費額度：一天 100,000 rows written。日常約 7,800。**匯入期間的寫入和切換後的正式流量會共用同一份額度**，所以匯入沒跑完不要切換。
- [ ] 用 workers.dev 跑過一輪模擬 webhook：假 secret／token／replyToken、假群組 id。觀察 GraphQL 的 `workersInvocationsAdaptive` 與 `durableObjectsInvocationsAdaptiveGroups`：errors 為 0，CPU p99 小於 10ms。

## 1. 差異回填（快照之後 NAS 新增或修改的資料）

匯入用的是 2026-11-21 的快照。之後 NAS 繼續寫入：新的關鍵字、設定、計數、`keywords_logs`。

切換當晚的流程：

1. **T-30 分**：再從 NAS 取一份快照 S2，方法和第一份相同（`docker exec line-chat-bot` 內用 `sqlite3.backup`，來源 `mode=ro`，複製到容器的 `/tmp`，用管線傳到 shonen-lab，再刪掉容器內的暫存檔）。
2. 計算 S1→S2 的差異，以主鍵比對：
   - `user_keyword`：以 `(id, keyword)` 比對，涵蓋新增、`reply` 或 `anchor` 變更、刪除。`id` 為 NULL 的列以 `keyword` 比對。
   - `user_settings`：以 `(group_id, user_id)` 比對，空的 options 照樣略過。
   - `group`、`user`：以 `id` 比對整列。`group_user`：以 `(gid, uid)` 比對。
   - `keywords_logs`：只會追加，取 S1 最大 `_id` 之後的列。
3. 用回填工具送進 DO：upsert 或 delete。關鍵字的變更必須走 repository 的關鍵字寫入路徑（會更新 probe cache），不能直接改表。
4. **切換**（第 2 節）。
5. **T+5 分**：再取一份快照 S3，回填 S2→S3。這是切換前最後幾分鐘的資料。之後 NAS 不會再收到 webhook，差異應該接近 0。

回填量估算：一週約幾千列，遠低於每日額度。

## 2. 切 webhook（需使用者在線並確認）

兩種做法擇一。

**A. 改 LINE console 的 webhook URL（建議，回滾最快）**

1. 使用者登入 LINE Developers console，到該 channel 的 Messaging API 頁。
2. Webhook URL 從 `https://linebot.maou.app/callback/{secret}/{token}` 改成 `https://line-chat-bot.shonen.workers.dev/callback/{secret}/{token}`，`{secret}/{token}` 這段不變。
3. 按 Verify，應該回 200（簽章用路徑裡的 secret 驗）。
4. 在測試群組說一句已知的關鍵字，確認愛醬有回應。
5. 有多個 channel 就每個都做一次。

**B. 把 `linebot.maou.app` 改指到 Worker（所有 channel 一次切）**

1. 刪除或停用 `linebot.maou.app` 的 tunnel 路由／CNAME（cloudflared），並記下原值。
2. 在 `wrangler.jsonc` 加 `"routes": [{ "pattern": "linebot.maou.app", "custom_domain": true }]`，開 PR 合併後 `wrangler deploy`。
3. LINE console 不用改。按 Verify 檢查。

切完後盯 15 分鐘：

- GraphQL `workersInvocationsAdaptive`：line-chat-bot 的 requests 上升、errors 為 0。
- `durableObjectsInvocationsAdaptiveGroups`：status 為 success。
- telemetry 的 error 事件：特別看 `Exceeded allowed rows written`。
- NAS 容器的 log 應該不再有新的 callback。

## 3. 切換後

- NAS 容器先**不要停**，保持可回滾。觀察至少 7 天。
- `run-import.sh` 不要再排程。

## 4. 回滾（回到 NAS，並把 Workers 期間寫入的資料同步回去）

1. 使用者在線確認後，依第 2 節反向操作：A 把 webhook URL 改回 `https://linebot.maou.app/...`；B 移除 custom domain、還原 tunnel 路由。
2. 確認 NAS 開始收到 callback。
3. 從 DO 匯出切換之後寫入的資料。需要一個以 `IMPORT_SECRET` 保護的唯讀匯出端點，分頁讀取每個表（一天 5M rows read 綽綽有餘）。
4. 在 shonen-lab 產生 SQL 差異：DO 匯出 vs 切換時的 S3 快照。
5. 套回 NAS：先停 NAS 容器幾秒，或在容器內用單一 transaction 套用，套用前先備份 `/data/line.db`。這一步會改正式庫，需要使用者同意。
6. 比對幾個關鍵表的列數。

## 5. 已知風險

- 匯入是純 `INSERT`。正式流量如果先在 DO 建了某個 user／group 列，之後匯入同一個主鍵就會失敗，這也是匯入完才能切的原因之一。目前 DO 只有測試用的假 id（`U0000000000000000000000000cftest`、`C0000000000000000000000000cftest`），不會衝突。切換前可以留著，也可以刪掉。
- 關鍵字匯入每一列約多寫 1 列（delta 和壓縮 probe cache）。第 1 天實測 80,000 tool units 對應 100,532 rows，超過免費額度，當天 DO 之後的寫入全部失敗，直到 00:00 UTC 才恢復。`run-import.sh` 已經把匯入關鍵字那幾天的上限降到 64,000。
- 第 1 天剛好在額度邊界停下。下一次寫入時要確認 probe cache 的壓縮有完成：在 workers.dev 用模擬 webhook 打幾個已匯入的關鍵字，確認有命中。
- `preview_urls` 預設開啟。正式切換前可以在 `wrangler.jsonc` 設成 `false`。
