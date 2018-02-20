import os
from flask import  request, abort, jsonify
from linebot import WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import (
    MessageEvent, FollowEvent, UnfollowEvent, JoinEvent, LeaveEvent, PostbackEvent,
    TextMessage, StickerMessage, ImageMessage, TextSendMessage,
)

from app import app
from tasks import Tasks


bot_id = os.environ.get('bot_id', None)
server_url = os.environ.get('server_url')
channel_secret = os.environ.get('ChannelSecret')

tasks = Tasks(host=server_url)
handler = WebhookHandler(channel_secret)


def get_id(event):
    if   event.source.type == 'user':
        return {'bot_id':bot_id, 'user_id':event.source.user_id, 'group_id':None}
    elif event.source.type == 'group':
        return {'bot_id':bot_id, 'user_id':event.source.user_id, 'group_id':event.source.group_id}
    elif event.source.type == 'room':
        return {'bot_id':bot_id, 'user_id':event.source.user_id, 'group_id':event.source.room_id}


@app.route("/callback", methods=['POST'])
def callback():
    # get X-Line-Signature header value
    signature = request.headers['X-Line-Signature']

    # get request body as text
    body = request.get_data(as_text=True)
    app.logger.info("Request body: " + body)

    # handle webhook body
    try:
        handler.handle(body, signature)
    except InvalidSignatureError:
        abort(400)

    return 'ok'


@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    tasks.append('/text', **get_id(event), reply_token=event.reply_token, message=event.message.text)
    return 'ok'


@handler.add(MessageEvent, message=StickerMessage)
def handle_sticker(event):
    tasks.append('/sticker', **get_id(event), reply_token=event.reply_token)
    return 'ok'


@handler.add(MessageEvent, message=ImageMessage)
def handle_image(event):
    tasks.append('/image', **get_id(event), reply_token=event.reply_token, message_id=event.message.id)
    return 'ok'


@handler.add(FollowEvent)
def follow(event):
    tasks.append('/follow', **get_id(event), reply_token=event.reply_token)
    return 'ok'


@handler.add(UnfollowEvent)
def unfollow(event):
    tasks.append('/unfollow', **get_id(event))
    return 'ok'


@handler.add(JoinEvent)
def join(event):
    tasks.append('/join', **get_id(event), reply_token=event.reply_token)
    return 'ok'


@handler.add(LeaveEvent)
def leave(event):
    tasks.append('/leave', **get_id(event))
    return 'ok'


@handler.add(PostbackEvent)
def postback(event):
    tasks.append('/postback', **get_id(event), reply_token=event.reply_token)
    return 'ok'


@app.route('/get_ip')
def get_ip():
    if 'HTTP_X_FORWARDED_FOR' in request.environ: # on heroku
        return jsonify({'ip': request.environ.get('HTTP_X_FORWARDED_FOR')}), 200
    elif 'HTTP_X_REAL_IP' in request.environ:
        return jsonify({'ip': request.environ.get('HTTP_X_REAL_IP')}), 200
    else:
        return jsonify({'ip': request.remote_addr})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, threaded=True)
