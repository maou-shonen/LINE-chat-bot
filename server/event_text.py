import json
import yaml
import requests
from time import time
from random import choice, randint, uniform, sample
from datetime import datetime, timedelta
from hashlib import md5

from api import (
    cfg, text,
    ConfigFile,
    isValueHaveKeys, is_image_and_ready, str2bool, isFloat,
)
from database import db, UserStatus, UserKeyword, UserSettings, MessageLogs
from other import google_shorten_url, ehentai_search, exhentai_search, google_search
from LineBot import bots
from module import * #google_safe_browsing

#未整理
UserSettings_temp = ConfigFile('.UserSettings_temp.tmp')
from database import User, Group


class EventText():
    def __init__(self, **argv):
        self.__dict__.update(**argv)

        #User 模組
        self.user = User.query.get(self.user_id) if self.user_id is not None else None
        if self.user_id is not None:
            if self.user is None:
                self.user = User(self.user_id)
                db.session.add(self.user)

        #Group 模組
        self.group = Group.query.get(self.group_id) if self.group_id is not None else None
        if self.group_id is not None:
            if self.group is None:
                self.group = Group(self.group_id)
                db.session.add(self.group)
            self.group._json() #mariaDB還沒有支援json格式 只好自行轉換

        #文本分類
        if self.message:
            self.message = self.message.replace('"', '＂').replace("'", '’').replace(';', '；') #替換一些字元成全型 防SQL注入攻擊
            self.order, *self.value = self.message.split('=')
            self.order = self.order.lower()
            self.key = self.value[0].strip(' \n') if len(self.value) > 0 else None
            self.value = '='.join(self.value[1:]).strip(' \n') if len(self.value) > 1 else None


    def _count(self, values):
        '''
            使用者對話計數
            values只接受dict 由於使用中文 不用**argv
        '''
        if self.group is None:
            return

        user_id = self.user.id if self.user else 'None'
        if user_id not in self.group.count:
            self.group.count[user_id] = {}.fromkeys(['調教', '觸發', '對話', '貼圖', '圖片', '網頁', '髒話', '字數'], 0)

        for key, value in values.items():
            self.group.count[user_id][key] += value


    def _send_message(self, to, message):
        '''
            對使用者傳送訊息
            由於不是每個bot都有send權限
            沒有的暫存到DB
        '''
        pass


    def run(self):
        '''
            接收發送訊息邏輯
        '''
        if self.message:
            print('%s@%s' % (self.user_id[1:5] if self.user_id else None, self.group_id), '>', self.message)

            t0 = time()
            reply_message = self.index()
            t1 = time() - t0

            #公告
            if reply_message is None:
                reply_message = []
            elif type(reply_message) == str:
                reply_message = [reply_message]
                    
            if UserStatus.check_news(self.group_id):
                reply_message.append(''.join([cfg['公告']['ver'], ' ', cfg['公告']['內容']]))

            for mid in [self.user_id, self.group_id]:
                if mid and UserSettings_temp.has_option(mid, '臨時公告'):
                    try:
                        user_name = bots[self.bot_id].get_group_member_profile(self.group_id, self.user_id).display_name if mid != self.group_id else ''
                    except:
                        user_name = ''
                    reply_message.append('<作者回覆%s>\n%s' % (user_name, UserSettings_temp.get(mid, '臨時公告')))
                    UserSettings_temp.remove_option(mid, '臨時公告')
                    UserSettings_temp.save()

            if len(reply_message) > 0:
                if self.bot_id:
                    bots[self.bot_id].reply_message(self.reply_token, reply_message)
                t2 = time() - t1 - t0
                print('%s@%s' % (self.user_id[1:5] if self.user_id else None, self.group_id), '<', reply_message, '(%dms, %dms)' % (t1*1000, t2*1000))
        elif self.sticker:
            reply_message = []
            self._count({'貼圖':1})
        elif self.image:
            reply_message = []
            self._count({'圖片':1})

        #刷新資料
        if self.user:
            try:
                self.user.name = bots[self.bot_id].get_group_member_profile(self.group.id, self.user.id).display_name
            except:
                pass
            self.user.update()
        if self.group:
            self.group.update()
        db.session.commit()

        return reply_message


    def index(self):
        if self.group:
            #群組才有的功能
            if   self.order in ['-s', 'set', 'settings', '設定', '設置']:
                return self.settings()
            elif self.order in ['愛醬安靜', '愛醬閉嘴', '愛醬壞壞', '愛醬睡覺']:
                return self.sleep()
            elif self.order in ['愛醬講話', '愛醬說話', '愛醬聊天', '愛醬乖乖', '愛醬起床', '愛醬起來']:
                return self.wake_up()
            elif self.order in ['log', 'logs', '紀錄', '回憶']:
                return self.logs()
        else:
            #1對1才有的功能
            pass

        if self.order in ['-?', '-h', 'help', '說明', '指令', '命令']:
            return text['指令說明']
        elif self.order in ['公告']:
            return self.push()
        elif self.order in ['-w', 'web', '網頁設定', '網頁設置']:
            return self.web()
        elif self.order in ['-l', 'list', '列表']:
            return self.list()
        elif self.order in ['-a', 'add', 'keyword', '新增', '關鍵字', '學習']:
            return self.add()
        elif self.order in ['-a+', 'add+', 'keyword+', '新增+', '關鍵字+', '學習+']:
            return self.add_plus()
        elif self.order in ['-d', 'delete', 'del', '刪除', '移除']:
            return self.delete()
        elif self.order in ['-o', 'opinion', '意見', '建議', '回報', '檢舉']:
            return self.opinion()
        elif self.order in ['google', 'goo']:
            return self.google()
        elif self.order in ['短網址']:
            return self.google_url_shortener()
        elif self.order in []: #'飆車'
            return self.bt()
        elif self.order in []: #'停車'
            return self.bt_stop()
        elif self.order in ['e-hentai', 'ehentai', 'e變態']:
            return self.ehentai()
        elif self.order in ['exhentai', 'ex變態']:
            return self.exhentai()
        elif self.order in ['weather', '天氣']:
            return self.weather()
        else:
            return self.main()


    def push(self):
        if self.user_id != cfg['admin_line']:
            return cfg['公告']['內容']
        if self.value is None:
            return '參數錯誤\n[公告=對象=內容]'
        UserSettings_temp.set(self.key, '臨時公告', self.value)
        UserSettings_temp.save()
        return 'ok'


    def sleep(self):
        '''
            愛醬睡覺
        '''
        h = int(self.key) if self.key and self.key.isdigit() else 12
        t = time() + 60 * 60 * (24*7 if h > 24*7 else 1 if h < 1 else h)
        UserSettings_temp.set(self.group_id, '暫停', str(t))
        UserSettings_temp.save()
        return '%s\n(%s)' % (text['睡覺'], datetime.fromtimestamp(t).strftime('%Y-%m-%d %H:%M'))


    def wake_up(self):
        '''
            愛醬起床
        '''
        if UserSettings_temp.has_option(self.group_id, '暫停'):
            UserSettings_temp.remove_option(self.group_id, '暫停')
            UserSettings_temp.save()
            return text['睡醒']
        else:
            return text['沒睡']


    def web(self):
        '''
            網頁設定
        '''
        if self.user is None:
            return text['權限不足']

        reply_message = []
        reply_message.append('<個人>\nline.maou.co:1234/u')
        if self.group:
            try:
                r = requests.post('http://127.0.0.1:1234/authorized', timeout=2, json={ #授權user可以操作本群組
                    'user_id':self.user.id,
                    'group_id':self.group.id,
                })
                reply_message.append('<群組>\nline.maou.co:1234/g/%s\n(30分鐘內有效)\n暫時只有關鍵字' % self.group.id)
            except Exception as e:
                bots['admin'].send_message(cfg['admin_line'], '<愛醬web卡死>\n%s' % (str(e)))
                reply_message.append('<群組>\n授權失敗 這是一個系統錯誤\n開發者會盡快修復')
        reply_message.append('如果有會前端JS的人願意幫忙修改\n請用「回報」功能聯絡我')

        return '\n\n'.join(reply_message)


    def list(self):
        '''
            列出關鍵字
        '''
        reply_message = []

        if self.group is None or self.key in cfg['詞組']['自己的']:
            if self.user is None:
                return text['權限不足']
            else:
                reply_message.append('現在群組中預設不使用個人詞庫\n有需要請用「設定」開啟')
                reply_message.append('\n'.join([k.keyword for k in UserKeyword.get(self.user.id)]))
        else:
            reply_message.append('「列表=我」查詢自己')
            reply_message.append('\n'.join([k.keyword for k in UserKeyword.get(self.group.id)]))

        reply_message.append('\n\n新功能實驗\n「網頁設定」')
        return '\n'.join(reply_message)


    def add(self, plus=False):
        '''
            新增關鍵字
        '''
        if self.key is None:
            return text['學習說明']

        self._count({'調教':1}) #紀錄次數

        #文字處理
        self.key = self.key.lower()
        while '***' in self.key:   self.key   = self.key.replace('***', '**')
        while '|||' in self.value: self.value = self.key.replace('|||', '||')
        while '___' in self.value: self.value = self.key.replace('___', '__')

        #查詢
        if self.value is None or self.value == '':
            reply_message = ['<%s>' % self.key]

            if self.group:
                row = UserKeyword.get(self.group.id, self.key)
                if row:
                    reply_message.append('群組=%s' % row.reply)
            
            if self.user:
                row = UserKeyword.get(self.user.id, self.key)
                if row:
                    reply_message.append('個人=%s' % row.reply)

            return '\n'.join(reply_message) if len(reply_message) > 1 else '%s<%s>' % (text['關鍵字查詢不到'], self.key)

        #新增
        ban_key = ['**', '** **', '愛醬**', '**愛醬**']
        if self.key in ban_key:
            return '%s\n%s' % (text['關鍵字禁用'], text['分隔符'].join(ban_key))

        if self.value[:2] == '##':
            return '由於規則問題 沒辦法使用##開頭的內容喔'

        if self.key != text['名稱'] and self.key[:2] == text['名稱']:
            self.key = self.key[2:].strip(' \n')
        
        #保護模式過濾 之後option寫入database將此邏輯合併計算中
        n = self.value.rfind('##')
        if n > -1 and '保護' in self.value[n:] and self.key[:2] == '**' and self.key[-2:] == '**':
            return '為了避免過度觸發\n保護模式關鍵字不接受前後**喔'

        reply_message = ['<%s>記住了喔 ' % self.key]

        try:
            if self.group:
                UserKeyword.add_and_update(self.group_id, self.user_id, self.key, self.value, plus=plus)
                reply_message.append('(群組)')

            if self.user:
                UserKeyword.add_and_update(self.user_id, self.user_id, self.key, self.value, plus=plus)
                reply_message.append('(個人)')
            else:
                reply_message.append('(不儲存個人)\n' + text['權限不足'])
                
        except Exception as e:
            return '學習失敗: %s' % str(e)

        level = len(self.key) - self.key.count('**')*(len('**')+1)  #database的UserKeyword.level 懶得改上面
        if level < 0:
            reply_message.append('\n愛醬非常不建議這種會過度觸發的詞喔\n請慎用')
        elif level == 0:
            reply_message.append('\n這種容易觸發的詞容易造成過多訊息喔\n請注意使用')
        elif level >= 7:
            reply_message.append('\n這種詞命中率較低喔 請善加利用萬用字元雙米號')

        if '*' in self.key and '**' not in self.key:
            reply_message.append('\n愛醬發現你似乎要使用萬用字元?\n如果是的話請把 *(單米號) 換成 **(雙米號)')
        if '_' in self.value and self.value.count('__') == 0:
            reply_message.append('\n愛醬發現你似乎要使用隨機模式?\n如果是的話請把 _(單底線) 換成 __(雙底線)')

        for i in self.value.replace('__', '||').split('||'):
            i = i.strip()
            if i[:4] == 'http' and not is_image_and_ready(i):
                reply_message.append('<%s>\n愛醬發現圖片網址是錯誤的\n請使用格式(jpg, png)\n短網址或網頁嵌圖片可能無效\n必須使用https' % i)
            break #如果全部都檢查時間會太久 只幫第一個檢查格式 通常使用者圖床也會使用同一個 應該不會有問題
    
        if self.group is None:
            reply_message.append('\n現在個人詞庫預設是不會在群組觸發的喔\n請在群組設定開啟全回應模式(預設開)或開啟個人詞庫(預設關)')
        else:
            #保護模式提醒 之後option寫入database將此邏輯合併計算中
            n = self.value.rfind('##')
            if n > -1 and '保護' in self.value[n:]:
                reply_message.append('\n(此為保護關鍵字 只有你可以刪除及修改 為了避免爭議 建議不要濫用)')
            
        return ''.join(reply_message) \
            + '\n\n新功能實驗\n「網頁設定」'


    def add_plus(self):
        '''
            新增關鍵字(疊加)
        '''
        if self.key is None:
            return text['學習說明+']

        return self.add(plus=True)
        
    
    def delete(self):
        '''
            刪除關鍵字
        '''
        if self.key is None:
            return '格式:\n刪除=<關鍵字>'

        self._count({'調教':1}) #紀錄次數

        if self.key != text['名稱'] and self.key[:2] == text['名稱']:
            self.key = self.key[2:].strip(' \n')

        self.key = self.key.lower()
        reply_message = ['<%s>刪除了喔 ' % (self.key)]

        try:
            if self.group and UserKeyword.delete(self.group_id, self.user_id, self.key):
                reply_message.append('(群組)')

            if self.user and UserKeyword.delete(self.user_id, self.user_id, self.key):
                reply_message.append('(個人)')
        except Exception as e:
            return '刪除失敗: %s' % str(e)
            
        return ''.join(reply_message) if len(reply_message) > 1 else '喵喵喵? 愛醬不記得<%s>' % (self.key) \
            + '\n\n新功能實驗\n「網頁設定」'


    def opinion(self):
        '''
            回報、建議、檢舉
        '''
        if self.key is None:
            return text['回報說明']

        self._count({'觸發':1}) #紀錄次數

        try:
            bots['admin'].send_message(cfg['admin_line'], '%s\n%s\n%s\n%s' % (self.bot_id, self.group_id, self.user_id, self.message))
            return text['回報完成']
        except Exception as e:
            return '訊息傳送失敗..%s' % str(e)


    def settings(self):
        '''
            設定
        '''
        if self.key is None:
            return [
                    '設定=別理我=開/關\n'
                    '設定=全回應=開/關\n'
                    '設定=全圖片=開/關(需要全回應)\n'
                    '設定=髒話過濾=開/關\n'
                    '設定=幫忙愛醬=開/關\n'
                    '\n'
                    '(不輸入值可查看說明)',

                    UserSettings.show(self.group_id, self.user_id)
                ]

        try:
            #全群組
            if self.key == '全回應' or self.key == '愛醬全回應':
                if self.value is None:
                    return '開啟後愛醬開頭的對話將從全部的詞庫中產生反應\n「預設:開」'
                UserSettings.update(self.group_id, None, {'全回應':str2bool(self.value)})
                return '設定完成'
            
            if self.key == '全圖片' or self.key == '愛醬全圖片':
                if self.value is None:
                    return '開啟後全回應的結果包含圖片\n(需要開啟全圖片)\n(注意:圖片沒有任何審核 有可能出現不適圖片 如可接受再開啟)\n「預設:關」'
                UserSettings.update(self.group_id, None, {'全圖片':str2bool(self.value)})
                return '設定完成'

            if self.key == '髒話過濾':
                if self.value is None:
                    return '關閉後回應如果有某些詞可以顯示\n「預設:開」'
                UserSettings.update(self.group_id, None, {'髒話過濾':str2bool(self.value)})
                return '設定完成'

            if self.key == '幫忙愛醬':
                if self.value is None:
                    return '開啟後會快取群組的對話紀錄\n只用於機器學習\n作者會稍微過目後進行分類丟入程式\n用完後刪除「預設:關」\n使用「設定=幫忙愛醬=開」開啟'
                UserSettings.update(self.group_id, None, {'幫忙愛醬':str2bool(self.value)})
                return '設定完成'

            #群組中個人
            if self.key == '別理我':
                if self.value is None:
                    return '開啟後愛醬不會在此群組對你產生回應\n(愛醬開頭還是可以強制呼叫)\n「預設:關」'
                if self.user_id is None:
                    return text['權限不足']
                UserSettings.update(self.group_id, self.user_id, {'別理我':str2bool(self.value)})
                return '設定完成'

            if self.key == '個人詞庫':
                if self.value is None:
                    return '開啟後會對你的個人詞庫產生回應\n「預設:關」'
                if self.user_id is None:
                    return text['權限不足']
                UserSettings.update(self.group_id, self.user_id, {'個人詞庫':str2bool(self.value)})
                return '設定完成'

            return '沒有此設定喔'
        except Exception as e:
            return '設定錯誤 <%s>' % str(e)

    
    def logs(self):
        '''
            回憶模式
        '''
        score_default = {
            '調教':30,
            '觸發':10,
            '對話':1,
            '貼圖':1,
            '網頁':0.5,
            '髒話':-100,
            '字數':0.1,
        }

        def _score(user_id):
            score = 0
            for key, value in score_default.items():
                try:
                    score += self.group.count['設定'][key] * self.group.count[user_id][key]
                except:
                    score += value * self.group.count[user_id][key]
            return score

        def _get(user):
            score = _score(user.id)

            return '\n'.join([
                '愛醬記得 %s' % (user.name if user.name else '你'),
                '調教愛醬 %s 次' % (self.group.count[user.id]['調教']),
                '跟愛醬說話 %s 次' % (self.group.count[user.id]['觸發']),
                '有 %s 次對話' % (self.group.count[user.id]['對話']),
                '有 %s 次貼圖' % (self.group.count[user.id]['貼圖']),
                '有 %s 次傳送門' % (self.group.count[user.id]['網頁']),
                '講過 %s 次「幹」' % (self.group.count[user.id]['髒話']),
                '總計 %s 個字' % (self.group.count[user.id]['字數']),
                '----------',
                '總分 %.0f' % (score if score > 0 else 0),
            ])

        if self.group is None:
            return '暫時還沒有個人回憶'

        if self.key in cfg['詞組']['自己的']:
            #查詢自己
            if self.user is None:
                return text['權限不足']

            if self.user.id not in self.group.count:
                self._count({}) #如果沒有任何紀錄刷新一筆空的進行初始化
            
            return _get(self.user)

        elif self.key in ['排名', '排行']:
            #排行榜
            rank = []
            for user, _ in self.group.count.items():
                if user is None or user == '設定':
                    continue
                user = User.query.get(user)
                if user is None:
                    continue
                score = _score(user.id)
                for u in rank[:5]:
                    if score > u['score']:
                        rank.insert(rank.index(u), {'user':user, 'score':score})
                        break
                else:
                    if len(rank) < 3:
                        rank.append({'user':user, 'score':score})

            if len(rank) < 3:
                return '你們群組說話的不足3人\n(沒有權限等同不存在)'

            n = 0
            reply_message = []
            for u in rank[:5]:
                n += 1
                reply_message.append('第%s名\n%s\n共 %s 分！' % (n, u['user'].name, int(u['score'])))
            return reply_message
            
        elif self.key in ['設定', '設置'] or self.key in list(score_default.keys()):
            #設定分數
            if self.value is None:
                values = []
                for key, value in score_default.items():
                    try:
                        values.append('%s = %s' % (key, self.group.count['設定'][key]))
                    except:
                        values.append('%s = %s' % (key, value))
                return '目前分數設定為:\n%s\n\n調整方法為\n「回憶=類型=值」\n栗子\n回憶=對話=5' % '\n'.join(values)
            else:
                if self.key not in list(score_default.keys()):
                    return '沒有<%s>類型' % (self.key)
                if '設定' not in self.group.count:
                    self.group.count['設定'] = {}
                self.group.count['設定'][self.key] = float(self.value)
                return '設定完成'

        elif self.key in cfg['詞組']['全部']:
            #查詢整群
            total = {}.fromkeys(['人數', '調教', '觸發', '對話', '貼圖', '圖片', '網頁', '髒話', '字數'], 0)
            for _, user in self.group.count.items():
                total['人數'] += 1
                for key, value in user.items():
                    total[key] += value

            return '\n'.join([
                '愛醬記得這個群組...',
                '有 %s 個人說過話' % total['人數'],
                '愛醬被調教 %s 次' % (total['調教']),
                '跟愛醬說話 %s 次' % (total['觸發']),
                '有 %s 次對話' % (total['對話']),
                '有 %s 次貼圖' % (total['貼圖']),
                '有 %s 次傳送門' % (total['網頁']),
                '講過 %s 次「幹」' % (total['髒話']),
                '總計 %s 個字' % (total['字數']),
            ])

        elif self.key:
            #查詢別人
            users = {}
            self.key = self.key.strip('@ \n')
            for user_id in self.group.count.keys():
                if user_id is None:
                    continue
                user = User.query.get(user_id)
                try:
                    if user is not None and self.key in user.name:
                        users[user_id] = user
                except:
                    pass

            if len(users) == 0:
                return '找不到 <%s>\n可能是\n1.名稱輸入錯誤\n2.該人沒有說過話\n3.權限不足' % (self.key)
            if len(users) > 1:
                return '查詢到 %s 人\n請輸入更完整的名稱' % (len(users))
            return _get(list(users.values())[0])

        return '\n'.join([
            '「回憶=我」　　查詢自己',
            '「回憶=全部」　查詢全部',
            '「回憶=<名字>」查詢別人',
            '「回憶=設定」　查詢設定',
            '(吐嘲暫時移除)',
        ])

    def google(self):
        '''
            google搜尋
        '''
        if self.key is None:
            return text['google說明']

        self._count({'觸發':1}) #紀錄次數
        #MessageLogs.add(self.group_id, self.user_id, nAIset=1) #紀錄次數

        return google_search(self.message[self.message.find('='):])

    
    def google_url_shortener(self):
        '''
            google短網址
        '''
        if self.key is None:
            return text['google短網址說明']

        self._count({'觸發':1}) #紀錄次數
        #MessageLogs.add(self.group_id, self.user_id, nAIset=1) #紀錄次數

        return '愛醬幫你申請短網址了喵\n%s' % google_shorten_url(self.message.replace('短網址=', ''))


    def bt(self):
        '''
            BT直播功能
        '''
        return '目前此功能關閉'


    def bt_stop(self):
        '''
            BT直播功能 停止
        '''
        return '目前此功能關閉'


    def ehentai(self):
        '''
            E變態搜尋
        '''
        if self.group_id is not None:
            return '暫時限制只能在1對1使用喔'

        if self.key is None:
            return text['ehentai說明']

        self._count({'觸發':1}) #紀錄次數
        #MessageLogs.add(self.group_id, self.user_id, nAIset=1) #紀錄次數

        return ehentai_search(self.key)


    def exhentai(self):
        '''
            EX變態搜尋
        '''
        if self.group_id is not None:
            return '暫時限制只能在1對1使用喔'

        if self.key is None:
            return text['exhentai說明']

        self._count({'觸發':1}) #紀錄次數
        #MessageLogs.add(self.group_id, self.user_id, nAIset=1) #紀錄次數

        return exhentai_search(self.key)


    def weather(self):
        if self.key is None:
            return text['天氣說明']

        return get_weather(self.key)


    def main(self):
        '''
            關鍵字觸發
        '''
        if 'http:' in self.message or 'https:' in self.message: #如果內容含有網址 做網址檢查
            if self.group:
                self._count({'網頁':1}) #紀錄次數
                return google_safe_browsing(self.message)
            else:
                return '愛醬幫你申請短網址了喵\n%s' % google_shorten_url(self.message)

        self.message = self.message.lower().strip(' \n') #調整內容 以增加觸發命中率
        self._count({
            '對話':1,
            '髒話':self.message.count('幹') + self.message.count('fuck'),
            '字數':len(self.message),
        })

        if self.message == '':
            return None
        
        #暫存訊息 用於對話模型訓練
        if self.group:
            with open('E:\\bot_log\\%s.log' % self.group_id, 'a+', encoding='utf-8') as f:
                f.write(self.message + '\n')

        #愛醬開頭可以強制呼叫
        if self.group:
            if self.message != text['名稱'] and self.message[:2] == text['名稱']:
                message_old = self.message
                self.message = self.message[2:].strip(' \n')
                reply_message = self.check(UserKeyword.get(self.group_id))
                if reply_message:
                    return reply_message

                reply_message = self.check(UserKeyword.get(self.user_id))
                if reply_message:
                    return reply_message
                self.message = message_old

        #睡覺模式
        if UserSettings_temp.has_option(self.group_id, '暫停'):
            if time() > UserSettings_temp.getfloat(self.group_id, '暫停'):
                UserSettings_temp.remove_option(self.group_id, '暫停')
                UserSettings_temp.save()
                return text['睡醒']
        #一般模式
        else:
            if self.group and self.user:
                if not UserSettings.get(self.group.id, self.user.id, '別理我', False): #檢查不理我模式
                    reply_message = self.check(UserKeyword.get(self.group.id))
                    if reply_message:
                        return reply_message

            if not self.group or (self.user and UserSettings.get(self.group.id, self.user.id, '個人詞庫', False)): #檢查是否使用個人詞庫
                reply_message = self.check(UserKeyword.get(self.user.id))
                if reply_message:
                    return reply_message

        #全回應模式
        if self.group is None or UserSettings.get(self.group_id, None, '全回應', default=True):
            if self.message[:2] == text['名稱'] or self.group_id is None:
                if self.message != text['名稱'] and self.message[:2] == text['名稱']: #做兩層是為了方便1對1不見得也要愛醬開頭
                    self.message = self.message[2:].strip(' \n')

                reply_message = self.check(UserKeyword.get(), all_reply=True)
                if reply_message:
                    return reply_message
                if self.group:
                    return choice(text['未知'])

        if self.group_id is None:
            return '群組指令說明輸入「指令」\n個人服務:\n直接傳給愛醬網址即可產生短網址\n直接傳圖給愛醬即可上傳到圖床\n<1:1自動開啟全回應與全圖片模式>\n其他功能如果有建議請使用回報'
        else:
            return None


    def check(self, userkeyword_list, all_reply=None):
        '''
            關鍵字觸發的邏輯檢查
        '''
        exclude_url = all_reply and not (not self.group or UserSettings.get(self.group.id, None, '全圖片', default=False))

        keys = []
        result = []

        for row in userkeyword_list:
            row_reply = row.reply
            
            if row_reply[:1] == '@': #全回應模式過濾開頭@
                if all_reply:
                    continue
                else:
                    row_reply = row.reply[1:]

            if exclude_url and 'https:' in row_reply: #全回應模式過濾網址只排除可能是圖片類型的
                continue

            if row.keyword.replace('**', '') == self.message:
                result.append(row_reply)
            else:
                keys.append((row.keyword, row_reply))

        if len(result) > 0:
            return self.later(choice(result)) #結果集隨機抽取一個
        
        results = {}
        result_level = -99
        for k, v in keys:
            try:
                kn = -1
                k_arr = k.split('**')
                for k2 in k_arr:
                    if k2 != '':
                        n = self.message.find(k2)
                        if n > kn:
                            kn = n
                        else:
                            break
                    #最後檢查前後如果為任意字元的情況 那相對的最前最後一個字元必須相等 雖然使用字串會比較精準 暫時先用一個字元 如果**混在中間有可能誤判 但是問題不大
                    if k_arr[0] != '' and self.message[0] != k[0]: break
                    if k_arr[-1] != '' and self.message[-1] != k[-1]: break
                else:
                    #result.append(v)
                    level = len(k) - k.count('**') - (2 if k[:2] == '**' else 0) - (2 if k[-2:] == '**' else 0)
                    if not level in results:
                        results[level] = []
                    if level > result_level:
                        result_level = level
                    results[level].append(v)
            except Exception as e:
                bots['開發部'].send_message(cfg['admin_line'], '錯誤:%s\ngid:%s\nuid:%s\nmsg:%s\nkey:<%s>\n<%s>' % (str(e), self.group_id, self.user_id, self.message, k, v))
                raise e

        if len(results) > 0:
            return self.later(choice(results[result_level]))

        return None


    def later(self, reply_message):
        '''
            關鍵字觸發的後處理
        '''
        self._count({'觸發':1})

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
            #reply_message = ''.join(reply_message_new)
            reply_message = reply_message[:reply_message.find('##')] #參數之後會由add儲存至database 這邊之後會廢棄

        filter_fuck = self.group_id is not None and UserSettings.get(self.group_id, None, '髒話過濾', True)
        if filter_fuck and isValueHaveKeys(self.message, cfg['詞組']['髒話']):
            return '愛醬是好孩子不說髒話!!\n(可用「設定」關閉)'

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

            if opt.get('百分比', '0').isdigit(): #百分比隨機模式
                number = int(opt.get('百分比', '0'))
                if number > 0:
                    reply_message = []
                    total = 100.0

                    if number > len(result_pool):
                        number = len(result_pool)
                    result_pool = sample([msg for msg, msg_opt in result_pool.items()], number)

                    n = 0
                    for msg in result_pool:
                        n += 1
                        if n >= number or n >= len(result_pool):
                            ratio = total
                            total = 0
                        else:
                            ratio = uniform(0, total)
                            total -= ratio
                        reply_message.append('%s（%3.2f％）' % (msg, ratio))
                        if total <= 0:
                            break

                    return '\n'.join(reply_message)

            count = int(self.message[self.message.rfind('*')+1:]) if '*' in self.message and self.message[self.message.rfind('*')+1:].isdigit() else 1
            if count > 10000: count = 10000
            if count <  1: count = 1
            if count == 1 and '種子' in opt and opt['種子'].isdigit() and int(opt['種子']) > 0:
                seed_time = int((datetime.now()-datetime(2017,1,1)).days * 24 / int(opt['種子']))
                seed = int(md5((str(self.user_id) + str(seed_time)).encode()).hexdigest().encode(), 16) % weight_total
            else:
                try:
                    #random.org的隨機據說為真隨機
                    if count > 1:
                        r = requests.get('https://www.random.org/integers/?num=%s&min=0&max=%s&col=1&base=10&format=plain&rnd=new' % (count, int(weight_total)), timeout=3)
                        if 'Error' in r.text:
                            raise
                        seed = r.text.split('\n')[:-1]
                    else:
                        raise
                except:
                    seed = [uniform(0, int(weight_total)) for i in range(count)]

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

