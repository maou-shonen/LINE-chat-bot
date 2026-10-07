"""Replay scenarios.yaml against the legacy webhook; diff against golden.json.

Same scenarios run unchanged against the rewritten app later: the contract
is (HTTP status, reply/push payloads, requested DB slices), not internals.
Run from the repo root with the legacy venv:

    .venv-golden/bin/python -m pytest tests/golden/test_golden.py -q

Regenerate the golden after reviewing every diff (never blindly):

    REGEN_GOLDEN=1 .venv-golden/bin/python -m pytest tests/golden/test_golden.py -q
"""
import copy
import json
import os
import random

import yaml

from .harness import GOLDEN_DIR, SECRET, TOKEN, Harness

SCENARIOS_PATH = os.path.join(GOLDEN_DIR, "scenarios.yaml")
GOLDEN_PATH = os.path.join(GOLDEN_DIR, "golden.json")


def build_event(step, n):
    kind = step["kind"]
    if kind == "text":
        src = step["source"]
        if src["kind"] == "group":
            source = {"type": "group", "groupId": src["id"],
                      "userId": src["user"]}
        elif src["kind"] == "room":
            source = {"type": "room", "roomId": src["id"],
                      "userId": src["user"]}
        else:
            source = {"type": "user", "userId": src["user"]}
        return {"type": "message", "replyToken": "rt-%d" % n,
                "source": source, "timestamp": 1,
                "message": {"type": "text", "id": "m-%d" % n,
                            "text": step["text"]}}
    if kind == "sticker":
        src = step["source"]
        source = {"type": "group", "groupId": src["id"],
                  "userId": src["user"]}
        return {"type": "message", "replyToken": "rt-%d" % n,
                "source": source, "timestamp": 1,
                "message": {"type": "sticker", "id": "m-%d" % n,
                            "packageId": "1", "stickerId": "1"}}
    if kind == "image":
        src = step["source"]
        source = {"type": "user", "userId": src["user"]}
        return {"type": "message", "replyToken": "rt-%d" % n,
                "source": source, "timestamp": 1,
                "message": {"type": "image",
                            "id": step.get("message_id", "mid-%d" % n)}}
    if kind == "follow":
        return {"type": "follow", "replyToken": "rt-%d" % n,
                "source": {"type": "user",
                           "userId": step["source"]["user"]},
                "timestamp": 1}
    if kind == "unfollow":
        return {"type": "unfollow",
                "source": {"type": "user",
                           "userId": step["source"]["user"]},
                "timestamp": 1}
    if kind == "join":
        return {"type": "join", "replyToken": "rt-%d" % n,
                "source": {"type": "group",
                           "groupId": step["source"]["id"]},
                "timestamp": 1}
    if kind == "leave":
        return {"type": "leave",
                "source": {"type": "group",
                           "groupId": step["source"]["id"]},
                "timestamp": 1}
    if kind == "postback":
        return {"type": "postback", "replyToken": "rt-%d" % n,
                "source": {"type": "user",
                           "userId": step["source"]["user"]},
                "timestamp": 1, "postback": {"data": "golden"}}
    raise AssertionError("no event for kind %s" % kind)


def run_all():
    with open(SCENARIOS_PATH, encoding="utf-8") as f:
        spec = yaml.safe_load(f.read())
    defaults = spec.get("defaults", {})
    harness = Harness().boot()
    results = []
    for n, step in enumerate(spec["scenarios"]):
        random.seed(step.get("seed", defaults.get("seed", 1)))
        harness.calls.clear()
        harness.head_map = dict(step.get("head_map", {}))
        harness.random_org = (list(step["random_org"])
                              if "random_org" in step else None)
        harness.safe_browsing = step.get(
            "safe_browsing", defaults.get("safe_browsing", "clean"))
        kind = step["kind"]
        if kind == "ping":
            resp = harness.client.get("/ping")
            entry = {"name": step["name"], "status": resp.status_code,
                     "body": resp.data.decode(),
                     "calls": copy.deepcopy(harness.calls)}
        elif kind == "bad_signature":
            resp = harness.raw_post('{"events":[]}', signature="bad")
            entry = {"name": step["name"], "status": resp.status_code,
                     "calls": copy.deepcopy(harness.calls)}
        elif kind == "missing_signature":
            resp = harness.raw_post('{"events":[]}', signature=None)
            entry = {"name": step["name"], "status": resp.status_code,
                     "calls": copy.deepcopy(harness.calls)}
        else:
            resp = harness.webhook(build_event(step, n))
            entry = {"name": step["name"], "status": resp.status_code,
                     "calls": copy.deepcopy(harness.calls)}
        if "db" in step:
            state = harness.db_state()
            entry["db"] = {k: state[k] for k in step["db"]}
        results.append(entry)
    return results


def test_golden():
    regen = os.environ.get("REGEN_GOLDEN") == "1"
    results = run_all()
    if regen:
        with open(GOLDEN_PATH, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2,
                      sort_keys=True)
            f.write("\n")
    with open(GOLDEN_PATH, encoding="utf-8") as f:
        expected = json.load(f)
    assert [r["name"] for r in results] == [e["name"] for e in expected]
    for got, want in zip(results, expected):
        assert got == want, "golden mismatch in scenario %r" % got["name"]
