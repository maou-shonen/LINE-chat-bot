"""Black-box harness for the FastAPI app.

Drives the webhook the way LINE does and records what the app would send
back to LINE. Everything runs in-process via FastAPI's TestClient.

Layout:
  fixtures/suite.json          - shared steps, wire requests, RNG, expects
  fixtures/SCHEMA.md           - format for the TypeScript port
  tests/golden/harness.py      - boot, outbound mocks, request sender
  tests/golden/fixture.py      - load the suite, sign, script random
  tests/golden/test_golden.py  - replay and diff
  tests/test_runtime.py        - signature, ACK, queue, LINE client shapes
  tests/README.md              - how to run
"""
