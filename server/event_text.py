import yaml
from time import time
from random import choice, randint, uniform
from datetime import datetime, timedelta
from hashlib import md5

from api import cfg
from database import db, UserKeyword, UserSettings, MessageLogs
from api import isValueHaveKeys, is_image_and_ready, str2bool
from other import google_shorten_url
from LineBot import bots


def event_text_main(bot_id, group_id, user_id, message, reply_token, **argv):
    #紀錄最後使用時間 用來移除過久無人使用的資料
    if group_id is not None: UserSettings.refresh_last_time(group_id)
    if  user_id is not None: UserSettings.refresh_last_time(user_id)

    message = message.replace('"', '＂').replace("'", '’').replace(';', '；') #替換一些字元成全型 防SQL注入攻擊
    order, *value = message.split('=')
    for key, func in event_funcs.items():
        if key == order or key == '':
            reply_message = func(
                bot_id = bot_id,
                group_id = group_id,
                user_id = user_id,
                message = message,
                key = (value[0] if len(value) > 0 else None),
                value = ('='.join(value[1:]) if len(value) > 1 else None),
                **argv)
            
            #公告
            if group_id is not None and UserSettings.check_news(group_id):
                if reply_message is None:
                    reply_message = cfg['公告']['內容']
                elif type(reply_message) == str:
                    reply_message = [reply_message, cfg['公告']['內容']]
                else:
                    reply_message.append(cfg['公告']['內容'])

            if reply_message is not None:
                bots[bot_id].reply_message(reply_token, reply_message)
            db.session.commit()
            return reply_message


event_funcs = {}
def event_register(*keywords):
    def outer_d_f(func):
        print('%s 註冊 %s' % (func, keywords))
        for keyword in keywords:
            event_funcs[keyword] = func
    return outer_d_f


@event_register('-?', '-h', 'help', '說明', '指令', '命令')
def event_help(bot_id, group_id, user_id, message, key, value, **argv):
    return cfg['指令說明']


@event_register()
def event_push(bot_id, group_id, user_id, message, key, value, **argv):
    #這裡要砍掉重練
    return ''


@event_register('-l', 'list', '列表')
def event_list(bot_id, group_id, user_id, message, key, value, **argv):
    if (group_id is None) or (key in cfg['詞組']['自己的']):
        return '、'.join([k.keyword for k in UserKeyword.get(user_id)])
    elif user_id is not None:
        return '、'.join([k.keyword for k in UserKeyword.get(group_id)]) \
                + '\n\n查詢個人關鍵字輸入 列表=我'


@event_register('-a', 'add', 'keyword', '新增', '關鍵字', '學習')
def event_add(bot_id, group_id, user_id, message, key, value, **argv):
    MessageLogs.add(group_id, user_id, nAIset=1) #紀錄次數
    if isValueHaveKeys(message, cfg['詞組']['髒話']):
        return '愛醬覺得說髒話是不對的!!'

    if key is None:
        return cfg['學習說明']

    key = key.lower()
    if value is None:
        reply_message = ['<%s>' % key]

        if group_id is not None:
            data = UserKeyword.get(group_id, key)
            if data is not None:
                reply_message.append('群組=%s' % data.reply)
        
        if user_id is not None:
            data = UserKeyword.get(user_id, key)
            if data is not None:
                reply_message.append('個人=%s' % data.reply)

        return '\n'.join(reply_message) if len(reply_message) > 1 else '喵喵喵? 愛醬不記得<%s>' % (key)

    while '***' in key: key = key.replace('***', '**')
    while '|||' in key: key = key.replace('|||', '||')
    while '___' in key: key = key.replace('___', '__')
        
    for i in value.replace('__', '||').split('||'):
        i = i.strip()
        if i[:4] == 'http' and not is_image_and_ready(i):
            return '<%s>\n愛醬發現圖片網址是錯誤的\n請使用格式(jpg, png)\n短網址或網頁嵌圖片可能無效\n必須使用https' % i

    reply_message = ['<%s>記住了喔 ' % key]

    if group_id is not None and UserKeyword.add_and_update(group_id, user_id, key, value):
        reply_message.append('(群組)')

    if user_id is not None and UserKeyword.add_and_update(user_id, user_id, key, value):
        reply_message.append('(個人)')
    else:
        reply_message.append('\n授權不足 不存入個人關鍵字')
        
    return ''.join(reply_message)


