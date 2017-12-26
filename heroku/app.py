import os
import time
import requests
from requests import post

from flask import Flask, request, abort
from linebot import LineBotApi, WebhookHandler
from linebot.exceptions import InvalidSignatureError
from linebot.models import (
    MessageEvent, FollowEvent, UnfollowEvent, JoinEvent, LeaveEvent, PostbackEvent,
    TextMessage, StickerMessage, ImageMessage, TextSendMessage,
)
from imgurpython import ImgurClient


app = Flask(__name__)
bot_id = os.environ.get('bot_id', None)
handler = WebhookHandler(os.environ.get('ChannelSecret'))
bot = LineBotApi(os.environ.get('ChannelAccessToken'))
server_url = os.environ.get('server_url')
imgur = None


def _post(endpoint, **json):
    try:
        r = requests.post(server_url + endpoint, json=json, timeout=30)
        print('[%s] [%s]' % (r.status_code, json['message'])) #用來檢測heroku沒有將內容傳送過來的問題 ...吃字
        return r
    except:
        pass

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

    return 'OK'


@handler.add(MessageEvent, message=TextMessage)
def handle_message(event):
    r = _post('/text', **get_id(event), message=event.message.text, reply_token=event.reply_token)


@handler.add(MessageEvent, message=StickerMessage)
def handle_sticker(event):
    _post('/sticker', **get_id(event))


@handler.add(MessageEvent, message=ImageMessage)
def handle_image(event):
    _post('/image', **get_id(event))

    def get_imgur_client():
        global imgur
        if imgur is None:
            try:
                return ImgurClient(os.environ.get('imgur_id'), os.environ.get('imgur_secret'))
            except:
                return None
        return None

    if event.source.type == 'user':
        path = '%s.tmp' % event.message.id
        message_content = bot.get_message_content(event.message.id)
        with open(path, 'wb') as f:
            for chunk in message_content.iter_content():
                f.write(chunk)
        imgur = get_imgur_client()
        if imgur is None:
            msg = '圖床目前無法訪問 愛醬攤手'
        else:
            for i in range(100):
                try:
                    image = imgur.upload_from_path(path)
                    msg = image['link']
                    break
                except Exception as e:
                    msg = '愛醬上傳圖片錯誤了...\n%s' % str(e)
                    time.sleep(0.2)
        os.remove(path)
        bot.reply_message(event.reply_token, TextSendMessage(text=msg))


@handler.add(FollowEvent)
def follow(event):
    _post('/follow', **get_id(event), reply_token=event.reply_token)

@handler.add(UnfollowEvent)
def unfollow(event):
    _post('/unfollow', **get_id(event))

@handler.add(JoinEvent)
def join(event):
    _post('/join', **get_id(event), reply_token=event.reply_token)

@handler.add(LeaveEvent)
def leave(event):
    _post('/leave', **get_id(event))

@handler.add(PostbackEvent)
def postback(event):
    _post('/postback', **get_id(event))


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, threaded=True)
