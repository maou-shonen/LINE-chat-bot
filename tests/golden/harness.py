"""Boot + mocks + webhook driver for the legacy Flask app.

The app under test reads `config.yaml`/`text.yaml` from the process cwd at
import time and keeps large module-level state (Flask-SQLAlchemy engine,
keyword cache, `bots` dict, sleep-mode INI). So the harness:

1. copies `text.yaml` (non-secret UI strings stay in repo) plus a synthetic
   `config.yaml` (SQLite temp file, fake keys, `test_marker`) into a fresh
   temp dir and `os.chdir()`s there BEFORE importing app modules;
2. pre-creates the `user_keyword` table so `database.py`'s import-time
   full-table cache load finds an (empty) table;
3. patches `sqlalchemy.create_engine` only to drop `pool_size`/`pool_timeout`
   (Flask-SQLAlchemy 2.5.1 always sends them; SQLite's NullPool rejects them;
   prod ran MySQL where they are valid — test-side compat, not app behavior);
4. intercepts every outbound call at the lowest stable boundary and records
   payloads instead of hitting the network.

Outbound boundaries (all recorded into `Harness.calls`):
- LINE Messaging API: `LineBotApi.reply_message` / `push_message`
  (captured as `as_json_dict()` — the exact JSON sent to LINE), profile
  lookups `get_group_member_profile` / `get_room_member_profile`
  (fixed display name `ProbeUser`), content download `get_message_content`
  (fixed bytes for the 1:1 image->imgur path);
- image HEAD checks: `requests.head` (content-type per URL suffix unless the
  scenario overrides it via `head_map`);
- random.org multi-draw: `requests.get` to random.org (scenario-controlled
  integers via `random_org`, defaulting to deterministic zeros);
- Google Safe Browsing: `requests.post` to safebrowsing (scenario-controlled
  via `safe_browsing`: `clean` or `threat`);
- imgur upload: `Imgur.uploadByLine` (returns a fixed `https:` URL);
- LINE's own API transport: `requests.post/get/delete/put` under
  `linebot.http_client` is left intact because reply/push are captured one
  layer up; any transport call that would escape is blocked.

Determinism: `random.seed` is reset before every scenario step, and
`event_text`'s `choice`/`uniform`/`sample` draw from that stream. Wall-clock
dependent outputs (sleep-until timestamps, `##種子` day buckets) are captured
as-is into the golden file; they are stable for a fixed run only insofar as
the scenario pins them — the sleep test asserts shape, not the exact hour.
The one deliberate nondeterminism source (`api.get_id` sleeps 10ms and uses
time) is never hit: ` UrlShortener` paths are dead in covered scenarios.

DB-visible effects: the harness exposes `db_state()` (keyword rows, settings,
counters) so scenarios can assert via `expect_db` without touching SQL.
"""
import base64
import copy
import hashlib
import hmac
import io
import json
import os
import random
import shutil
import sqlite3
import sys
import tempfile

GOLDEN_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(GOLDEN_DIR))

SECRET = "golden-secret"
TOKEN = "golden-token"


def make_cwd():
    run = tempfile.mkdtemp(prefix="golden-")
    shutil.copy(os.path.join(REPO_ROOT, "text.yaml"), run)
    with open(os.path.join(REPO_ROOT, "tests", "golden", "config.synthetic.yaml"),
              encoding="utf-8") as f:
        synthetic = f.read()
    db_path = os.path.join(run, "golden.db")
    with open(os.path.join(run, "config.yaml"), "w", encoding="utf-8") as f:
        f.write(synthetic.replace("__DB_PATH__", db_path).replace(
            "__RUN_DIR__", run))
    con = sqlite3.connect(db_path)
    con.execute(
        "CREATE TABLE user_keyword (_id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " id VARCHAR(35), author VARCHAR(35), keyword VARCHAR(128),"
        " reply TEXT, super BOOLEAN, level INTEGER)")
    con.commit()
    con.close()
    return run