@event_register('-d', 'delete', 'del', '刪除', '移除', '忘記', '遺忘')
def event_delete(bot_id, group_id, user_id, message, key, value, **argv):
    MessageLogs.add(group_id, user_id, nAIset=1) #紀錄次數
    if key is None:
        return '格式:\n刪除=<關鍵字>'

    reply_message = ['<%s>刪除了喔 ' % (key)]

    if group_id is not None and UserKeyword.delete(group_id, key):
        reply_message.append('(群組)')

    if user_id is not None and UserKeyword.delete(user_id, key):
        reply_message.append('(個人)')
        
    return ''.join(reply_message) if len(reply_message) > 1 else '喵喵喵? 愛醬不記得<%s>' % (key)


@event_register('-o', 'opinion', '意見', '建議', '回報', '檢舉')
def event_opinion(bot_id, group_id, user_id, message, key, value, **argv):
    MessageLogs.add(group_id, user_id, nAIset=1) #紀錄次數
    if key is None:
        return '愛醬不知道你想..回報什麼?'
    try:
        bots['admin'].send_message(cfg['admin_line'], '%s\n%s\n%s\n%s' % (bot_id, group_id, user_id, message))
        return '訊息已經幫你傳給主人了\n(如果有問題請描述)'
    except Exception as e:
        return '訊息傳送失敗..%s' % str(e)


@event_register('-s', 'set', 'settings', '設定', '設置')
def event_set(bot_id, group_id, user_id, message, key, value, **argv):
    MessageLogs.add(group_id, user_id, nAIset=1) #紀錄次數
    if group_id is None:
        return '目前沒有個人設定喵'
    else:
        if key == '全群組關鍵字':
            UserSettings.update(group_id, all_group_keyword=str2bool(value))
            return '設定完成'
        else:
            return (
                '目前可使用:'
                '設定=全群組關鍵字=開啟/關閉\n(可以使用別的群組的關鍵字)')



MessageLogs_texts = yaml.load(open('logs.yaml', 'r', encoding='utf-8-sig'))
@event_register('log', 'logs', '紀錄', '回憶')
def event_log(bot_id, group_id, user_id, message, key, value, **argv):
    if group_id is None:
        return '個人版目前還沒開放喔'
    else:
        reply_message = []
        if key is not None and key.lower() in cfg['詞組']['全部']:
            data = MessageLogs.get(group_id)
            reply_message.append('愛醬記得這個群組...')
            reply_message.append('有 %s 個人說過話' % data['users'])
            reply_message.append('愛醬被調教 %s 次' % data['nAIset'])
            reply_message.append('跟愛醬說話 %s 次' % data['nAItrigger'])
            reply_message.append('有 %s 次對話' % data['nText'])
            reply_message.append('有 %s 次貼圖' % data['nSticker'])
            reply_message.append('有 %s 次傳送門' % data['nUrl'])
            reply_message.append('講過 %s 次「幹」' % data['nFuck'])
            reply_message.append('總計 %s 個字\n' % data['nLenght'])

        def get_messagelogs_max(MessageLogs_type):
            for row in MessageLogs.query.filter_by(group_id=group_id).order_by(eval('MessageLogs.%s' % MessageLogs_type).desc()):
                if row.user_id is not None:
                    try:
                        user_name = bots[bot_id].get_group_member_profile(group_id, row.user_id).display_name
                        return [MessageLogs_texts[MessageLogs_type]['基本'].replace('<user>', user_name).replace('<value>', str(eval('row.%s' % MessageLogs_type))),
                                choice(MessageLogs_texts[MessageLogs_type]['額外'])]
                    except Exception as e:
                        return ['', '讀取錯誤=%s' % str(e)]
            return ['', '']

        rnd = randint(1, 7)
        if   rnd == 1: reply_message_random = get_messagelogs_max('nAIset')
        elif rnd == 2: reply_message_random = get_messagelogs_max('nAItrigger')
        elif rnd == 3: reply_message_random = get_messagelogs_max('nText')
        elif rnd == 4: reply_message_random = get_messagelogs_max('nSticker')
        elif rnd == 5: reply_message_random = get_messagelogs_max('nUrl')
        elif rnd == 6: reply_message_random = get_messagelogs_max('nFuck')
        elif rnd == 7: reply_message_random = get_messagelogs_max('nLenght')
        reply_message.append(reply_message_random[0])

        reply_message.append('(完整紀錄輸入「回憶=全部」)\n(如果想寫愛醬文本請回報)')
        return ['\n'.join(reply_message), reply_message_random[1]]


