import requests

data = {
    'reply_token' : '00000',
    'bot_id' : 'test',
    'group_id' : 'test',
    'user_id' : 'test',
}

while True:
    msg = input('msg=')
    data['message'] = msg
    r = requests.post('http://localhost:5000/text', json=data)
    if r.ok:
        print(r.text)
    else:
        print(r.status_code)