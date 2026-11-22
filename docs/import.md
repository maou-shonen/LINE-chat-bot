# Option C：冷資料 blob 的建置與匯入

Worker 的 `global-c` 物件只放熱資料（SQL）和關鍵字 overlay。群組、使用者、關鍵字基底、`keywords_logs` 歷史離線打包成 KV blob，用 `/import/kv` 上傳。舊的逐列 `POST /import` 與 `npm run import` 已移除。

## 前置

`IMPORT_SECRET` 只存在 Worker secret。不要寫進 git、`wrangler.jsonc` 或 URL；沒有設定時 `/import/kv` 和 `/export` 都回 404。

```bash
cd workers
npx wrangler secret put IMPORT_SECRET
```

## 1. 離線建置

快照只唯讀開啟，輸出目錄必須在 repo 外。stdout 只有列數和位元組，不含任何訊息、名稱、關鍵字或 id。

```bash
cd workers
npm run blobs -- \
  --sqlite ~/linebot-import/line-snapshot-20261121.db \
  --out /tmp/c-blob-build
```

產出的 key：

- `keyword-cache-meta`、`keyword-aho-<gen>-<n>`、`keyword-rows-<gen>-<n>`：關鍵字基底。meta 記 chunk 數與位元組數，row chunk 64 塊、每塊約 230 KB，aho 1 塊，合計 66 個 key。row blob 帶 `author`，`##保護` 行為和 SQL 版一致。
- `c-group:{gid}`：每個群組一個 key，含 group 列、成員（名字、計數）、群組設定。沒有 group 列的 gid 也會有，`group` 為 null。
- `c-user:00`–`ff`：全部 user 列和私訊設定，256 塊。
- `c-logs:0`–：`keywords_logs` 歷史，每塊約 1 MB，最多 16 塊。
- `c-manifest`：各表筆數。

## 2. 上傳

secret 從環境變數讀，不會出現在參數或終端輸出。

```bash
cd workers
IMPORT_SECRET="$(cat /dev/stdin)" npm run blobs -- \
  --sqlite ~/linebot-import/line-snapshot-20261121.db \
  --out /tmp/c-blob-build \
  --upload https://<worker-host>/import/kv
```

- `--upload` 只接受 `/import/kv`，且只接受 https 或 localhost 的 http。
- 每個 key 送一次 `POST /import/kv`。同一個 key 重送會覆寫，重跑安全。
- 一次上傳約 4,700 個 key，也就是 4,700 rows written 左右，不到每日額度的 5%。
- 上傳後 `global-c` 的關鍵字基底、群組、使用者、歷史就緒，但 SQL 仍是空的。

## 3. 驗證（workers.dev）

1. `GET /healthz` 回 `ok`。
2. 用假的 secret／token／replyToken 與假群組 id 打 `/callback/{secret}/{token}`，確認回 200。
3. 觀察 GraphQL `workersInvocationsAdaptive` 與 `durableObjectsInvocationsAdaptiveGroups`：errors 為 0，CPU p99 小於 10 ms。
4. 在測試群組說一個已匯入的關鍵字，確認回覆正確，而且群組、成員、設定真的被 hydrate 進 SQL。
5. 需要時用 `/export` 唯讀檢查熱表；它受 `IMPORT_SECRET` 保護，輸出只經程式套用，不印內容。

## 4. 切換

見 [cutover.md](cutover.md)。切 webhook 必須使用者在線並親口確認。

## 5. 回滾

切回 NAS 後，用縮小版 backfill 把 `global-c` 的熱表和關鍵字 overlay 寫回 NAS SQLite：

```bash
cd workers
IMPORT_SECRET="$(cat /dev/stdin)" npm run backfill -- \
  --endpoint https://<worker-host>/export \
  --sqlite /path/to/line.db
```

工具在同一個 transaction 內 upsert，重跑安全；`keyword_tombstone` 會刪除 NAS 上的關鍵字，`group_user_tombstone` 會刪除 NAS 上對應的 `group_user` 列（`uid = ''` 代表整個群組的成員列）。細節與風險見 [cutover.md](cutover.md) 第 4 節。
