# Fixture replay

184/184。`workers/test/fixtures.test.ts` 依 `fixtures/suite.json` 順序重放簽章請求，比對 HTTP status、body、LINE reply/push、以及有列出的 keywords/settings/counts。合併 #55 之後，關鍵字讀取走列快取的 `keywordRows`，寫入仍走 `upsertKeyword` 與 `deleteKeyword`。

失敗分類：沒有。兩個 Python 舊行為都在通過的步驟裡，不是失敗。

`user_settings` 的 `options` 為 `{}` 的列在比對前拿掉。Python 的 `UserSettings._get` 讀取就會插入空列，ADR-0001 與 #47 規定 TypeScript 讀取不建空列、匯入也跳過。回覆文字沒有因此改變。

- 第一次在群組學習的回覆是 `None 新增`。顯示名稱在組回覆之後才查。
- `設定=全圖片` 的說明寫「需要開啟全圖片」，選單與比對實際看的是全回應。
