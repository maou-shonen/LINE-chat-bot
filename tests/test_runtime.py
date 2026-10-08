"""Focused unit tests for the FastAPI runtime: signature verification,
ACK-before-processing, queue ordering, and LINE client request shapes.
All assertions use literal expected values.
"""
import base64
import hashlib
import hmac
import json
import time

import httpx
import pytest

SECRET = "unit-secret"
TOKEN = "unit-token"


def _signed_body(secret, payload):
    body = json.dumps(payload, separators=(",", ":"))
    sig = base64.b64encode(hmac.new(
        secret.encode(), body.encode(), hashlib.sha256).digest()).decode()
    return body, sig


def _make_state(monkeypatch, tmp_path, **settings_kw):
    import app.texts as texts_mod
    texts_mod.text = texts_mod.load_text()
    from fastapi.testclient import TestClient

    from app.app import create_app
    from app.settings import Settings

    calls = []

    def _mock_handler(request):
        url = str(request.url)
        if url.endswith("/v2/bot/message/reply"):
            payload = json.loads(request.content.decode())
            calls.append(("reply", payload["replyToken"],
                          payload["messages"]))
            return httpx.Response(200, json={})
        if url.endswith("/v2/bot/message/push"):
            payload = json.loads(request.content.decode())
            calls.append(("push", payload["to"], payload["messages"]))
            return httpx.Response(200, json={})
        if "/member/" in url:
            return httpx.Response(200, json={"displayName": "ProbeUser"})
        if url.endswith("/content"):
            return httpx.Response(200, content=b"x")
        raise AssertionError("blocked outbound: %s" % url)

    import app.app as app_mod
    orig_client = httpx.Client
    transport = httpx.MockTransport(_mock_handler)

    def _factory(*a, **k):
        k["transport"] = transport
        return orig_client(*a, **k)

    monkeypatch.setattr(app_mod.httpx, "Client", _factory)
    settings = Settings(
        DATABASE_URL="sqlite:///%s" % (tmp_path / "unit.db"),
        LINE_API_BASE_URL="https://api.line.me",
        LINE_DATA_API_BASE_URL="https://api-data.line.me",
        **settings_kw)
    fastapi_app = create_app(settings=settings)
    state = fastapi_app.state.app_state
    state.http = orig_client(timeout=10.0, transport=transport)
    state.ctx.http = state.http
    orig_factory = state.ctx.line_client_factory

    def _mock_factory(token):
        client = orig_factory(token)
        client.client = orig_client(
            timeout=10.0, transport=transport,
            headers={"Authorization": "Bearer %s" % token})
        return client

    state.ctx.line_client_factory = _mock_factory
    state.bots.clear()
    tc = TestClient(fastapi_app)
    tc.__enter__()
    state._tc = tc
    state._calls = calls
    yield state
    tc.__exit__(None, None, None)


@pytest.fixture
def state(monkeypatch, tmp_path):
    yield from _make_state(monkeypatch, tmp_path)


def _text_event(n, text, user="U1", group=None):
    source = {"type": "user", "userId": user}
    if group:
        source = {"type": "group", "groupId": group, "userId": user}
    return {"type": "message", "replyToken": "rt-%d" % n,
            "source": source, "timestamp": 1,
            "message": {"type": "text", "id": "mid-%d" % n, "text": text}}


def _post(state, event, secret=SECRET, token=TOKEN, signature="sentinel"):
    body = json.dumps({"destination": "Udeadbeef", "events": [event]},
                      separators=(",", ":"))
    if signature == "sentinel":
        sig = base64.b64encode(hmac.new(
            secret.encode(), body.encode(),
            hashlib.sha256).digest()).decode()
    elif signature is None:
        sig = None
    else:
        sig = signature
    headers = {"Content-Type": "application/json"}
    if sig is not None:
        headers["X-Line-Signature"] = sig
    resp = state._tc.post("/callback/%s/%s" % (secret, token),
                          content=body, headers=headers)
    _drain(state)
    return resp


async def _join(state):
    await state.queue.join()


def _drain(state):
    state._tc.portal.call(_join, state)


def test_signature_valid_returns_200(state):
    resp = _post(state, _text_event(0, "說明"))
    assert resp.status_code == 200
    assert resp.text == "ok"


def test_signature_missing_returns_400(state):
    resp = _post(state, _text_event(0, "說明"), signature=None)
    assert resp.status_code == 400


def test_signature_bad_returns_400(state):
    resp = _post(state, _text_event(0, "說明"), signature="bad")
    assert resp.status_code == 400


