# 切換到 Cloudflare Workers：驗證、切換、回滾

這份是 NAS（Python）切到 Workers 的操作手冊。**切 webhook 或 DNS 必須使用者同時在線，並且當下明確說「切」**，即使之前說過「正常就直接切換」也一樣。建議在半夜進行（台北 02:00–05:00，訊息量最低）。

## 目前狀態（option C）

- Worker：`line-chat-bot`，網址 `https://line-chat-bot.shonen.workers.dev`。`workers/wrangler.jsonc` 已宣告 `linebot.maou.app` 的 custom domain，但尚未部署；部署就是切換（第 2 節 B）。
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
   - `POST /export` 的 `user`、`group`、`group_user`、`user_settings`、`user_keyword`、`keywords_logs`、`keyword_tombstone`、`group_user_tombstone` 有預期列數。
3. 記下 LINE console 目前的 webhook URL，回滾要用。

## 2. 切 webhook（需使用者在線並確認）

兩種做法擇一。

**A. 改 LINE console 的 webhook URL（建議，回滾最快）**

1. 使用者登入 LINE Developers console，到該 channel 的 Messaging API 頁。
2. Webhook URL 從 `https://linebot.maou.app/callback/{secret}/{token}` 改成 `https://line-chat-bot.shonen.workers.dev/callback/{secret}/{token}`，`{secret}/{token}` 這段不變。
3. 按 Verify，應該回 200（簽章用路徑裡的 secret 驗）。
4. 在測試群組說一句已知的關鍵字，確認愛醬有回應。
5. 有多個 channel 就每個都做一次。

**B. 把 `linebot.maou.app` 改指到 Worker（custom domain，所有 channel 一次切）**

順序：快照 → 同步 → 部署 → 驗證。

1. 建好快照 blob、上傳完成，`/healthz` 回 `ok`（第 0 節）。
2. 依 [import.md](import.md) 同步資料。
3. 合併 `feat/c-domain` 後，在 `workers/` 執行 `npx wrangler deploy --env=""`。部署就是切換：`workers/wrangler.jsonc` 頂層的 route 會把 `linebot.maou.app` 建成 Workers custom domain，並以 `override_existing_dns_record=true` 取代原本指向 tunnel 的 CNAME。部署前先記下現有 CNAME。
4. LINE console 不用改。按 Verify 檢查。
5. `/docs` 與 `/openapi.json` 不再提供（那是 FastAPI 的）。Worker 只服務 `/callback/*`、`/ping`、`/healthz`，以及帶 `IMPORT_SECRET` 的 `/import/kv`、`/export`。

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

1. 使用者在線確認後，依第 2 節反向操作。A：把 webhook URL 改回 `https://linebot.maou.app/...`。B：用 API 或 dashboard 刪除 `linebot.maou.app` 的 Workers custom domain，再建立 proxied CNAME 指回 tunnel。只從 `wrangler.jsonc` 刪掉 route 不會移除 domain，因為 wrangler 只在清單非空時發布 custom domain。tunnel 與 DNS record 的 id 不在 repo，見 runbook。
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
   - `--dry-run` 只讀 `/export`，印出每表會套用的列數後結束，不開也不寫 SQLite。
   - 預設略過 id 欄位以 `cftest` 結尾的列（workers.dev 量測腳本的假資料）。確定要匯入時才加 `--include-test-ids`。
   - 讀取分頁，每頁 200 列；整份套用在單一 transaction，失敗會 rollback。
   - 重跑安全：`user`、`group` 以 `id` upsert；`group_user`、`user_settings` 以 `(gid, uid)`、`(group_id, user_id)` upsert；`user_keyword` 以 `(id, keyword)` upsert；`keywords_logs` 以 `_id` 插入；`keyword_tombstone`、`group_user_tombstone` 執行 delete。
   - 輸出的只有每表列數與略過列數（`table=N skipped=M`），不含訊息或關鍵字內容。

5. 確認 NAS 的表格列數與抽查內容後，再恢復 NAS 寫入。
6. 比對幾個關鍵表：`user`、`group`、`group_user`、`user_settings`、`user_keyword`、`keywords_logs`。

