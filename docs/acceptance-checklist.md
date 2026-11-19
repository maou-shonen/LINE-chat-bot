# Workers 切換前驗收清單

勾選代表該項已在測試 channel 上驗過。這份清單不執行正式 webhook 切換。

行為以 Python 原始碼 `app/` 與 `fixtures/suite.json` 為準。

## 功能

測試 channel 必須是另開的 channel，不是正式 channel。

- [ ] 新增關鍵字（`-a`、`add`、`keyword`、`新增`、`學習`、`關鍵字`）
- [ ] 刪除關鍵字（`-d`、`delete`、`del`、`刪除`、`移除`）
- [ ] 查詢關鍵字（`-l`、`list`、`列表`，含 `我`）
- [ ] 關鍵字疊加
- [ ] 關鍵字命中與優先順序
- [ ] 學習
- [ ] 全回應（預設開。關閉後不反映到其他人的關鍵字）
- [ ] 抽卡（權重、多發、保底、種子、百分比）
- [ ] 設定（`別理我`、`全回應`、`全圖片`、`髒話過濾`）
- [ ] 睡眠與起床（`愛醬睡覺` 一類、`愛醬起床` 一類。省略時間時預設 6 小時）
- [ ] 圖片回覆
- [ ] `follow`
- [ ] `join`
- [ ] `leave`

## Fixtures

- [ ] `fixtures/suite.json` 184 則全部通過（184/184）

## CPU

目標是單次呼叫低於 10 ms。量測方式寫在記錄裡（probe 長度、抽數、是否冷啟動）。

- [ ] anchor probe，短訊息
- [ ] anchor probe，約 300 字
- [ ] anchor probe，更長的訊息（記錄實際長度）
- [ ] 一萬抽
- [ ] 冷啟動 p95 < 10 ms

## 免費額度

對照 `docs/staging.md` 的額度表。估算與實測都要留下數字。

- [ ] Workers 請求
- [ ] Durable Objects 請求
- [ ] rows read
- [ ] rows written
- [ ] DO duration（GB-s）
- [ ] 儲存

## 資料匯入

- [ ] dry-run 列出將寫入的列數
- [ ] 分批天數已算出（每日寫入扣掉日常用量後，上限 80,000 列）
- [ ] 匯入後抽樣比對，抽樣列與來源一致
- [ ] `options` 為空物件的列沒有匯入
- [ ] 空列沒有匯入

## 安全

- [ ] secret 與 token 不在 git
- [ ] 日誌沒有 request URL（`invocation_logs` 為 false）
- [ ] 未設定 `IMPORT_SECRET` 時，匯入端點回 404

## 切換前條件

切換不在這份清單的執行範圍。條件沒勾完就不改正式 webhook。

- [ ] 你同時在線
- [ ] 你親口確認可以切

回切草稿：

1. 把正式 LINE webhook 改回 NAS。
2. 確認 NAS 有回覆之後，再處理 Workers 側。不要先拆 NAS。

## 已知差異

這兩項維持 Python 現行行為，不當失敗。

- [ ] 已記錄。第一次在群組學習時，回覆可能是「None 新增」。顯示名稱在組回覆之後才查。
- [ ] 已記錄。「設定=全圖片」的說明文字與實際行為不一致。
- [ ] 已記錄。`keywords_logs` 保留。
