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
    print('耗時=%.3f' % (time()-start_time))
    return reply_message if reply_message is not None else 'ok'


@app.route("/sticker", methods=['POST'])
def event_sticker():
    MessageLogs.add(request.json['group_id'], request.json['user_id'], nSticker=1)
    return 'ok'


@app.route("/image", methods=['POST'])
def event_image():
    MessageLogs.add(request.json['group_id'], request.json['user_id'], nImage=1)
    return 'ok'


@app.route("/follow", methods=['POST'])
def event_follow():
    bots[request.json['bot_id']].reply_message(request.json['reply_token'], cfg['加入好友'])
    return 'ok'


@app.route("/unfollow", methods=['POST'])
def event_unfollow():
    return 'ok'


@app.route("/join", methods=['POST'])
def event_join():
    bots[request.json['bot_id']].reply_message(request.json['reply_token'], cfg['加入群組'])
    return 'ok'


@app.route("/leave", methods=['POST'])
def event_leave():
    return 'ok'


@app.route("/postback", methods=['POST'])
def event_postback():
    return 'ok'


if __name__ == '__main__':
    app.run(
        host='0.0.0.0',
        port=cfg['flask']['port'],
        threaded=cfg['flask']['threaded'],
        debug=cfg['flask']['debug'],
    )
