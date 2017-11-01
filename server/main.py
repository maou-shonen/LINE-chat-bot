import os
from time import time

from api import cfg
from app import app, request, abort
from database import MessageLogs
from LineBot import bots
from event_text import event_text_main


@app.route("/text", methods=['POST'])
def event_text():
    start_time = time()
    reply_message = event_text_main(**request.json)
    print([request.json['user_id'][:6], '>', request.json['message'], '\n'])
    if reply_message is not None:
        print([request.json['user_id'][:6], '<', reply_message, '(耗時%.3fs)' % (time()-start_time)])
        return reply_message
    return ''


@app.route("/sticker", methods=['POST'])
def event_sticker():
    MessageLogs.add(request.json['group_id'], request.json['user_id'], nSticker=1)
    return ''


@app.route("/image", methods=['POST'])
def event_image():
    MessageLogs.add(request.json['group_id'], request.json['user_id'], nImage=1)
    return ''


@app.route("/follow", methods=['POST'])
def event_follow():
    bots[request.json['bot_id']].reply_message(request.json['reply_token'], cfg['加入好友'])
    return ''


@app.route("/unfollow", methods=['POST'])
def event_unfollow():
    return ''


@app.route("/join", methods=['POST'])
def event_join():
    bots[request.json['bot_id']].reply_message(request.json['reply_token'], cfg['加入群組'])
    return ''


@app.route("/leave", methods=['POST'])
def event_leave():
    return ''


@app.route("/postback", methods=['POST'])
def event_postback():
    return ''


if __name__ == '__main__':
    app.run(
        host='0.0.0.0',
        port=cfg['flask']['port'],
        threaded=cfg['flask']['threaded'],
        debug=cfg['flask']['debug'],
    )
