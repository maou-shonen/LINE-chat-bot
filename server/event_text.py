import yaml
import requests
from time import time
from random import choice, randint, uniform
from datetime import datetime, timedelta
from hashlib import md5

from api import (
    cfg,
    ConfigFile,
    isValueHaveKeys, is_image_and_ready, str2bool, isFloat,
)
from database import db, UserKeyword, UserSettings, MessageLogs
from other import google_shorten_url
from LineBot import bots


UserSettings_temp = ConfigFile('.UserSettings_temp.tmp')


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
            if reply_message is None:
                reply_message = []
            if type(reply_message) == str:
                reply_message = [reply_message]
                
            if group_id is not None and UserSettings.check_news(group_id):
                reply_message.append(''.join([cfg['公告']['ver'], ' ', cfg['公告']['內容']]))

            for mid in [user_id, group_id]:
                if mid is not None and UserSettings_temp.has_option(mid, '臨時公告'):
                    reply_message.append(UserSettings_temp.get(mid, '臨時公告'))
                    UserSettings_temp.remove_option(mid, '臨時公告')
                    UserSettings_temp.save()

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


@event_register('公告')
def event_push(bot_id, group_id, user_id, message, key, value, **argv):
    if user_id != cfg['admin_line']:
        return None
    if value is None:
        return '參數錯誤\n[公告=對象=內容]'
    UserSettings_temp.set(key, '臨時公告', value)
    UserSettings_temp.save()
    return 'ok'


@event_register('愛醬安靜', '愛醬閉嘴', '愛醬壞壞', '愛醬睡覺')
def event_pause(bot_id, group_id, user_id, message, key, value, **argv):
    if group_id is None:
        return '...'
    h = 6 if key is None or not key.isdigit() else int(key)
    t = time() + 60 * 60 * (72 if h > 72 else 1 if h < 1 else h)
    UserSettings_temp.set(group_id, '暫停', str(t))
    UserSettings_temp.save()
    return '愛醬不理你們了！愛醬睡覺去\n(%s)' % (datetime.fromtimestamp(t).strftime('%Y-%m-%d %H:%M'))


@event_register('愛醬講話', '愛醬說話', '愛醬聊天', '愛醬乖乖', '愛醬起床')
def event_continue(bot_id, group_id, user_id, message, key, value, **argv):
    if group_id is None:
        return '...'
    UserSettings_temp.remove_option(group_id, '暫停')
    UserSettings_temp.save()
    return '愛醬大復活！'


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
        break #如果全部都檢查時間會太久 只幫第一個檢查格式 通常使用者圖床也會使用同一個 應該不會有問題

    reply_message = ['<%s>記住了喔 ' % key]

    if group_id is not None and UserKeyword.add_and_update(group_id, user_id, key, value):
        reply_message.append('(群組)')

    if user_id is not None and UserKeyword.add_and_update(user_id, user_id, key, value):
        reply_message.append('(個人)')
    else:
        reply_message.append('(不儲存個人)\nhttps://goo.gl/bN3JnT')
        
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
                weight_total = 0
                result_pool = {}
                minimum_pool = []
                for msg in reply_message.split('__'):
                    if msg == '':
                        continue

                    index = msg.rfind('%')
                    if index > -1 and isFloat(msg[index+1:].strip()):
                    #if index > -1 and msg[index+1:].strip().isdigit():
                        weight = float(msg[index+1:].strip())
                        msg = msg[:index]
                    else:
                        weight = 1
                    weight_total += weight

                    is_minimum = msg[:1] == '*'
                    if is_minimum:
                        is_minimum_pool = msg[:2] == '**'
                        msg = msg[2:] if is_minimum_pool else msg[1:]

                    result_pool[msg] = {
                        'weight':weight,
                        'is_minimum':is_minimum,
                    }
                    if is_minimum and is_minimum_pool:
                        minimum_pool.append(msg)

                count = int(message[message.rfind('*')+1:]) if '*' in message and message[message.rfind('*')+1:].isdigit() else 1
                if count > 10000: count = 10000
                if count <  1: count = 1
                if count > 1:
                    if '種子' in opt and opt['種子'].isdigit() and int(opt['種子']) > 0:
                        seed_time = int((datetime.now()-datetime(2017,1,1)).days * 24 / int(opt['種子']))
                        seed = int(md5((str(user_id) + str(seed_time)).encode()).hexdigest().encode(), 16) % weight_total
                    else:
                        try:
                             #random.org的隨機比較接近真隨機
                            seed = requests.get('https://www.random.org/integers/?num=%s&min=0&max=%s&col=1&base=10&format=plain&rnd=new' % (count, weight_total), timeout=3).text.split('\n')[:-1]
                        except:
                            seed = [uniform(0, weight_total) for i in range(count)]
                else:
                    seed = [uniform(0, weight_total) for i in range(count)]

                minimum_count = 0
                minimum_index = int(opt.get('保底', 10))
                reply_message_new = {}
                reply_message_image = []
                for i in range(count):
                    #r = uniform(0, weight_total) if seed == -1 else seed
                    r = float(seed[i]) if type(seed) == list else seed
                    for msg, msg_opt in result_pool.items():
                        if r > msg_opt['weight']:
                            r -= msg_opt['weight']
                        else:
                            minimum_count = 0 if msg_opt['is_minimum'] else minimum_count + 1
                            if minimum_count >= minimum_index and len(minimum_pool) > 0:
                                minimum_count = 0
                                msg = choice(minimum_pool)
                            if msg[:6] == 'https:':
                                reply_message_image.append(msg)
                                if len(reply_message_image) > 5:
                                    break
                            else:
                                reply_message_new[msg] = (reply_message_new[msg] + 1) if msg in reply_message_new else 1
                            break
                
                if len(reply_message_new) > 0:
                    if count == 1:
                        reply_message = list(reply_message_new.keys())
                    else:
                        reply_message = []
                        for msg, num in reply_message_new.items():
                            reply_message.append('%s x %s' % (msg, num))
                        reply_message = ['\n'.join(reply_message)]
                else:
                    reply_message = []
                reply_message.extend(reply_message_image[:5])
                
            #這邊有待優化
            if type(reply_message) == str:
                reply_message = [reply_message]
            reply_message_new = []
            for msg in reply_message:
                for msg_split in msg.split('||'):
                    reply_message_new.append(msg_split)
            return reply_message_new
            
        message = message.lower()
        if 'http:' in message or 'https:' in message: #如果內容含有網址 不觸發 順便紀錄
            MessageLogs.add(group_id, user_id, nUrl=1) #紀錄次數
            return None
        else:
            MessageLogs.add(group_id, user_id, nText=1, nFuck=(message.count('幹') + message.count('fuck')), nLenght=len(message)) #紀錄次數

        if UserSettings_temp.has_option(group_id, '暫停'):
            if time() > UserSettings_temp.getfloat(group_id, '暫停'):
                UserSettings_temp.remove_option(group_id, '暫停')
                UserSettings_temp.save()
                return '愛醬大復活！'
            else:
                return None

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
            for k in UserKeyword.query.filter_by(super=0, keyword=message).order_by(UserKeyword._id.desc()):
                return later(k.reply)

    else:
        message = message.strip()
        if message[:4] == 'http':
            return '愛醬幫你申請短網址了喵\n%s' % google_shorten_url(message)
        else:
            return '群組指令說明輸入-?\n個人服務:\n直接傳給愛醬網址即可產生短網址\n直接傳圖給愛醬即可上傳到圖床\n其他功能如果有建議請使用回報'