### 匯出範圍

- 熱 SQL：`user`、`group`、`group_user`、`user_settings`、`user_keyword`、`keywords_logs`。
- 關鍵字 tombstone：`keyword_tombstone`，代表切換後刪掉的基底關鍵字。
- 群組成員 tombstone：`group_user_tombstone`，代表切換後刪掉的 `group_user` 列，套用時執行 delete（和 `keyword_tombstone` 一樣）。`uid = ''` 表示該群組全部成員被刪除；此時只刪 `group_user`，不刪 `"group"`、`user`、`user_settings` 或關鍵字，因為 Python 的 leave 路徑也不刪這些表。
- 不含 `cold_group`、`cold_user`、`cold_omit`，也不讀 KV blob 或 `keywords_logs` 歷史 blob。
- hydrate 進來的历史列也會被 upsert 一次；值本來就和 NAS 相同，重跑無害。`name`、`create_on`、`update_on` 為 NULL 時不會蓋掉 NAS 既有的值。
- 讀取量等於匯出的列數。以近一年活躍量估算（約 80 個群組、2,600 筆成員、830 位使用者、少量設定與關鍵字變更）約 **4,000 列**，遠低於每日 5M rows read。

## 5. 回滾後重切

回滾過一次後，`global-c` 的熱 SQL 可能比 NAS 新。要再切回 Workers 時，換一個新的 DO 名稱重新開始，不要沿用舊物件。

1. **（可選）先 backfill 回 NAS。** 若回滾後還要保留 Workers 期間的熱資料，依第 4 節把 `global-c` 的熱表寫回 NAS。先跑 `--dry-run` 確認列數；預設略過 `cftest` 測試列。這一步只改 NAS，不動 `global-c`。
2. **開小 PR 換名稱。** 把 `workers/src/blob-store.ts` 的 `COLD_BOT_STATE` 從 `"global-c"` 改成 `"global-d"`。`index.ts`、`bot-state.ts` 都匯入這個常數，其他程式不用改。合併後部署。
   - 新物件一開始是空的，沒有舊的熱 SQL、關鍵字 cache 或 blob。
   - 不清空 `global-c` 的原因：DO 沒有刪除整個物件的端點；逐列 `deleteAll()` 或 `DELETE` 都算 rows written，清掉半份資料約 10 萬列，會吃光當日 100,000 列額度。留著舊物件零寫入，還能查對照。
3. **重傳全部 blob。** 部署完成後，`/import/kv` 會寫進 `global-d`，再跑一次 [import.md](import.md) 第 2 節的建置與上傳。實測 4,718 個 key、value 50.76 MB、key 0.18 MB，約 4,800 rows written（不到每日額度的 5%）。上傳後檢查 `/healthz`、`/export` 各表列數，並用模擬 webhook 驗證 hydrate。
4. **最後才切 webhook。** 依第 2 節切換，切完盯 15 分鐘。
5. **舊物件留著不刪。** `global`、`global-c` 都保留。每一代冷 blob 約 50.95 MB（`global-c` 實測，其餘同量級估算）；熱 SQL 只算 hydrate 過的列，用整份 NAS SQLite 73.1 MB 當上限。三個世代合計約 372 MB，約 5 GB 帳號上限的 7%，也遠低於單一物件 10 GB 上限。需要查舊資料時，暫時把 `COLD_BOT_STATE` 指回舊名稱並重新部署即可；正式路徑只指向最新一代。

## 6. 已知風險

- 回滾要在 NAS 停止寫入時套用，否則兩邊會互相覆蓋。
- `keyword_tombstone` 只反映切換後的刪除。切換前的刪除已經在 blob 建置時反映，不會出現在這裡。
- 基底關鍵字的 `author` 已存進 blob，`##保護` 的修改權限和 Python 相同。若 blob 是舊格式（沒有 author），需要重 build 再上傳。
- 熱 SQL 只包含被碰到過的群組與使用者。回滾後，未被碰到的資料仍以 NAS 原資料為準。