def test_ack_before_processing(state, monkeypatch):
    import app.webhook as webhook_mod
    started = []
    done = []

    orig_process = webhook_mod.process_event

    def _slow(app_state, event):
        started.append(event["replyToken"])
        time.sleep(0.5)
        orig_process(app_state, event)
        done.append(event["replyToken"])

    monkeypatch.setattr(webhook_mod, "process_event", _slow)
    event = _text_event(0, "說明")
    body = json.dumps({"destination": "Udeadbeef", "events": [event]},
                      separators=(",", ":"))
    sig = base64.b64encode(hmac.new(
        SECRET.encode(), body.encode(), hashlib.sha256).digest()).decode()
    t0 = time.monotonic()
    resp = state._tc.post(
        "/callback/%s/%s" % (SECRET, TOKEN),
        content=body,
        headers={"Content-Type": "application/json",
                 "X-Line-Signature": sig})
    elapsed = time.monotonic() - t0
    assert resp.status_code == 200
    assert elapsed < 0.5
    t1 = time.monotonic()
    while started != ["rt-0"]:
        assert time.monotonic() - t1 < 10.0
        time.sleep(0.01)
    assert done == []
    _drain(state)
    assert done == ["rt-0"]


def test_queue_ordering(state):
    for n, word in enumerate(["說明", "列表"]):
        resp = _post(state, _text_event(n, word))
        assert resp.status_code == 200
    kinds = [c[1] for c in state._calls]
    assert kinds == ["rt-0", "rt-1"]

def _loguru_lines(level):
    from loguru import logger as _logger

    lines = []
    handler_id = _logger.add(
        lambda m: lines.append(m.record["message"]),
        level=level, format="{message}")
    return lines, handler_id


def test_text_event_info_hides_content(state):
    from loguru import logger as _logger

    user = "UhideMe99"
    secret_text = "極機密訊息-alpha-beta"
    lines, handler_id = _loguru_lines("INFO")
    try:
        resp = _post(state, _text_event(0, secret_text, user=user))
        assert resp.status_code == 200
    finally:
        _logger.remove(handler_id)
    blob = "\n".join(lines)
    assert secret_text not in blob
    assert user not in blob
    assert "text source=user matched=yes count=" in blob


def test_text_event_debug_shows_content(state):
    from loguru import logger as _logger

    secret_text = "極機密訊息-gamma-delta"
    lines, handler_id = _loguru_lines("DEBUG")
    try:
        resp = _post(state, _text_event(1, secret_text, user="Udbg7"))
        assert resp.status_code == 200
    finally:
        _logger.remove(handler_id)
    blob = "\n".join(lines)
    assert secret_text in blob
    assert "text source=user matched=yes count=" in blob


def test_send_failure_warning_hides_content(state, monkeypatch):
    from loguru import logger as _logger

    from app.line_client import LineClient

    user = "Ufail42"
    secret_text = "送不出去的機密-zeta"

    def _boom(self, reply_token, content):
        raise RuntimeError("reply down: %s" % secret_text)

    monkeypatch.setattr(LineClient, "reply", _boom)

    lines, handler_id = _loguru_lines("WARNING")
    try:
        resp = _post(state, _text_event(2, secret_text, user=user))
        assert resp.status_code == 200
    finally:
        _logger.remove(handler_id)
    blob = "\n".join(lines)
    assert secret_text not in blob
    assert user not in blob
    assert "傳送失敗 source=user count=" in blob
    assert "RuntimeError" in blob


def test_line_reply_request_shape(tmp_path):
    from app.line_client import LineClient
    seen = {}

    def _handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["json"] = json.loads(request.content.decode())
        return httpx.Response(200, json={})

    client = LineClient("TOK123", transport=httpx.MockTransport(_handler))
    client.reply("RT1", [{"type": "text", "text": "hi"}])
    assert seen["url"] == "https://api.line.me/v2/bot/message/reply"
    assert seen["auth"] == "Bearer TOK123"
    assert seen["json"] == {
        "replyToken": "RT1", "messages": [{"type": "text", "text": "hi"}]}


def test_line_push_request_shape(tmp_path):
    from app.line_client import LineClient
    seen = {}

    def _handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["json"] = json.loads(request.content.decode())
        return httpx.Response(200, json={})

    client = LineClient("TOK123", transport=httpx.MockTransport(_handler))
    client.push("U9", [{"type": "text", "text": "hello"}])
    assert seen["url"] == "https://api.line.me/v2/bot/message/push"
    assert seen["auth"] == "Bearer TOK123"
    assert seen["json"] == {
        "to": "U9", "messages": [{"type": "text", "text": "hello"}]}