@event_register('短網址')
def event_shorten_url(bot_id, group_id, user_id, message, key, value, **argv):
    MessageLogs.add(group_id, user_id, nAItrigger=1) #紀錄次數
    return '愛醬幫你申請短網址了喵\n%s' % google_shorten_url(message.replace('短網址=', ''))


#from Webtorrent import Webtorrent, WebtorrentIsExistException
@event_register('bt', 'BT', '開車', '飆車')
def event_bt(bot_id, group_id, user_id, message, key, value, **argv):
    return '開車功能暫時關閉'

@event_register('停車', '煞車')
def event_bt_stop(bot_id, group_id, user_id, message, key, value, **argv):
    return None


import feedparser
from urllib.parse import urlencode
@event_register()
def event_rss(bot_id, group_id, user_id, message, key, value, **argv):
    return cfg['搜尋說明']

@event_register('動漫花園', 'dmhy')
def event_rss_dmhy(bot_id, group_id, user_id, message, key, value, **argv):
    if key is None:
        return cfg['文檔']['動漫花園']
    elif value is None:
        q = key
        size = 1
    else:
        try:
            size = int(key)
            size = size if size <= 5 else 5
        except:
            size = 1
        q = value
    
    rss = feedparser.parse('https://share.dmhy.org/topics/rss/rss.xml?%s' % (urlencode({
        'keyword' : q
    })))
    d = []
    for i in rss['entries'][:size]:
        d.append('%s\n\n%s\n' % (i['title'], i['links'][1]['href'].split('&')[0]))
    if len(d) > 0:
        return d
    return cfg['回應']['找不到']

@event_register('nyaa')
def event_rss_nyaa(bot_id, group_id, user_id, message, key, value, **argv):
    if key is None:
        return cfg['文檔']['nyaa']
    elif value is None:
        q = key
        size = 1
    else:
        try:
            size = int(key)
            size = size if size <= 5 else 5
        except:
            size = 1
        c = '0_0'
        q = value
    
    rss = feedparser.parse('https://nyaa.si/?%s' % (urlencode({
        'page' : 'rss',
        'c' : '0_0',
        'f': 0,
        'q' : q
    })))
    d = []
    for i in rss['entries'][:size]:
        d.append('%s\n\n%s\n種子:%s' % (i['title'], i['nyaa_infohash'], i['nyaa_seeders']))
    if len(d) > 0:
        return d
    return cfg['回應']['找不到']

@event_register('nyaa2', 'sukebei')
def event_rss_nyaa2(bot_id, group_id, user_id, message, key, value, **argv):
    if key is None:
        return cfg['文檔']['nyaa2']
    elif value is None:
        q = key
        size = 1
    else:
        try:
            size = int(key)
            size = size if size <= 5 else 5
        except:
            size = 1
        c = '0_0'
        q = value
    
    rss = feedparser.parse('https://sukebei.nyaa.si/?%s' % (urlencode({
        'page' : 'rss',
        'c' : '0_0',
        'f': 0,
        'q' : q
    })))
    d = []
    for i in rss['entries'][:size]:
        d.append('%s\n\n%s\n種子:%s' % (i['title'], i['nyaa_infohash'], i['nyaa_seeders']))
    if len(d) > 0:
        return d
    return cfg['回應']['找不到']


