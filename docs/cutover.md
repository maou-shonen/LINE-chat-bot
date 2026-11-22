# 切換到 Cloudflare Workers：驗證、切換、回滾

這份是 NAS（Python）切到 Workers 的操作手冊。**切 webhook 或 DNS 必須使用者同時在線，並且當下明確說「切」**，即使之前說過「正常就直接切換」也一樣。建議在半夜進行（台北 02:00–05:00，訊息量最低）。

## 目前狀態（option C）

- Worker：`line-chat-bot`，網址 `https://line-chat-bot.shonen.workers.dev`。沒有 route，也沒綁 `linebot.maou.app`。
- 物件：`/callback` 與 `/import/kv`、`/export` 都打 `global-c`。舊的 `global` 不刪、不讀。
- 資料：冷資料和關鍵字基底是 KV blob，由離線工具建置後用 `/import/kv` 上傳。熱 SQL 只在事件第一次碰到群組或使用者時，從 blob hydrate。
- 舊的逐列 `POST /import` 與 `npm run import` 已移除。
- Secret：`IMPORT_SECRET`、`GOOGLE_SAFE_BROWSING_KEY`、`IMGUR_CLIENT_ID`、`DEVELOPER_USER_ID`、`DEVELOPER_BOT_TOKEN`。LINE channel secret 和 access token **不是** Worker secret，只存在 LINE console 的 webhook URL 裡。
- 匯入流程見 [import.md](import.md)。

## 0. 切換前的必要條件

- [ ] 快照 blob 已建置並上傳完成；`/healthz` 回 `ok`。
- [ ] 用 workers.dev 跑過一輪模擬 webhook：假 secret／token／replyToken、假群組 id。GraphQL 的 errors 為 0，CPU p99 小於 10 ms。
- [ ] 在測試群組驗證 hydrate：第一次訊息後，該群組與成員出現在 SQL，回覆正確。
- [ ] 回滾工具已測過：`npm run backfill` 能匯出熱表與 overlay，套到一份 fixture SQLite，重跑結果相同。
- [ ] 尚未移植的行為已確認可接受，或已補上：
  - Python 的 `回報` 會 `_count({"觸發": 1})`，Workers 沒有。
  - Python 發生例外時會 `push_developer("<愛醬BUG>…")` 並回覆群組，Workers 只記一筆 error log。
- [ ] Cloudflare 免費額度：一天 100,000 rows written。日常約 8,000，hydrate 的一次性寫入分散在多天。
- [ ] 使用者同意切換，且切換當下在線。

## 1. 切換前最後檢查

1. 重跑離線 build 與上傳（見 [import.md](import.md)）。同一個 key 會覆寫，重跑安全。
2. 在 workers.dev 用模擬 webhook 打幾個群組、使用者、關鍵字，確認：
   - 回覆和 Python 版相同。
   - `GET /export` 的 `user`、`group`、`group_user`、`user_settings`、`user_keyword`、`keywords_logs`、`keyword_tombstone` 有預期列數。
3. 記下 LINE console 目前的 webhook URL，回滾要用。

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

- GraphQL `workersInvocationsAdaptive`：requests 上升、errors 為 0。
- `durableObjectsInvocationsAdaptiveGroups`：status 為 success。
- telemetry 的 error 事件：特別看 `Exceeded allowed rows written`。
- NAS 容器的 log 應該不再有新的 callback。

## 3. 切換後

- NAS 容器先**不要停**，保持可回滾。觀察至少 7 天。
- 舊的匯入排程不要恢復。
- 熱 SQL 會隨實際使用慢慢長大；沒被碰到的群組和使用者仍只在 KV blob。

## 4. 回滾（回到 NAS，並把 Workers 期間的寫入同步回去）

1. 使用者在線確認後，依第 2 節反向操作：A 把 webhook URL 改回 `https://linebot.maou.app/...`；B 移除 custom domain、還原 tunnel 路由。
2. **先讓 NAS 暫停寫入**（停容器或停 webhook 處理幾秒），避免 backfill 和 NAS 同時改同一列。
3. 備份 NAS 的 `/data/line.db`。
4. 在 shonen-lab 執行：

   ```bash
   cd workers
   IMPORT_SECRET="$(cat /dev/stdin)" npm run backfill -- \
     --endpoint https://<worker-host>/export \
     --sqlite /path/to/line.db
   ```

   - `--endpoint` 只接受 `/export`，且只接受 https 或 localhost 的 http。
   - 讀取分頁，每頁 200 列；整份套用在單一 transaction，失敗會 rollback。
   - 重跑安全：`user`、`group` 以 `id` upsert；`group_user`、`user_settings` 以 `(gid, uid)`、`(group_id, user_id)` upsert；`user_keyword` 以 `(id, keyword)` upsert；`keywords_logs` 以 `_id` 插入；`keyword_tombstone` 執行 delete。
   - 輸出的只有每表列數，不含訊息或關鍵字內容。

5. 確認 NAS 的表格列數與抽查內容後，再恢復 NAS 寫入。
6. 比對幾個關鍵表：`user`、`group`、`group_user`、`user_settings`、`user_keyword`、`keywords_logs`。

### 匯出範圍

- 熱 SQL：`user`、`group`、`group_user`、`user_settings`、`user_keyword`、`keywords_logs`。
- 關鍵字 tombstone：`keyword_tombstone`，代表切換後刪掉的基底關鍵字。
- 不含 `cold_group`、`cold_user`、`cold_omit`，也不讀 KV blob 或 `keywords_logs` 歷史 blob。
- hydrate 進來的历史列也會被 upsert 一次；值本來就和 NAS 相同，重跑無害。`name`、`create_on`、`update_on` 為 NULL 時不會蓋掉 NAS 既有的值。
- 讀取量等於匯出的列數。以近一年活躍量估算（約 80 個群組、2,600 筆成員、830 位使用者、少量設定與關鍵字變更）約 **4,000 列**，遠低於每日 5M rows read。

## 5. 已知風險

- 回滾要在 NAS 停止寫入時套用，否則兩邊會互相覆蓋。
- `keyword_tombstone` 只反映切換後的刪除。切換前的刪除已經在 blob 建置時反映，不會出現在這裡。
- 基底關鍵字的 `author` 已存進 blob，`##保護` 的修改權限和 Python 相同。若 blob 是舊格式（沒有 author），需要重 build 再上傳。
- 熱 SQL 只包含被碰到過的群組與使用者。回滾後，未被碰到的資料仍以 NAS 原資料為準。
