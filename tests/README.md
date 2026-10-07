# Tests: black-box behavior lock for the FastAPI app

## What

`tests/golden/` drives the app exactly as LINE does — signed
`POST /callback/<secret>/<token>` bodies — and records the exact outbound
LINE payloads plus key DB effects into `golden.json`. The contract is
(HTTP status, reply/push payloads, requested DB slices), not internals.

## Run

From the repo root:

```sh
uv run pytest -q
```

Single scenario subset (pytest `-k` matches the assertion message):

```sh
uv run pytest tests/golden/test_golden.py -q -k sleep
```

## Regenerate the golden (review every diff first, never blindly)

```sh
REGEN_GOLDEN=1 uv run pytest tests/golden/test_golden.py -q
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
- `harness.py` — boots the FastAPI app with synthetic `Settings`
  (SQLite temp DB, fake keys) and intercepts outbound HTTP at the httpx
  transport layer: LINE reply/push (recorded as the exact JSON sent),
  profile lookups (fixed display name `ProbeUser`), content download
  (fixed bytes for the 1:1 image→imgur path), `HEAD` image checks
  (content-type per URL suffix unless the scenario overrides it via
  `head_map`), random.org multi-draw (scenario-controlled integers via
  `random_org`, defaulting to deterministic zeros), Google Safe Browsing
  (scenario-controlled via `safe_browsing`: `clean` or `threat`), imgur
  upload (returns a fixed `https:` URL). Wall clock frozen at
  2023-11-14 22:13:20 UTC (TZ pinned to UTC: the sleep-until timestamp is
  the only wall-clock value in goldens); `random.seed` reset per step.
- `test_runtime.py` — focused unit tests with literal expected values:
  signature verify (valid/missing/bad → 200/400/400),
  ACK-before-processing (a slow handler must not delay the 200), queue
  ordering, and LINE client request shapes (literal JSON + headers).

## Known legacy quirks (fixed in the FastAPI rewrite)

- `missing_signature` → **400** (legacy Flask raised raw `KeyError` → 500).
- `opinion_500` → **200** with a polite reply: `意見` pushes to
  `DEVELOPER_USER_ID` via `DEVELOPER_BOT_TOKEN` when both are set,
  otherwise replies that feedback isn't configured. (Legacy `push_developer`
  needed `bots['admin']`, which was never created → 500.) Same rule for the
  `check()` error report: push when configured, else log a warning.
