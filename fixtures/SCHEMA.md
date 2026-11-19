# Fixtures

`fixtures/suite.json` 是 Python 與 TypeScript 共用的行為契約。Python 測試只讀這份檔。不要再維護第二份手寫副本。

重錄產生的欄位是 `request`、`rng`、`expect`。人只改作者欄位，然後重錄。

```sh
REGEN_GOLDEN=1 uv run pytest tests/golden/test_golden.py -q
```

先讀 diff 再提交。平常的 pytest 重放 `rng`，不使用 `seed`。

## 執行順序

`steps` 依陣列順序跑在同一個空的 SQLite 上。後面的步驟看得到前面寫入的列。不要調換順序而不重錄。

新步驟加在尾端。新關鍵字用新的 group id。全回應會掃全部關鍵字。長訊息不要含現有萬用字元的片段，例如 `both`、`suf`，或開頭 `pre`。

## 時鐘

`harness.tz` 必須是 `UTC`。Python 測試若讀到其他值會失敗。

`harness.frozen_now` 是 naive datetime `2023-11-14T22:13:20`，解讀為 UTC。`##種子` 的單抽用這個時間，不走 `rng`。預期回覆就是 oracle。

`harness.epoch` 是 `1700000000.0`。睡眠計時用這個值，不用 `frozen_now`。

步驟若有 `epoch`，只在該步覆寫。沒有這個欄位就回到 `harness.epoch`。

`愛醬安靜=999` 的回覆時間是 `2023-11-21 22:13`。999 小時被夾成 168 小時。格式是 `%Y-%m-%d %H:%M`，沒有秒。`愛醬安靜=1` 的回覆時間是 `2023-11-14 23:13`。

## 簽章

`harness.secret` 是 `golden-secret`。`harness.token` 是 `golden-token`。兩個都是假的，不能拿去打正式 LINE。

有事件的步驟，body 是下面這個 JSON 的 UTF-8 bytes。序列化使用 `separators=(",", ":")`，並且 `ensure_ascii` 為 true。非 ASCII 會變成 `\uXXXX`。

```json
{"destination":"Udeadbeef","events":[<event>]}
```

`X-Line-Signature` 是 `base64(hmac_sha256(utf8(secret), body_bytes))`。header 名稱是 `X-Line-Signature`。

路徑是 `/callback/<secret>/<token>`。簽章的 key 是路徑上的 secret。

TypeScript 應直接重放 `request`。Python 每次測試都會用作者欄位重算 `request`。兩者不一致就失敗。

`help_11` 的簽章是 `o2+a9qQwtrb9SLD4+ZFn9KP1WGy8C0+/YU5EpioLRUQ=`。body 以 `{"destination":"Udeadbeef","events":[{"type":"message","replyToken":"rt-0"` 開頭。

事件索引從 0 開始。`replyToken` 是 `rt-<index>`。文字與貼圖的 message id 是 `mid-<index>`，除非步驟寫了 `message_id`。

`ping` 是 `GET /ping`，沒有 body，也沒有簽章。預期 body 是 `pong`。

`bad_signature` 的 body 是 `{"events":[]}`，header 值是 `bad`。預期 status 400，body 是空字串。

`missing_signature` 的 body 相同，沒有 `X-Line-Signature`。預期 status 400。

`signed_empty` 是簽過名的空 `events`。預期 status 200，body 是 `ok`，沒有 LINE 呼叫。

## 外部 HTTP

測試不打真的網路。mock 規則如下。

