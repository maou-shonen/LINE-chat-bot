"""Boot + mocks + webhook driver for the FastAPI app.

Drives POST /callback/<secret>/<token> exactly as LINE does — signed
bodies — and records the exact outbound LINE payloads plus key DB
effects into golden.json. Same scenarios.yaml as the legacy harness;
the contract is (HTTP status, reply/push payloads, requested DB
slices), not internals.

Outbound interception happens at the httpx transport layer: the
FastAPI TestClient talks to the app via ASGITransport while a
MockTransport answers every outbound call (LINE API, data API, Safe
Browsing, random.org, HEAD checks, imgur upload) and records the
LINE-bound payloads into `Harness.calls`.

Determinism: `random.seed` is reset before every scenario step, the
queue is drained before reading `calls`, and wall-clock `datetime.now`
is frozen at 2023-11-14 22:13:20 UTC. `sleep` is no-op'd upstream so
no retry sleeps slow the suite.
"""
import base64
import copy
import hashlib
import hmac
import json
import os
import tempfile
import time as _time
from datetime import datetime

import httpx

GOLDEN_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(GOLDEN_DIR))

SECRET = "golden-secret"
TOKEN = "golden-token"

FROZEN_NOW = datetime(2023, 11, 14, 22, 13, 20)


class Harness:
    def __init__(self):
        self.calls = []
        self.head_map = {}
        self.random_org = None
        self.safe_browsing = "clean"
        self.client = None

    def boot(self):
        os.environ["TZ"] = "UTC"
        _time.tzset()
        from fastapi.testclient import TestClient

        import app.texts as texts_mod
        from app.app import create_app
        from app.settings import Settings

        run = tempfile.mkdtemp(prefix="golden-")
        db_path = os.path.join(run, "golden.db")
        texts_mod.TEXT_PATH = os.path.join(REPO_ROOT, "text.yaml")
        texts_mod.text = texts_mod.load_text()
        settings = Settings(
            DATABASE_URL="sqlite:///%s" % db_path,
            GOOGLE_SAFE_BROWSING_KEY="GOLDEN-TEST-KEY",
            IMGUR_CLIENT_ID="golden-id",
            DEVELOPER_USER_ID="",
            DEVELOPER_BOT_TOKEN="",
            LINE_API_BASE_URL="https://api.line.me",
            LINE_DATA_API_BASE_URL="https://api-data.line.me",
        )
        harness = self

        def _mock_handler(request):
            url = str(request.url)
            if request.method == "HEAD":
                if url in harness.head_map:
                    ct = harness.head_map[url]
                elif url.endswith((".jpg", ".jpeg")):
                    ct = "image/jpeg"
                elif url.endswith(".png"):
                    ct = "image/png"
                else:
                    ct = "text/html"
                return httpx.Response(200, headers={"content-type": ct})
            if "random.org" in url:
                import re
                m = re.search(r"num=(\d+)", url)
                num = int(m.group(1)) if m else 1
                vals = harness.random_org
                if vals is None:
                    vals = [0] * num
                body = "\n".join(str(v) for v in vals[:num]) + "\n"
                return httpx.Response(200, text=body)
            if "safebrowsing" in url:
                if harness.safe_browsing == "threat":
                    payload = {"matches": [{
                        "threat": {"url": "http://evil.invalid/"},
                        "threatType": "MALWARE"}]}
                else:
                    payload = {}
                return httpx.Response(200, json=payload)
            if "api.imgur.com" in url:
                return httpx.Response(
                    200, json={"data": {
                        "link": "https://i.imgur.com/golden.jpg"}})
            if url.endswith("/v2/bot/message/reply"):
                payload = json.loads(request.content.decode())
                harness.calls.append(
                    ["reply", payload["replyToken"],
                     payload["messages"]])
                return httpx.Response(200, json={})
            if url.endswith("/v2/bot/message/push"):
                payload = json.loads(request.content.decode())
                harness.calls.append(
                    ["push", payload["to"], payload["messages"]])
                return httpx.Response(200, json={})
            if "/v2/bot/group/" in url and "/member/" in url:
                return httpx.Response(
                    200, json={"displayName": "ProbeUser"})
            if "/v2/bot/room/" in url and "/member/" in url:
                return httpx.Response(404, json={})
            if "/v2/bot/message/" in url and url.endswith("/content"):
                return httpx.Response(200, content=b"fake-image-bytes")
            raise AssertionError("blocked outbound: %s %s" % (
                request.method, url))

        mock_transport = httpx.MockTransport(_mock_handler)

        import app.app as app_mod

        orig_client = httpx.Client

        def _client_factory(*a, **k):
            k["transport"] = mock_transport
            return orig_client(*a, **k)

        app_mod.httpx.Client = _client_factory  # type: ignore
        try:
            fastapi_app = create_app(settings=settings)
        finally:
            app_mod.httpx.Client = orig_client  # type: ignore
        state = fastapi_app.state.app_state
        state.http = orig_client(
            timeout=10.0, transport=mock_transport)
        state.ctx.http = state.http
        orig_factory = state.ctx.line_client_factory

        def _mock_factory(token):
            client = orig_factory(token)
            client.client = orig_client(
                timeout=10.0, transport=mock_transport,
                headers={"Authorization": "Bearer %s" % token})
            client.probe_client = orig_client(
                timeout=5.0, transport=mock_transport,
                follow_redirects=False)
            client.resolver = lambda host, port: [
                (2, 1, 6, "", ("93.184.216.34", port))]
            return client

        state.ctx.line_client_factory = _mock_factory
        state.bots.clear()
        state.ctx.time_now = staticmethod(lambda: FROZEN_NOW)
        state.ctx.epoch = staticmethod(lambda: 1700000000.0)

        self.app = fastapi_app
        self.state = state
        self.database = state.store
        self._tc = TestClient(fastapi_app)
        self._tc.__enter__()
        self.client = self._tc
        self.run_dir = run
        return self

    def _drain(self):
        async def _join():
            await self.state.queue.join()
        self._tc.portal.call(_join)

    def webhook(self, event, secret=SECRET, token=TOKEN):
        import json as _json
        body = _json.dumps({"destination": "Udeadbeef",
                            "events": [event]}, separators=(",", ":"))
        sig = base64.b64encode(hmac.new(
            secret.encode(), body.encode(), hashlib.sha256).digest()).decode()
        resp = self.client.post(
            "/callback/%s/%s" % (secret, token), content=body,
            headers={"Content-Type": "application/json",
                     "X-Line-Signature": sig})
        self._drain()
        return resp

    def raw_post(self, body, secret=SECRET, token=TOKEN, signature=None):
        headers = {"Content-Type": "application/json"}
        if signature is not None:
            headers["X-Line-Signature"] = signature
        resp = self.client.post(
            "/callback/%s/%s" % (secret, token), content=body,
            headers=headers)
        self._drain()
        return resp

    def db_state(self):
        return copy.deepcopy(self.database.db_state())

    def close(self):
        self._tc.__exit__(None, None, None)
