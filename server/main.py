import os
import sys
from time import time

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
        try:
            push_developer('<愛醬BUG>\n%s' % str(e))
            bots[request.json['bot_id']].push(to=request.json['group_id'], reply_token=request.json['reply_token'], messages='愛醬出錯了！\n作者可能會察看此錯誤報告')
        except:
            print('傳送失敗')
        db.session.commit()
        raise e

    if len(reply_message) == 0:
        abort(400)
    return '\n'.join(reply_message)
    

@app.route('/sticker', methods=['POST'])
def event_sticker():
    with db.session.no_autoflush:
        EventText(message=None, sticker=1, image=None, **request.json).run()
    return 'ok'


@app.route('/image', methods=['POST'])
def event_image():
    with db.session.no_autoflush:
        EventText(message=None, sticker=None, image=1, **request.json).run()
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

from other import imgur
@app.route('/test', methods=['POST'])
def test():
    print('-----test-----')
    print(request.json)
    bot = bots[request.json['bot_id']]
    url = imgur.uploadByLine(bot, request.json['message_id'])
    bot.push(to=request.json['user_id'], reply_token=request.json['reply_token'], messages=url)
    return 'ok'


if __name__ == '__main__':
    DEBUG = os.environ.get('debug', 'False') == 'True'
    port = debug = int(os.environ.get('port')) if 'port' in os.environ else cfg['flask']['port']

    import web_api

    app.run(
        host='0.0.0.0',
        port=port,
        threaded=True,
        debug=DEBUG,
    )