- HEAD。步驟的 `head_map` 先決定 content-type。否則用 `harness.head_defaults` 的字尾。再否則用 `harness.head_fallback`。
- random.org。URL 含 `random.org`。步驟有 `random_org` 時，依序回那些整數，長度不足就截斷。沒有這個欄位時，回 `num` 個 `0`。body 是每行一個數字，最後有換行。`num` 來自 URL 的 `num=`。一萬抽的夾限發生在呼叫之前，所以 `*10001` 的請求 `num` 是 10000。
- Safe Browsing。`safe_browsing` 預設 `clean`，回 `{}`。`threat` 回一個含 `matches` 的物件，`threatType` 是 `MALWARE`，url 是 `http://evil.invalid/`。空物件當安全。有 `matches` 當危險。
- imgur。上傳一律回 `harness.imgur_link`。
- LINE reply 與 push 只被記錄，不送出。
- 群組成員顯示名稱是 `harness.profile_display_name`。聊天室成員查詢回 `harness.room_profile_status`。
- 圖片內容是 `harness.image_content_b64` 解出來的 bytes。
- DNS。主機名解析成 `harness.dns_ipv4`。目前是 `93.184.216.34`。這是公開位址，HEAD 探測才會放行。

## 亂數

TypeScript 不要重現 CPython 的 `random`。`seed` 只記錄這份腳本是用哪個 seed 在 CPython 3.13 產生的。重放時忽略 `seed`。省略時是 `defaults.seed`，目前是 1。

`rng` 是該步依呼叫順序的抽樣腳本。必須剛好用完。多一次或少一次都是失敗。

- `choice`。把當下傳入的序列轉成 list，回 `list[index]`。
- `sample`。把母體轉成 list，依 `indices` 取出。順序就是回傳順序。不支援 `counts`。
- `uniform`。忽略傳入的上下界，回 `float.fromhex(hex)`。`hex` 是 Python `float.hex` 的 binary64。不要用 JSON number。

沒有抽到 random 的步驟，`rng` 是空陣列。

`##種子` 的單抽不走 `rng`。

多抽 `count > 1` 走 random.org mock，不走 `uniform`，除非 mock 失敗。這份 fixture 的 mock 不會失敗。

`cap*10000` 與 `cap*10001` 的回覆都是 `a x 10000`。若夾限失效，`*10001` 會變成 `a x 10001`。`cap*0` 被夾成 1，走本地 `uniform`，回覆是單一選項，不是 `x 1`。

`check()` 在模糊命中時仍會 `choice`，即使候選只有一個。一萬抽步驟的 `rng` 因此仍有一筆 `choice`。那不是抽卡本身。

## 資料庫切片

只有步驟列出 `db` 時，`expect.db` 才有那些 key。沒列的不比。切片是該步結束後的整表，不是差量。

`keywords` 是排序後的 `[id, keyword, reply]`。`id` 是群組、聊天室或使用者 id。

`settings` 是排序後的 `[group_id, user_id, options]`。空的 id 是空字串，不是 null。`options` 是應用程式 `json.dumps` 出來的字串。不要重排 key。

`counts` 的 key 是 `gid + "\0" + uid`。JSON 裡是 `\u0000`。value 是計數字典。`message_over_300` 的 `C_plain\0U_own` 是 `{"對話": 1, "髒話": 0, "字數": 301}`。

## 步驟欄位

`name` 在檔案內唯一。

`kind` 是 `text`、`sticker`、`image`、`follow`、`unfollow`、`join`、`leave`、`postback`、`ping`、`bad_signature`、`missing_signature`、`signed_empty`。

`source` 是 `{kind, id, user}`。`kind` 是 `group`、`room` 或 `user`。

`text` 是文字訊息。`message_id` 只在要覆寫圖片 id 時出現。

`head_map` 是該步的 HEAD 覆寫。`random_org` 省略時回零。`safe_browsing` 省略時用 `defaults.safe_browsing`。

`db` 是要記錄的切片名稱，值是 `keywords`、`settings`、`counts`。

`expect.status` 是 HTTP status。`expect.body` 是回應本文。成功的 webhook 是 `ok`。

`expect.calls` 是 `["reply" 或 "push", target, messages]`。`messages` 是送到 LINE 的 JSON。

`expect.db` 只含要求的切片。
