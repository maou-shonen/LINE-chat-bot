import os
from time import time
from datetime import datetime
from flask import render_template, redirect, request, jsonify, abort, session, Response
from app import app
from database import db, WebUI, User, UserKeyword, UrlShortener
from line_login import line_login_url


@app.route('/')
def index():
    if 'uid' not in session:
        return redirect(line_login_url)

    if User.query.get(session['uid']) is None:
        abort(403)
        abort(Response('沒有認證的帳號'))

    if WebUI.query.get(session['uid']) is None:
        db.session.add(WebUI(session['uid']))
        db.session.commit()

    return render_template('index.html')


@app.route('/templates/<path>')
def templates(path):
    if os.path.exists('./templates/%s' % path):
        return render_template(path)
    abort(404)


@app.route('/api/control', methods=['POST'])
def control():
    key = request.json.get('key')
    val = request.json.get('val')

    if key not in ['token', 'uid', 'gid']:
        session[key] = val

    print(session)
    
    return 'ok'


@app.route('/api/keyword/<method>', methods=['POST'])
def api_keyword(method):
    if 'token' not in session:
        abort(400)

    uid = session['uid'] #request.args.get('user_id')
    wd = WebUI.query.get(uid)
    keyword_mode = request.json.get('mode')
    _id = uid if keyword_mode == '個人' else wd.gid if wd and (datetime.now()-wd.gid_timeout).total_seconds() < 0 else None
    
        
    if method == 'get':
        if _id is None:
            return jsonify({
                'result':[],
                'total':0,
            })

        keywords = UserKeyword.get(_id)
        page = int(request.json.get('page', 1)) - 1
        length = int(request.json.get('length', len(keywords)))
        search = request.json.get('search', '')

        keywords.reverse()

        results = []
        for row in keywords:
            if search == '' or search in row.keyword or search in row.reply:
                results.append({
                    #'id':row._id,
                    'keyword':row.keyword,
                    'reply':row.reply,
                })

        return jsonify({
            'result':results[page*length : page*length+length],
            'total':len(results),
        })

    if method == 'add':
        keyword = request.json.get('keyword')
        reply = request.json.get('reply')

        try:
            UserKeyword.add_and_update(_id, uid, keyword, reply)
            db.session.commit()

            return 'ok'
        except Exception as e:
            abort(400)
            abort(Response(str(e)))

    if method == 'edit':
        old_keyword = request.json.get('old_keyword')
        keyword = request.json.get('keyword')
        reply = request.json.get('reply')

        try:
            if UserKeyword.add_and_update(_id, uid, keyword, reply):
                UserKeyword.delete(_id, uid, old_keyword)
            db.session.commit()

            return 'ok'
        except Exception as e:
            abort(400)
            abort(Response(str(e)))
        
    if method == 'delete':
        keyword = request.json.get('keyword')

        try:
            UserKeyword.delete(_id, uid, keyword)
            db.session.commit()

            return 'ok'
        except Exception as e:
            abort(400)
            abort(Response(str(e)))

#########################################################
# 短連結
@app.route('/l/<url>')
def link(url):
    row = UrlShortener.query.get(url)
    if row is None:
        return '連結已經過期'
    print('302 to %s' % row.url)
    return redirect(row.url)
