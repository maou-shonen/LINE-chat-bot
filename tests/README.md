# Tests: black-box behavior lock for the FastAPI app

## What

`fixtures/suite.json` is the contract Python and TypeScript share. Each step is a signed webhook request, scripted RNG draws, and the expected HTTP result, LINE payloads, and DB slices. Format details are in `fixtures/SCHEMA.md`.

## Run

From the repo root:

```sh
uv run pytest -q
```

## Regenerate expects

Review the diff before committing. Do not regen blindly.

```sh
REGEN_GOLDEN=1 uv run pytest tests/golden/test_golden.py -q
git diff fixtures/suite.json
```

Regen rewrites `request`, `rng`, and `expect` from the authoring fields. A normal pytest replays `rng` and does not use `seed`.

## Layout

- `fixtures/suite.json` is the ordered suite. One shared SQLite database. Do not reorder steps without regenerating.
- `fixtures/SCHEMA.md` documents the signature, mocks, RNG script, and DB slices.
- `tests/golden/harness.py` boots the app and mocks outbound HTTP.
- `tests/golden/fixture.py` loads the suite, signs requests, and replays RNG.
- `tests/test_runtime.py` covers signature verify, ACK-before-processing, queue order, and LINE client request shapes.

## Known legacy quirks (fixed in the FastAPI rewrite)

- `missing_signature` returns **400**. Legacy Flask raised a raw `KeyError` and returned 500.
- `opinion_500` returns **200** with a polite reply. `意見` pushes to `DEVELOPER_USER_ID` via `DEVELOPER_BOT_TOKEN` when both are set, otherwise replies that feedback is not configured. Legacy `push_developer` needed `bots['admin']`, which was never created, so it returned 500. The same rule applies to the `check()` error report. Push when configured, otherwise log a warning.
