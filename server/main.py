import os
import sys
from time import time

from api import cfg
from app import app, request, abort
from database import db, MessageLogs
from LineBot import bots
from event_text import EventText


@app.route("/text", methods=['POST'])
def event_text():
    start_time = time()

    try:
        reply_message = EventText(**request.json).run()
    except Exception as e:
        bots[request.json['bot_id']].reply_message(request.json['reply_token'], '愛醬出錯了！\n作者可能會察看此錯誤報告')

        e_type, e_value, e_traceback = sys.exc_info()
        bots['admin'].send_message(cfg['admin_line'], '<愛醬BUG>\ntype:%s\nvalue:%s\nfile:%s\nfunc:%s\nline:%s' % (
            str(e_type),
            str(e_value),
            str(e_traceback.tb_frame.f_code.co_filename),
            str(e_traceback.tb_frame.f_code.co_name),
            str(e_traceback.tb_lineno),
        ))
        raise e
        abort(400)

    if len(reply_message) == 0:
        abort(400)
    return reply_message
    

@app.route("/sticker", methods=['POST'])
def event_sticker():
    MessageLogs.add(request.json['group_id'], request.json['user_id'], nSticker=1)
    db.session.commit()
    return ''


@app.route("/image", methods=['POST'])
def event_image():
    MessageLogs.add(request.json['group_id'], request.json['user_id'], nImage=1)
    db.session.commit()
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
    DEBUG = os.environ.get('debug', 'False') == 'True'
    port = debug = int(os.environ.get('port')) if 'port' in os.environ else cfg['flask']['port']

    app.run(
        host='0.0.0.0',
        port=port,
        threaded=True,
        debug=DEBUG,
    )
