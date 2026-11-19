"""Replay fixtures/suite.json against the FastAPI webhook.

The contract is the signed request, the scripted RNG draws, the HTTP
status and body, the LINE reply/push payloads, and the requested DB
slices. Regenerate only after reading the diff:

    REGEN_GOLDEN=1 uv run pytest tests/golden/test_golden.py -q
"""
import os

from .fixture import dump_suite, load_suite, run_suite


def test_fixtures():
    suite = load_suite()
    names = [step["name"] for step in suite["steps"]]
    assert len(names) == len(set(names))
    if os.environ.get("REGEN_GOLDEN") == "1":
        suite["steps"] = run_suite(suite, "record")
        dump_suite(suite)
    got = run_suite(suite, "replay")
    assert [step["name"] for step in got] == names
    for got_step, want in zip(got, suite["steps"]):
        assert got_step["expect"] == want["expect"], want["name"]
        assert got_step["request"] == want["request"], want["name"]
        assert got_step["rng"] == want["rng"], want["name"]
