移植抽卡 DSL，並量測一萬抽

## Why

Workers 要對同一則選中的回覆，給出和 Python `EventText.later` 相同的文字。關鍵字比對是另一支 PR。這支只做一件事。給定選中的回覆字串和注入的亂數，得到最終回覆。

## What

`workers/src/gacha.ts` 的 `renderReply` 移植權重、`*N` 多發、保底、`##種子`、`##百分比`，以及 `||` 分段。亂數由呼叫端注入。抽數大於 1 時，向注入的 random.org 取整數。請求失敗、內文含 `Error`，或含 `<!DOCTYPE html>`，才改走 `uniform`。`*0` 當成 1 抽。超過 10000 抽夾成 10000。

兩選項的一萬抽，在 workerd 裡 p95 是 1.0 ms。數字、樣本數和瓶頸寫在 `workers/bench/GACHA_RESULTS.md`。

## Scope

這支分支從 `feat/workers-line-client` 疊上來。brief 寫的依賴是 #48 和 #50。請先 review 那兩支。base 是 master。

沒有接上 webhook，也沒有改關鍵字比對。沒有部署。沒有改 webhook、DNS、tunnel 或 NAS。

兩個舊行為不在這支 diff。第一次在群組學習時，顯示名稱是在組好回覆之後才查，所以回覆可能出現「None 新增」。`設定=全圖片` 的說明文字和實際開關不一致。那兩段分別在學習回覆和設定說明。這支 PR 沒有移植那兩個函式。

行為以 `app/handler.py` 的 `later` 和 `origin/test/baseline-fixtures` 的 `fixtures/suite.json` 為準。`##種子` 的單抽用 md5，不消耗 rng。多抽走 random.org。百分比模式在 `||` 分段之前回傳。重複的選項標籤，總權重仍把每一段都加進去，池子只留最後一段的權重。

## Verification

`npm run typecheck` 通過。`npm test` 通過。測試在 workerd 裡把抽卡步驟的最終文字對上 fixture。對照值來自直接呼叫 `EventText.later` 的結果。

## Self-review

`renderReply` 還沒有被 webhook 呼叫。關鍵字那支 PR 接上之前，線上不會跑到它。這是這支 PR 的範圍。

一萬抽的 p95 是 1.0 ms，樣本間距約 0.1 ms。10 ms 的門檻離這個數字夠遠，所以沒有為了速度改迴圈。計時器步進約 1 ms。單抽的數字只是上限。量測的是 vitest 的 workerd isolate，不是 minify 後的正式 bundle。

20 個選項、每一抽都走完整個池，p95 是 2.6 ms。更長的池這次沒有量。池子再長，時間會再增加。

Unicode 數字表對的是 Python 3.13 的 `isdigit` 和十進位數字。測試鎖了 ASCII、全形 `２`，以及會讓 `int` 失敗的 `²`。

註解留了三處。兩處是已知的數字上限。一處說明種子用本地 md5，因為 WebCrypto 沒有 MD5。重複標籤和百分比提早回傳改由測試鎖住，沒有再寫註解。沒有開另一個 agent 做註解審查，因為 brief 禁止啟動其他 agent。

這個模組沒有附 `Math.random` 包裝。下一個接上 handler 的人要自己提供 `Rng`。`uniform(low, high)` 應是 `low + (high - low) * Math.random()`。
