"""Boot the FastAPI app with synthetic settings and mocked outbound HTTP.

The fixture file owns the clock, fake LINE secret, and mock constants.
This module only applies them. Signing and scenario order live in fixture.py.
"""
import base64
import copy
import json
import os
import tempfile
import time as _time
from datetime import datetime

import httpx

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))


class Harness:
    def __init__(self):
        self.calls = []
        self.head_map = {}
        self.random_org = None
        self.safe_browsing = "clean"
        self.client = None
        self.cfg = None

    def boot(self, cfg):
        self.cfg = cfg
        os.environ["TZ"] = cfg["tz"]
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

        def _head_type(url):
            if url in harness.head_map:
                return harness.head_map[url]
            for suffix, content_type in cfg["head_defaults"]:
                if url.endswith(suffix):
                    return content_type
            return cfg["head_fallback"]

        def _mock_handler(request):
            url = str(request.url)
            if request.method == "HEAD":
                return httpx.Response(
                    200, headers={"content-type": _head_type(url)})
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
                    200, json={"data": {"link": cfg["imgur_link"]}})
            if url.endswith("/v2/bot/message/reply"):
                payload = json.loads(request.content.decode())
                harness.calls.append(
                    ["reply", payload["replyToken"], payload["messages"]])
                return httpx.Response(200, json={})
            if url.endswith("/v2/bot/message/push"):
                payload = json.loads(request.content.decode())
                harness.calls.append(
                    ["push", payload["to"], payload["messages"]])
                return httpx.Response(200, json={})
            if "/v2/bot/group/" in url and "/member/" in url:
                return httpx.Response(
                    200, json={"displayName": cfg["profile_display_name"]})
            if "/v2/bot/room/" in url and "/member/" in url:
                return httpx.Response(cfg["room_profile_status"], json={})
            if "/v2/bot/message/" in url and url.endswith("/content"):
                return httpx.Response(
                    200, content=base64.b64decode(cfg["image_content_b64"]))
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
        state.http = orig_client(timeout=10.0, transport=mock_transport)
        state.ctx.http = state.http
        orig_factory = state.ctx.line_client_factory
        dns_ip = cfg["dns_ipv4"]

        def _mock_factory(token):
            client = orig_factory(token)
            client.client = orig_client(
                timeout=10.0, transport=mock_transport,
                headers={"Authorization": "Bearer %s" % token})
            client.probe_client = orig_client(
                timeout=5.0, transport=mock_transport,
                follow_redirects=False)
            client.resolver = lambda host, port, ip=dns_ip: [
                (2, 1, 6, "", (ip, port))]
            return client

        state.ctx.line_client_factory = _mock_factory
        state.bots.clear()
        frozen = datetime.fromisoformat(cfg["frozen_now"])
        epoch = cfg["epoch"]
        state.ctx.time_now = staticmethod(lambda frozen=frozen: frozen)
        state.ctx.epoch = staticmethod(lambda epoch=epoch: epoch)

        self.app = fastapi_app
        self.state = state
        self.database = state.store
        self._tc = TestClient(fastapi_app)
        self._tc.__enter__()
        self.client = self._tc
        self.run_dir = run
        return self

    def set_epoch(self, epoch):
        self.state.ctx.epoch = staticmethod(lambda epoch=epoch: epoch)

    def _drain(self):
        async def _join():
            await self.state.queue.join()
        self._tc.portal.call(_join)

    def send(self, request):
        kwargs = {"headers": dict(request.get("headers") or {})}
        if request.get("body") is not None:
            kwargs["content"] = request["body"]
        resp = self.client.request(
            request["method"], request["path"], **kwargs)
        self._drain()
        return resp

    def db_state(self):
        return copy.deepcopy(self.database.db_state())

    def close(self):
        self._tc.__exit__(None, None, None)
