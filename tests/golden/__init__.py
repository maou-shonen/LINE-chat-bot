"""Black-box harness for the CURRENT (Flask, ef6a18e) app.

Drives POST /callback/<secret>/<token> exactly as LINE does and records what
the app would send back to LINE. Everything runs in-process via Flask's test
client; no sockets, no real LINE calls, no real DB server.

Layout (all synthetic, committed):
  tests/golden/sitecustomize.py  - import hook; refuses to load the repo's
                                   real config.yaml (hard rule from BRIEF.md)
  tests/golden/harness.py        - boot + mocks + webhook driver + determinism
  tests/golden/scenarios.yaml    - DATA: ordered webhook steps
  tests/golden/golden.json        - captured reply/push payloads (the lock-in)
  tests/golden/test_golden.py     - replays scenarios, diffs against golden.json
  tests/README.md                 - how to run
"""
