"""Load fixtures/suite.json, sign webhook bodies, script random draws.

`request` is the wire contract. `rng` is the random contract. `seed` only
explains how CPython produced `rng` and is not replayed.
"""
import base64
import copy
import hashlib
import hmac
import json
import os

from .harness import REPO_ROOT, Harness

SUITE_PATH = os.path.join(REPO_ROOT, "fixtures", "suite.json")

_STEP_KEYS = (
    "name", "kind", "source", "text", "message_id", "seed", "epoch",
    "head_map", "random_org", "safe_browsing", "db", "request", "rng",
    "expect",
)
_ORIG_NAMES = (
    "choice", "uniform", "sample", "random", "randint", "randrange",
    "shuffle",
)


def load_suite(path=SUITE_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump_suite(suite, path=SUITE_PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(suite, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write("\n")


def sign(secret, body):
    digest = hmac.new(
        secret.encode(), body.encode(), hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


def _line_source(src):
    kind = src["kind"]
    if kind == "group":
        return {"type": "group", "groupId": src["id"], "userId": src["user"]}
    if kind == "room":
        return {"type": "room", "roomId": src["id"], "userId": src["user"]}
    return {"type": "user", "userId": src["user"]}


def build_event(step, n):
    kind = step["kind"]
    if kind == "text":
        return {"type": "message", "replyToken": "rt-%d" % n,
                "source": _line_source(step["source"]), "timestamp": 1,
                "message": {"type": "text", "id": "mid-%d" % n,
                            "text": step["text"]}}
    if kind == "sticker":
        return {"type": "message", "replyToken": "rt-%d" % n,
                "source": _line_source(step["source"]), "timestamp": 1,
                "message": {"type": "sticker", "id": "mid-%d" % n,
                            "packageId": "1", "stickerId": "1"}}
    if kind == "image":
        return {"type": "message", "replyToken": "rt-%d" % n,
                "source": _line_source(step["source"]), "timestamp": 1,
                "message": {"type": "image",
                            "id": step.get("message_id", "mid-%d" % n)}}
    if kind == "follow":
        return {"type": "follow", "replyToken": "rt-%d" % n,
                "source": {"type": "user", "userId": step["source"]["user"]},
                "timestamp": 1}
    if kind == "unfollow":
        return {"type": "unfollow",
                "source": {"type": "user", "userId": step["source"]["user"]},
                "timestamp": 1}
    if kind == "join":
        return {"type": "join", "replyToken": "rt-%d" % n,
                "source": {"type": "group", "groupId": step["source"]["id"],
                           "userId": step["source"]["user"]},
                "timestamp": 1}
    if kind == "leave":
        return {"type": "leave",
                "source": {"type": "group", "groupId": step["source"]["id"],
                           "userId": step["source"]["user"]},
                "timestamp": 1}
    if kind == "postback":
        return {"type": "postback", "replyToken": "rt-%d" % n,
                "source": {"type": "user", "userId": step["source"]["user"]},
                "timestamp": 1, "postback": {"data": "golden"}}
    raise AssertionError("no event for kind %s" % kind)


def build_request(step, n, cfg):
    secret = cfg["secret"]
    token = cfg["token"]
    path = "/callback/%s/%s" % (secret, token)
    kind = step["kind"]
    if kind == "ping":
        return {"method": "GET", "path": "/ping", "headers": {}}
    if kind == "bad_signature":
        return {"method": "POST", "path": path,
                "headers": {"Content-Type": "application/json",
                            "X-Line-Signature": "bad"},
                "body": '{"events":[]}'}
    if kind == "missing_signature":
        return {"method": "POST", "path": path,
                "headers": {"Content-Type": "application/json"},
                "body": '{"events":[]}'}
    if kind == "signed_empty":
        body = json.dumps(
            {"destination": cfg["destination"], "events": []},
            separators=(",", ":"))
    else:
        body = json.dumps(
            {"destination": cfg["destination"],
             "events": [build_event(step, n)]},
            separators=(",", ":"))
    return {"method": "POST", "path": path,
            "headers": {"Content-Type": "application/json",
                        "X-Line-Signature": sign(secret, body)},
            "body": body}


def _index(population, item):
    pop = list(population)
    for i, cur in enumerate(pop):
        if cur is item:
            return i
    for i, cur in enumerate(pop):
        if cur == item:
            return i
    raise AssertionError("rng item missing from population")


def _indexes(population, items):
    pop = list(population)
    used = set()
    out = []
    for item in items:
        found = None
        for i, cur in enumerate(pop):
            if i in used:
                continue
            if cur is item:
                found = i
                break
        if found is None:
            for i, cur in enumerate(pop):
                if i in used:
                    continue
                if cur == item:
                    found = i
                    break
        if found is None:
            raise AssertionError("rng item missing from population")
        used.add(found)
        out.append(found)
    return out


class Rng:
    def __init__(self, mod):
        self.mod = mod
        self.orig = {name: getattr(mod, name) for name in _ORIG_NAMES}
        self.script = []
        self.i = 0
        self.replaying = False

    def install_record(self):
        self.script = []
        self.i = 0
        self.replaying = False
        orig = self.orig
        script = self.script

        def choice(seq):
            picked = orig["choice"](seq)
            script.append({"op": "choice", "index": _index(seq, picked)})
            return picked

        def uniform(a, b):
            value = orig["uniform"](a, b)
            hexed = float.hex(value)
            if float.fromhex(hexed) != value:
                raise AssertionError("uniform hex does not round-trip")
            script.append({"op": "uniform", "hex": hexed})
            return value

        def sample(population, k, *, counts=None):
            if counts is not None:
                raise AssertionError("rng sample counts not scripted")
            picked = orig["sample"](population, k)
            script.append({
                "op": "sample",
                "indices": _indexes(population, picked),
            })
            return picked

        self.mod.choice = choice
        self.mod.uniform = uniform
        self.mod.sample = sample

    def install_replay(self, script):
        self.script = list(script)
        self.i = 0
        self.replaying = True

        def take(op):
            if self.i >= len(self.script):
                raise AssertionError("rng underrun, wanted %s" % op)
            item = self.script[self.i]
            self.i += 1
            if item["op"] != op:
                raise AssertionError(
                    "rng op %s != %s" % (item["op"], op))
            return item

        def choice(seq):
            return list(seq)[take("choice")["index"]]

        def uniform(a, b):
            return float.fromhex(take("uniform")["hex"])

        def sample(population, k, *, counts=None):
            pop = list(population)
            return [pop[i] for i in take("sample")["indices"]]

        def boom(*_a, **_k):
            raise AssertionError("unscripted random call")

        self.mod.choice = choice
        self.mod.uniform = uniform
        self.mod.sample = sample
        self.mod.random = boom
        self.mod.randint = boom
        self.mod.randrange = boom
        self.mod.shuffle = boom

    def finish(self):
        script = list(self.script)
        if self.replaying and self.i != len(script):
            raise AssertionError(
                "rng unused draws: %d" % (len(script) - self.i))
        self.restore()
        return script

    def restore(self):
        for name, fn in self.orig.items():
            setattr(self.mod, name, fn)
        self.replaying = False


def _expect(resp, harness, step):
    entry = {
        "status": resp.status_code,
        "body": resp.text,
        "calls": copy.deepcopy(harness.calls),
    }
    if "db" in step:
        state = harness.db_state()
        entry["db"] = {k: state[k] for k in step["db"]}
    return entry


def _materialize(step, request, rng, expect):
    out = {}
    for key in _STEP_KEYS:
        if key in ("request", "rng", "expect"):
            continue
        if key in step:
            out[key] = step[key]
    out["request"] = request
    out["rng"] = rng
    out["expect"] = expect
    return out


def run_suite(suite, mode):
    cfg = suite["harness"]
    defaults = suite.get("defaults", {})
    if cfg["tz"] != "UTC":
        raise AssertionError("fixture tz must be UTC, got %s" % cfg["tz"])
    harness = Harness().boot(cfg)
    import app.handler as handler_mod
    rng = Rng(handler_mod.random_module)
    materialized = []
    try:
        for n, step in enumerate(suite["steps"]):
            harness.calls.clear()
            harness.head_map = dict(step.get("head_map") or {})
            if "random_org" in step:
                harness.random_org = list(step["random_org"])
            else:
                harness.random_org = None
            harness.safe_browsing = step.get(
                "safe_browsing", defaults.get("safe_browsing", "clean"))
            harness.set_epoch(step.get("epoch", cfg["epoch"]))
            request = build_request(step, n, cfg)
            if mode == "replay" and request != step["request"]:
                raise AssertionError(
                    "request drift in %s" % step["name"])
            if mode == "record":
                handler_mod.random_module.seed(
                    step.get("seed", defaults.get("seed", 1)))
                rng.install_record()
            else:
                rng.install_replay(step.get("rng") or [])
            resp = harness.send(request)
            script = rng.finish()
            expect = _expect(resp, harness, step)
            if mode == "replay" and script != step.get("rng", []):
                raise AssertionError("rng drift in %s" % step["name"])
            materialized.append(_materialize(step, request, script, expect))
    finally:
        rng.restore()
        harness.close()
    return materialized


def suite_from_steps(steps, harness):
    return {
        "version": 1,
        "harness": harness,
        "defaults": {"seed": 1, "safe_browsing": "clean"},
        "steps": steps,
    }