def test_line_profile_and_content_urls(tmp_path):
    from app.line_client import LineClient
    seen = []

    def _handler(request):
        seen.append((request.method, str(request.url)))
        if str(request.url).endswith("/content"):
            return httpx.Response(200, content=b"img")
        return httpx.Response(200, json={"displayName": "ProbeUser"})

    client = LineClient("TOK123", transport=httpx.MockTransport(_handler))
    assert client.get_group_member_profile("C1", "U1") == {
        "displayName": "ProbeUser"}
    assert client.get_room_member_profile("R1", "U1") == {
        "displayName": "ProbeUser"}
    assert client.get_message_content("M1") == b"img"
    assert seen == [
        ("GET", "https://api.line.me/v2/bot/group/C1/member/U1"),
        ("GET", "https://api.line.me/v2/bot/room/R1/member/U1"),
        ("GET", "https://api-data.line.me/v2/bot/message/M1/content"),
    ]


def test_head_cache_bounded(tmp_path):
    from app.line_client import HeadCache
    cache = HeadCache()
    for i in range(5000):
        cache.set("https://example.com/%d.jpg" % i, "image/jpeg")
    from app.line_client import HEAD_CACHE_SIZE
    assert HEAD_CACHE_SIZE == 4096
    assert len(cache) == 4096
    assert "https://example.com/0.jpg" not in cache
    assert "https://example.com/4999.jpg" in cache


def test_imgur_uses_client_id_header(tmp_path):
    import app.services as services_mod
    seen = {}

    class FakeResp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"data": {"link": "https://i.imgur.com/x.jpg"}}

    class FakeHttp:
        def post(self, url, headers=None, files=None, timeout=None):
            seen["url"] = url
            seen["headers"] = headers
            seen["timeout"] = timeout
            assert files["image"][0] == "line-M1"
            return FakeResp()

    class FakeBot:
        def get_message_content(self, mid):
            assert mid == "M1"

            class Content:
                def iter_content(self, chunk_size=1024):
                    yield b"bytes"

            return Content()

    link = services_mod.upload_by_line(
        FakeHttp(), "CID123", FakeBot(), "M1")
    assert link == "https://i.imgur.com/x.jpg"
    assert seen["url"] == "https://api.imgur.com/3/image"
    assert seen["headers"] == {"Authorization": "Client-ID CID123"}
    assert seen["timeout"] == 10.0


def test_callback_path_never_logged(state, caplog):
    import logging

    from loguru import logger as _logger

    secret = "s3cr3t-abc"
    token = "tok-xyz-123"
    loguru_lines = []
    handler_id = _logger.add(lambda m: loguru_lines.append(m))
    try:
        with caplog.at_level(logging.INFO, logger="uvicorn.access"):
            resp = _post(state, _text_event(0, "說明"),
                         secret=secret, token=token)
        assert resp.status_code == 200
    finally:
        _logger.remove(handler_id)
    # httpx logs the in-process TestClient request URL at DEBUG; that is
    # harness traffic, not server output (prod inbound arrives on a
    # socket, never through httpx). Scope to the server-side loggers.
    stdlib_text = "\n".join(
        r.getMessage() for r in caplog.records
        if not r.name.startswith("httpx"))
    assert secret not in stdlib_text
    assert token not in stdlib_text
    assert secret not in "\n".join(loguru_lines)
    assert token not in "\n".join(loguru_lines)


def test_access_log_filter_redacts_callback_path():
    import logging

    from app.app import _CallbackRedactFilter

    f = _CallbackRedactFilter()
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:1", "POST", "/callback/s3cr3t/tok-9", "1.1", 200),
        None)
    assert f.filter(record) is True
    assert record.args == (
        "127.0.0.1:1", "POST", "/callback/***", "1.1", 200)
    assert record.getMessage() == \
        '127.0.0.1:1 - "POST /callback/*** HTTP/1.1" 200'
    assert "s3cr3t" not in record.getMessage()
    assert "tok-9" not in record.getMessage()
    other = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1,
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:1", "GET", "/ping", "1.1", 200), None)
    assert f.filter(other) is True
    assert other.args == ("127.0.0.1:1", "GET", "/ping", "1.1", 200)
    assert other.getMessage() == '127.0.0.1:1 - "GET /ping HTTP/1.1" 200'


def test_line_reply_non_2xx_raises():
    from app.line_client import LineClient

    def _handler(request):
        return httpx.Response(400, json={"message": "bad"})

    client = LineClient("TOK123",
                        transport=httpx.MockTransport(_handler))
    with pytest.raises(httpx.HTTPStatusError):
        client.reply("RT1", [{"type": "text", "text": "hi"}])


def test_line_push_non_2xx_raises():
    from app.line_client import LineClient

    def _handler(request):
        return httpx.Response(500, json={"message": "boom"})

    client = LineClient("TOK123",
                        transport=httpx.MockTransport(_handler))
    with pytest.raises(httpx.HTTPStatusError):
        client.push("U9", [{"type": "text", "text": "hi"}])
