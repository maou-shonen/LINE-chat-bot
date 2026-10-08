"""Webhook surface: HMAC-SHA256 signature verification, immediate 200,
single serial queue consumer. Inbound events are normalized to the same
kwargs EventText takes; follow/join push via the per-path-token client."""
import asyncio
import base64
import hashlib
import hmac

from fastapi import APIRouter, Request, Response
from loguru import logger

from .handler import EventText
from .texts import text


def verify_signature(secret: str, body: bytes, signature: str | None) -> bool:
    if not signature:
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode()
    return hmac.compare_digest(expected, signature)


def source_ids(source):
    stype = source.get("type")
    if stype == "user":
        return {"user_id": source.get("userId"), "group_id": None}
    elif stype == "group":
        return {"user_id": source.get("userId"),
                "group_id": source.get("groupId")}
    elif stype == "room":
        return {"user_id": source.get("userId"),
                "group_id": source.get("roomId")}
    return {"user_id": None, "group_id": None}


def process_event(app_state, event):
    ctx = app_state.ctx
    etype = event.get("type")
    ids = source_ids(event.get("source", {}))
    token = event.get("_bot_token")

    if etype == "message":
        msg = event.get("message", {})
        mtype = msg.get("type")
        if mtype == "text":
            EventText(ctx, ctx.store.session(), bot_id=token,
                      reply_token=event.get("replyToken"),
                      message=msg.get("text"), **ids).run()
        elif mtype == "sticker":
            EventText(ctx, ctx.store.session(), bot_id=token,
                      reply_token=event.get("replyToken"),
                      message=None, sticker=1, image=None, **ids).run()
        elif mtype == "image":
            EventText(ctx, ctx.store.session(), bot_id=token,
                      reply_token=event.get("replyToken"),
                      message=None, sticker=None, image=1,
                      message_id=msg.get("id"), **ids).run()
    elif etype == "follow":
        ctx.get_bot(token).push(
            to=ids["user_id"], reply_token=event.get("replyToken"),
            messages=text["加入好友"], source="user")
    elif etype == "join":
        ctx.get_bot(token).push(
            to=ids["group_id"], reply_token=event.get("replyToken"),
            messages=text["加入群組"], source="group")
    elif etype in ("unfollow", "leave", "postback"):
        pass


async def consumer(app_state):
    while True:
        item = await app_state.queue.get()
        if item is None:
            app_state.queue.task_done()
            return
        try:
            await asyncio.to_thread(process_event, app_state, item)
        except Exception as e:
            logger.warning("event failed type=%s error=%s" % (
                item.get("type"), type(e).__name__))
            logger.debug("event failed: %s" % e)
        finally:
            app_state.queue.task_done()


def make_routes(app_state):
    router = APIRouter()

    @router.post("/callback/{secret}/{token:path}")
    async def callback(secret: str, token: str, request: Request):
        body = await request.body()
        signature = request.headers.get("X-Line-Signature")
        if not verify_signature(secret, body, signature):
            return Response(status_code=400)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        ctx = app_state.ctx
        ctx.get_bot(token)
        for event in payload.get("events", []):
            event["_bot_token"] = token
            await app_state.queue.put(event)
        return Response("ok")

    @router.get("/ping")
    async def ping():
        return Response("pong")

    return router
