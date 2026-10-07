# Golden harness: black-box behavior lock for the legacy Flask app (ef6a18e)

## What

`tests/golden/` drives the CURRENT app exactly as LINE does — signed
`POST /callback/<secret>/<token>` bodies — and records the exact outbound
LINE payloads plus key DB effects into `golden.json`. The same
`scenarios.yaml` must run unchanged against the rewritten app later.

## Run

From the repo root, with the legacy venv (CPython 3.8 per brief; prod was
PyPy 3.7 — close enough for behavior parity):

```sh
.venv-golden/bin/python -m pytest tests/golden/test_golden.py -q
```

Single scenario subset (pytest `-k` matches the assertion message):

```sh
.venv-golden/bin/python -m pytest tests/golden/test_golden.py -q -k sleep
```

## Regenerate the golden (review every diff first, never blindly)

```sh
REGEN_GOLDEN=1 .venv-golden/bin/python -m pytest tests/golden/test_golden.py -q
git diff tests/golden/golden.json   # read all of it before committing
```

## Layout

- `scenarios.yaml` — DATA: 111 ordered webhook steps (see header comment).
  Step `kind` is `text` (group/room/1:1), `sticker`, `image`, `follow`,
  `unfollow`, `join`, `leave`, `postback`, `ping`, `bad_signature`,
  `missing_signature`. Per-step `head_map` / `random_org` / `safe_browsing`
  control the mocked outbound HTTP for that step; `seed` reseeds `random`.
- `golden.json` — captured `(status, calls, db)` per scenario. `calls` are
  `["reply"|"push", target, [exact LINE message dicts]]`; `db` slices are
  `keywords` / `settings` / `counts` where behavior needs them.
- `harness.py` — temp-cwd boot with a synthetic `config.yaml` (+ guard that
  refuses the repo's real one), SQLite temp DB, and outbound interception:
  `LineBotApi.reply/push/profile/content`, `requests.head` (image check),
  random.org, Safe Browsing, imgur upload. Wall clock frozen at
  2023-11-14 22:13:20 UTC; `time.sleep` no-op'd (10×1s imgur retry path).
- `sitecustomize.py` — the config guard (imported first by the harness).
- `config.synthetic.yaml` — the synthetic config template (fake keys,
  `test_marker`).

## Legacy venv

Built from prod pins in
`/home/shonen/.cache/line-chat-bot-build/pip-freeze.txt`
(Flask 2.0.1, Flask-SQLAlchemy 2.5.1, SQLAlchemy 1.4.22, line-bot-sdk 1.20.0,
requests 2.26.0, …) via `uv`:

```sh
uv venv --python 3.8 .venv-golden
uv pip install --python .venv-golden/bin/python \
  Flask==2.0.1 Flask-SQLAlchemy==2.5.1 SQLAlchemy==1.4.22 \
  line-bot-sdk==1.20.0 requests==2.26.0 PyYAML==5.4.1 \
  loguru==0.5.3 beautifulsoup4==4.9.3 lxml==4.6.3 \
  imgurpython==1.1.7 "pixivpy==3.6.0" PyMySQL==1.0.2 \
  pytz==2021.1 pytest
```

Dropped from the freeze because they won't build / are never imported on
covered paths: `readline` (C build failure on 3.8), `greenlet` (pulled
modern by SQLAlchemy anyway), `cffi`/`Brotli`/`cloudscraper`,
google-api stack, `PyDrive`, `gunicorn`, `Flask-Compress`, `feedparser`,
`future`, `protobuf`/`rsa` chain, `readline`. No app code is touched except
nothing: the only test-side compat shim is dropping `pool_size` /
`pool_timeout` from `create_engine` (valid for prod MySQL, rejected by
SQLite's NullPool).

## Known legacy quirks (captured as-is, not fixed here)

- `missing_signature` → **500** (raw `KeyError` on the header), not 400.
  A rewrite SHOULD return 400; the golden pins 500 to prove the change.
- `意見` (feedback) → **500**: `push_developer` needs `bots['admin']`,
  which is never created. Same for any `check()` exception path
  (`bots['admin'].send_message` doesn't exist either).
- `回憶=清除=<name>` path → **500** in this env (`GroupUser` name lookup
  raising); intentionally NOT in scenarios, except `回憶=清除=全部`
  which works and IS covered.
