import os
from loguru import logger
from api import cfg, text
from app import app, request, abort
#from database import db
from LineBot import bots, push_developer, LineBot
from event_text import EventText

from flask import  request, abort, jsonify
from linebot import WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import (
    MessageEvent, FollowEvent, UnfollowEvent, JoinEvent, LeaveEvent, PostbackEvent,
    TextMessage, StickerMessage, ImageMessage, TextSendMessage,
)


def get_id(event):
    if   event.source.type == 'user':
        return {'user_id':event.source.user_id, 'group_id':None}
    elif event.source.type == 'group':
        return {'user_id':event.source.user_id, 'group_id':event.source.group_id}
    elif event.source.type == 'room':
        return {'user_id':event.source.user_id, 'group_id':event.source.room_id}


def getHandle(token, channel_secret):
    handler = WebhookHandler(channel_secret)

    @handler.add(MessageEvent, message=TextMessage)
    def handle_message(event):
        EventText(**get_id(event), bot_id=token, reply_token=event.reply_token, message=event.message.text).run()
        return 'ok'

    @handler.add(MessageEvent, message=StickerMessage)
    def handle_sticker(event):
        EventText(**get_id(event), bot_id=token, reply_token=event.reply_token, message=None, sticker=1, image=None).run()
        return 'ok'


    @handler.add(MessageEvent, message=ImageMessage)
    def handle_image(event):
        EventText(**get_id(event), bot_id=token, reply_token=event.reply_token, message=None, sticker=None, image=1, message_id=event.message.id).run()
        return 'ok'


    @handler.add(FollowEvent)
    def follow(event):
        bots[token].push(to=event.source.user_id, reply_token=event.reply_token, messages=text['加入好友'])
        return 'ok'


    @handler.add(UnfollowEvent)
    def unfollow(event):
        return 'ok'


    @handler.add(JoinEvent)
    def join(event):
        bots[token].push(to=event.source.group_id, reply_token=event.reply_token, messages=text['加入群組'])
        return 'ok'


    @handler.add(LeaveEvent)
    def leave(event):
        return 'ok'


    @handler.add(PostbackEvent)
    def postback(event):
        return 'ok'

    return handler


@app.route("/callback/<secret>/<path:token>", methods=['POST'])
def callback(secret, token):
    if token not in bots:
        bots[token] = LineBot(push=False, token=token)

    # get X-Line-Signature header value
    signature = request.headers['X-Line-Signature']

    # get request body as text
    body = request.get_data(as_text=True)
    #logger.info("Request body: " + body)

    # handle webhook body
    try:
        getHandle(token, secret).handle(body, signature)
    except InvalidSignatureError:
        abort(400)

    return 'ok'


if __name__ == '__main__':
    debug = os.environ.get('DEBUG')
    port = int(os.environ.get('PORT', 5000))
    
    app.run(
        host='0.0.0.0',
        port=port,
        threaded=True,
        debug=debug,
    )
