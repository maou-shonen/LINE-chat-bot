import os
from time import time

import web_api
from api import cfg, text
from app import app, request, abort
from database import db
from LineBot import bots, push_developer
from event_text import EventText


@app.route('/text', methods=['POST'])
def event_text():
    start_time = time()

    with db.session.no_autoflush:
        EventText(**request.json).start()

    return 'ok'

@app.route('/sticker', methods=['POST'])
def event_sticker():
    with db.session.no_autoflush:
        EventText(message=None, sticker=1, image=None, **request.json).start()
    return 'ok'


@app.route('/image', methods=['POST'])
def event_image():
    with db.session.no_autoflush:
        EventText(message=None, sticker=None, image=1, **request.json).start()
    return 'ok'


@app.route('/follow', methods=['POST'])
def event_follow():
    bots[request.json['bot_id']].push(to=request.json['user_id'], reply_token=request.json['reply_token'], messages=text['加入好友'])
    return 'ok'


@app.route('/unfollow', methods=['POST'])
def event_unfollow():
    return 'ok'


@app.route('/join', methods=['POST'])
def event_join():
    bots[request.json['bot_id']].push(to=request.json['group_id'], reply_token=request.json['reply_token'], messages=text['加入群組'])
    return 'ok'


@app.route('/leave', methods=['POST'])
def event_leave():
    return 'ok'


@app.route('/postback', methods=['POST'])
def event_postback():
    return 'ok'


if __name__ == '__main__':
    debug = False
    port = 9999
    
    import sys
    import getopt

    try:
        opts, args = getopt.getopt(sys.argv[1:], 'hdp:', ['help', 'debug', 'port='])
    except getopt.GetoptError as e:
        app.logger.error('ERROR getopt')
        sys.exit(2)

    for key, value in opts:
        if key in ['-h', '--help']:
            print('-d --debug')
            print('-p --port')
            sys.exit()
        elif key in ['-d', '--debug']:
            debug = True
        elif key in ['-p', '--port']:
            port = int(value)
        else:
            assert False
    
    app.run(
        host='0.0.0.0',
        port=port,
        threaded=True,
        debug=debug,
    )
