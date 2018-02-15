import jwt
import json
import requests
from time import time
from datetime import timedelta
from hashlib import sha256
from api import cfg
from flask import Flask, request, redirect, session, url_for
from app import app


app.secret_key = cfg['secret_key']

clannel_id = cfg['line_login']['clannel_id']
clannel_secret = cfg['line_login']['clannel_secret']
login_url = 'http://%s/login' % (cfg['web_url'])

line_login_url = 'https://access.line.me/oauth2/v2.1/authorize?' + '&'.join([
    'redirect_uri=%s' % login_url,
    'client_id=%s' % clannel_id,
    'response_type=code',
    'scope=openid+profile',
    'state=%s' % cfg['line_login']['state'],
    'nonce=%s' % cfg['line_login']['nonce'],
    'bot_prompt=normal',
])


@app.route('/login')
def login():
    code = request.args.get('code')
    state = request.args.get('state')
    error = request.args.get('error', None)

    if error is not None:
        return '登入失敗=%s' % error

    token_time = time()
    headers = {'Content-Type': 'application/x-www-form-urlencoded'}
    token = requests.post('https://api.line.me/oauth2/v2.1/token', headers=headers, data={
        'redirect_uri':login_url,
        'client_id':clannel_id,
        'client_secret':clannel_secret,
        'grant_type':'authorization_code',
        'code':code,
    })

    token = json.loads(token.text)
    if 'error' in token:
        return '登入失敗=%s' % token.get('error_description')
    
    token_id = jwt.decode(token['id_token'], clannel_secret, audience=clannel_id, issuer='https://access.line.me', algorithms=['HS256'])
    if token_id['iss'] != 'https://access.line.me': return '驗證失敗1'
    if token_id['aud'] != clannel_id: return '驗證失敗2'
    if token_id['nonce'] != cfg['line_login']['nonce']: return '驗證失敗3'
    if token_id['exp'] < token_time: return '驗證失敗4'

    token = sha256((cfg['line_login']['state'] + token_id['sub']).encode()).hexdigest()
    session['token'] = token

    session['uid'] = token_id['sub']
    #session['user_name'] = token_id['name']
    #session['user_picture'] = token_id['picture']

    #session['group_id'] = None if state == str(None) else state

    return redirect('/') #redirect('/g/%s' % session['group_id']) if 'group_id' in session else redirect('/')

'''
@app.before_request
def make_session_permanent(): #session 有效時間
    session.permanent = True
    app.permanent_session_lifetime = timedelta(days=7)

'''