class Harness:
    def __init__(self):
        self.calls = []
        self.head_map = {}
        self.random_org = None
        self.safe_browsing = "clean"
        self.client = None

    def boot(self):
        run = make_cwd()
        os.chdir(run)
        sys.path.insert(0, GOLDEN_DIR)
        import sitecustomize  # noqa: F401  (installs config.yaml guard)
        sys.path.insert(0, REPO_ROOT)
        for mod in [m for m in list(sys.modules)
                    if m.split(".")[0] in ("api", "app", "database", "main",
                                            "event_text", "LineBot", "other",
                                            "module")]:
            del sys.modules[mod]

        import flask_sqlalchemy
        import sqlalchemy
        orig_create = sqlalchemy.create_engine

        def _create(*a, **k):
            k.pop("pool_size", None)
            k.pop("pool_timeout", None)
            return orig_create(*a, **k)

        sqlalchemy.create_engine = _create
        flask_sqlalchemy.SQLAlchemy.create_engine = (
            lambda self, sa_url, engine_opts: orig_create(
                sa_url, **{k: v for k, v in engine_opts.items()
                           if k not in ("pool_size", "pool_timeout")}))

        import database
        database.db.create_all()
        self.database = database

        import time as _time_mod
        import event_text as _et_mod
        _et_mod.time = lambda: 1700000000.0
        _time_mod.sleep = lambda s: None

        from linebot import LineBotApi
        harness = self

        def _reply(self_api, reply_token, messages, **kw):
            harness.calls.append(
                ["reply", reply_token,
                 [m.as_json_dict() for m in messages]])

        def _push(self_api, to, messages, **kw):
            harness.calls.append(
                ["push", to, [m.as_json_dict() for m in messages]])

        LineBotApi.reply_message = _reply
        LineBotApi.push_message = _push
        LineBotApi.get_group_member_profile = (
            lambda self_api, gid, uid, **kw: type(
                "Profile", (), {"display_name": "ProbeUser"})())
        LineBotApi.get_room_member_profile = (
            lambda self_api, rid, uid, **kw: (_ for _ in ()).throw(
                Exception("no room profile in harness")))
        LineBotApi.get_message_content = (
            lambda self_api, mid, **kw: type(
                "Content", (), {"iter_content": staticmethod(
                    lambda chunk_size=1024: [b"fake-image-bytes"])})())

        import requests
        harness_ref = self

        def _head(url, **kw):
            if url in harness_ref.head_map:
                ct = harness_ref.head_map[url]
            elif url.endswith((".jpg", ".jpeg")):
                ct = "image/jpeg"
            elif url.endswith(".png"):
                ct = "image/png"
            else:
                ct = "text/html"
            return type("Resp", (), {"headers": {"content-type": ct}})()

        def _get(url, **kw):
            if "random.org" in url:
                import re
                m = re.search(r"num=(\d+)", url)
                num = int(m.group(1)) if m else 1
                vals = harness_ref.random_org
                if vals is None:
                    vals = [0] * num
                body = "\n".join(str(v) for v in vals[:num]) + "\n"
                return type("Resp", (), {"text": body, "ok": True})()
            raise AssertionError("blocked outbound GET: %s" % url)

        def _post(url, **kw):
            if "safebrowsing" in url:
                if harness_ref.safe_browsing == "threat":
                    payload = {"matches": [{
                        "threat": {"url": "http://evil.invalid/"},
                        "threatType": "MALWARE"}]}
                else:
                    payload = {}
                return type("Resp", (), {
                    "ok": True, "json": staticmethod(lambda: payload)})()
            raise AssertionError("blocked outbound POST: %s" % url)

        requests.head = _head
        requests.get = _get
        requests.post = _post

        from module.imgur import imgur as imgur_obj
        imgur_obj.uploadByLine = (
            lambda bot, message_id: "https://i.imgur.com/golden.jpg")

        import main
        self.client = main.app.test_client()
        self.run_dir = run
        return self

    def webhook(self, event, secret=SECRET, token=TOKEN):
        body = json.dumps({"destination": "Udeadbeef",
                           "events": [event]}, separators=(",", ":"))
        sig = base64.b64encode(hmac.new(
            secret.encode(), body.encode(), hashlib.sha256).digest()).decode()
        return self.client.post(
            "/callback/%s/%s" % (secret, token), data=body,
            content_type="application/json",
            headers={"X-Line-Signature": sig})

    def raw_post(self, body, secret=SECRET, token=TOKEN, signature=None):
        headers = {}
        if signature is not None:
            headers["X-Line-Signature"] = signature
        return self.client.post(
            "/callback/%s/%s" % (secret, token), data=body,
            content_type="application/json", headers=headers)

    def db_state(self):
        database = self.database
        with database.app.app_context():
            keywords = sorted(
                [r.id, r.keyword, r.reply]
                for r in database.UserKeyword.query.all())
            settings = sorted(
                [r.group_id or "", r.user_id or "", r.options]
                for r in database.UserSettings.query.all())
            counts = {}
            for r in database.GroupUser.query.all():
                r._json()
                counts["%s\0%s" % (r.gid, r.uid)] = copy.deepcopy(r.count)
        return {"keywords": keywords, "settings": settings,
                "counts": counts}