@event_register('')
def event_main(bot_id, group_id, user_id, message, key, value, **argv):
    if group_id is not None:
        #後處理
        def later(reply_message):
            MessageLogs.add(group_id, user_id, nAItrigger=1) #紀錄次數

            #取參數
            opt = {}
            if '##' in reply_message:
                reply_message_new = []
                for i in reply_message.split('##'):
                    if '=' in i:
                        a, *b = i.split('=')
                        opt[a] = '='.join(b)
                    else:
                        reply_message_new.append(i)
                reply_message = ''.join(reply_message_new)

            #隨機 (算法:比重)
            if '__' in reply_message:
                msg_arr = []
                msg_weight = 0

                minimum = True
                minimum_pool = []
                minimum_pool_get = []
                for msg in reply_message.split('__'):
                    #分析保底池
                    def minimum_pool_add(msg):
                        if msg[:2] == '**':
                            msg = msg[2:]
                            minimum_pool.append(msg)
                            minimum_pool_get.append(msg)
                        elif msg[:1] == '*':
                            msg = msg[1:]
                            minimum_pool.append(msg)
                        return msg

                    #分析比重
                    index = msg.rfind('%')
                    if index > -1 and msg[index+1:].strip().isdigit():
                        weight = int(msg[index+1:].strip())
                        msg_arr.append([minimum_pool_add(msg[:index]), weight])
                    else:
                        weight = 1
                        msg_arr.append([minimum_pool_add(msg), weight])
                    msg_weight += weight

                if '種子' in opt and opt['種子'].isdigit() and int(opt['種子']) > 0:
                    seed_time = int((datetime.now()-datetime(2017,1,1)).days * 24 / int(opt['種子']))
                    seed = int(md5((str(user_id) + str(seed_time)).encode()).hexdigest().encode(), 16) % msg_weight
                    count = 1
                else:
                    seed = 0
                    count = int(message[message.rfind('*')+1:]) if '*' in message and message[message.rfind('*')+1:].isdigit() else 1
                    if count > 20: count = 20
                    if count <  1: count = 1

                reply_message_new = []
                for i in range(count):
                    r = uniform(0, msg_weight) if seed == 0 else seed
                    for msg, weight in msg_arr:
                        if r <= weight:
                            if msg in minimum_pool:
                                minimum = False #抽中保底池 保底取消
                            if count > 1: reply_message_new.extend([str(i+1), '. '])
                            reply_message_new.extend([msg, '\n'])
                            break
                        else:
                            r -= weight
                if minimum and count >= int(opt.get('保底', 10)) and len(minimum_pool_get) > 0:
                     reply_message_new[-2] = choice(minimum_pool_get)
                reply_message = ''.join(reply_message_new)
                
            if '||' in reply_message: reply_message = reply_message.split('||')
            return reply_message
            
        message = message.lower()
        if 'http:' in message or 'https:' in message: #如果內容含有網址 不觸發 順便紀錄
            MessageLogs.add(group_id, user_id, nUrl=1) #紀錄次數
            return None
        else:
            MessageLogs.add(group_id, user_id, nText=1, nFuck=(message.count('幹') + message.count('fuck')), nLenght=len(message)) #紀錄次數

        if group_id is not None:
            reply_message = UserKeyword.get(group_id, message)
            if reply_message is not None:
                return later(reply_message.reply)
        
        if user_id is not None:
            reply_message = UserKeyword.get(user_id, message)
            if reply_message is not None:
                return later(reply_message.reply)

        keys = []
        if group_id is not None:
            for i in UserKeyword.get(group_id):
                keys.append((i.keyword, i.reply))
        if user_id is not None:
            for i in UserKeyword.get(user_id):
                keys.append((i.keyword, i.reply))

        for k, v in keys:
            kn = -1
            k_arr = k.split('**')
            for k2 in k_arr:
                if k2 != '':
                    n = message.find(k2)
                    if n > kn:
                        kn = n
                    else:
                        break
                #最後檢查前後如果為任意字元的情況 那相對的最前最後一個字元必須相等 雖然使用字串會比較精準 暫時先用一個字元 如果**混在中間有可能誤判 但是問題不大
                if k_arr[0] != '' and message[0] != k[0]: break
                if k_arr[-1] != '' and message[-1] != k[-1]: break
            else:
                return later(v)

        #使用全群組的關鍵字 限無**
        if UserSettings.get(group_id, 'all_group_keyword', False):
            for k in UserKeyword.query.filter_by(super=0, keyword=message).order_by(Keyword._id.desc()):
                return later(k.reply)

    else:
        message = message.strip()
        if message[:4] == 'http':
            return '愛醬幫你申請短網址了喵\n%s' % google_shorten_url(message)
        else:
            return '群組指令說明輸入-?\n個人服務:\n直接傳給愛醬網址即可產生短網址\n直接傳圖給愛醬即可上傳到圖床\n其他功能如果有建議請使用回報'

