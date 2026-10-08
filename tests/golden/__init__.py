"""Black-box harness for the FastAPI app.

Drives POST /callback/<secret>/<token> exactly as LINE does and records what
the app would send back to LINE. Everything runs in-process via FastAPI's
TestClient; no sockets, no real LINE calls, no real DB server.

Layout (all synthetic, committed):
  tests/golden/harness.py      - boot + mocks + webhook driver + determinism
  tests/golden/scenarios.yaml  - DATA: ordered webhook steps
  tests/golden/golden.json     - captured reply/push payloads (the lock-in)
  tests/golden/test_golden.py  - replays scenarios, diffs against golden.json
  tests/test_runtime.py        - focused unit tests (signature, ACK, queue,
                                 LINE client shapes)
  tests/README.md              - how to run
"""
