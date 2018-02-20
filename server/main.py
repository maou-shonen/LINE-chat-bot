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

    try:
        #request.json['user_id'] = None #測試用
        #request.json['reply_token'] = None #測試用
        with db.session.no_autoflush:
            reply_message = EventText(**request.json).run()
    except Exception as e:
        app.logger.error('ERROR')
        try:
            push_developer('<愛醬BUG>\n%s' % str(e))
            bots[request.json['bot_id']].push(to=request.json['group_id'], reply_token=request.json['reply_token'], messages='愛醬出錯了！\n作者可能會察看此錯誤報告')
        except:
            print('傳送失敗')
        db.session.commit()
        raise e

    if len(reply_message) == 0:
        return 'ok', 204
    return '\n'.join(reply_message)
    

@app.route('/sticker', methods=['POST'])
def event_sticker():
    with db.session.no_autoflush:
        EventText(message=None, sticker=1, image=None, **request.json).run()
    return 'ok', 204


@app.route('/image', methods=['POST'])
def event_image():
    with db.session.no_autoflush:
        EventText(message=None, sticker=None, image=1, **request.json).run()
    return 'ok', 204


@app.route('/follow', methods=['POST'])
def event_follow():
    bots[request.json['bot_id']].push(to=request.json['user_id'], reply_token=request.json['reply_token'], messages=text['加入好友'])
    return 'ok', 204


@app.route('/unfollow', methods=['POST'])
def event_unfollow():
    return 'ok', 204


@app.route('/join', methods=['POST'])
def event_join():
    bots[request.json['bot_id']].push(to=request.json['group_id'], reply_token=request.json['reply_token'], messages=text['加入群組'])
    return 'ok', 204


@app.route('/leave', methods=['POST'])
def event_leave():
    return 'ok', 204


@app.route('/postback', methods=['POST'])
def event_postback():
    return 'ok', 204



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
