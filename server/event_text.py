import requests
from time import time
from random import choice, randint, uniform, sample
from datetime import datetime, timedelta
from hashlib import md5

from api import *
from logger import logger
from database import db, UserKeyword, UserSettings, MessageQueue, WebUI
from other import google_shorten_url, ehentai_search, exhentai_search, google_search
from LineBot import bots, push_developer
from module import * #google_safe_browsing

#未整理
UserSettings_temp = ConfigFile('.UserSettings_temp.tmp')
from database import User, Group, GroupUser

#todo
'''
搜圖
訂閱 預定#開頭
上傳圖片不從heroku執行 並且執行壓縮
database分離 用於pro版的相容
'''


class EventText():
    bot_id   = None
    user_id  = None
    group_id = None
    message  = None

    def __init__(self, **argv):
        self.__dict__.update(**argv)

        self.bot = bots.get(self.bot_id, None)

        #User 模組
        self.user = User.query.get(self.user_id) if self.user_id else None
        if self.user_id:
            if not self.user:
                self.user = User(self.user_id)
                db.session.add(self.user)

        #Group 模組
        self.group = Group.query.get(self.group_id) if self.group_id else None
        if self.group_id:
            if not self.group:
                self.group = Group(self.group_id)
                db.session.add(self.group)
            self.group._json() #mariaDB還沒有支援json格式 只好自行轉換

        #GroupUser 模組
        self.group_data = GroupUser.query.filter_by(gid=self.group_id, uid=self.user_id).first() if self.group_id else None
        if self.group_id:
            if not self.group_data:
                self.group_data = GroupUser(self.group_id, self.user_id)
                db.session.add(self.group_data)
            self.group_data._json() #mariaDB還沒有支援json格式 只好自行轉換


        #文本分類
        if self.message:
            self.message = self.message.replace('"', '＂').replace("'", '’').replace(';', '；') #替換一些字元成全型 防SQL注入攻擊
            self.order, *self.value = self.message.split('=')
            self.order = self.order.lower()
            self.key = self.value[0].strip(' \n') if len(self.value) > 0 else None
            self.value = '='.join(self.value[1:]).strip(' \n') if len(self.value) > 1 else None
            if self.key == '': self.key = None
            if self.value == '': self.value = None


    def _count(self, values):
        '''
            使用者對話計數
            values只接受dict 由於使用中文 不用**argv
        '''
        if self.group is None:
            return

        for key, value in values.items():
            if key in self.group_data.count:
                self.group_data.count[key] += value
            else:
                self.group_data.count[key] = value


    def run(self):
        '''
            接收發送訊息邏輯
        '''
        if self.message:
            uid = '%s%s' % (self.user_id[1:5] if self.user_id else self.user_id, '@%s' % self.group_id if self.group else '')
            logger.info('%s > %s' % (uid, self.message))

            t0 = time()
            reply_message = self.index()
            t1 = time() - t0

            #公告
            if reply_message is None:
                reply_message = []
            elif type(reply_message) == str:
                reply_message = [reply_message]
             
            if not self.bot:
                if self.group:
                    for message in reply_message:
                        MessageQueue.add(self.group.id, message)
            else:
                if self.bot.push(to=self.group.id if self.group else self.user.id, reply_token=self.reply_token, messages=reply_message):
                    t2 = time() - t1 - t0
                    logger.info('%s < %s %s' % (uid, reply_message, '(%dms, %dms)' % (t1*1000, t2*1000)))

        elif self.sticker:
            reply_message = []
            self._count({'貼圖':1})

        elif self.image:
            reply_message = []
            self._count({'圖片':1})

        #刷新資料
        if self.user:
            try:
                self.user.name = self.bot.get_group_member_profile(self.group.id, self.user.id).display_name
            except:
                try:
                    self.user.name = self.bot.get_room_member_profile(self.group.id, self.user.id).display_name
                except:
                    pass
            self.user.update()
        if self.group:
            self.group.update()
            self.group_data.update()
        db.session.commit()

        return reply_message


    def index(self):
        if self.group:
            #群組才有的功能
            if   self.order in ['-s', 'set', 'settings', '設定', '設置']:
                return self.settings()
            elif self.order in ['愛醬安靜', '愛醬閉嘴', '愛醬睡覺', '愛醬下線']:
                return self.sleep()
            elif self.order in ['愛醬講話', '愛醬說話', '愛醬聊天', '愛醬起床', '愛醬起來', '愛醬上線']:
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
        elif self.order in []: #'飆車'
            return self.bt()
        elif self.order in []: #'停車'
            return self.bt_stop()
        elif self.order in ['e-hentai', 'ehentai', 'e變態']:
            return self.ehentai()
        elif self.order in ['exhentai', 'ex變態']:
            return self.exhentai()
        elif self.order in ['pixiv', '#pixiv', 'p網', '#p網']:
            return self.pixiv()
        elif self.order in ['weather', '天氣']:
            return self.weather()
        else:
            return self.main()


    def push(self):
        if self.user_id != cfg['developer']:
            return cfg['公告']['內容']
        if self.value is None:
            return '參數錯誤\n[公告=對象id or all=內容]'
        if self.key == 'all':
            for g in Group.query.all():
                MessageQueue.add(g.id, '<愛醬公告 %s>\n詳細說明 goo.gl/KutKhs\n%s' % (datetime.now().strftime('%m%d.%H'), self.value))
        else:
            MessageQueue.add(self.key, '<開發者回覆>\n' + self.value)
        return 'ok'


    def sleep(self):
        '''
            愛醬閉嘴
        '''
        h = int(self.key) if self.key and self.key.isdigit() else 12
        t = time() + 60 * 60 * (24*7 if h > 24*7 else 1 if h < 1 else h)
        UserSettings_temp.set(self.group_id, '暫停', str(t))
        UserSettings_temp.save()
        return '%s\n(%s)' % (text['睡覺'], datetime.fromtimestamp(t).strftime('%Y-%m-%d %H:%M'))


    def wake_up(self):
        '''
            愛醬說話
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
        if not self.user:
            return text['權限不足']

        if self.group:
            u = WebUI.query.get(self.user.id)
            if not u:
                u = WebUI(self.user.id)
                db.session.add(u)
            u.setGroup(self.group.id, 60*30)
            return '%s\n授權操作此群組30分鐘' % (cfg['web_url'])
        else:
            return cfg['web_url']


    def list(self):
        '''
            列出關鍵字
        '''
        reply_message = []
        #list的排列需要調整 目前來看一行20個字為佳
        if self.group is None or self.key in cfg['詞組']['自己的']:
            if self.user is None:
                return text['權限不足']
            else:
                reply_message.append('現在群組中預設不使用個人詞庫\n有需要請用「設定」開啟')
                reply_message.append('\n'.join([k.keyword for k in UserKeyword.get(self.user.id)]))
        else:
            reply_message.append('「列表=我」查詢自己')
            reply_message.append('\n'.join([k.keyword for k in UserKeyword.get(self.group.id)]))

        reply_message.append('\n\n使用「網頁設定」更好操作')
        return '\n'.join(reply_message)


    def add(self, plus=False):
        '''
            新增關鍵字
        '''
        if self.key is None:
            return text['學習說明']

        #文字處理1
        self.key = self.key.lower()
        while '***' in self.key:   self.key   = self.key.replace('***', '**')

        #查詢
        if self.value is None:
            if self.group:
                row = UserKeyword.get(self.group.id, self.key)
            else:
                row = UserKeyword.get(self.user.id, self.key)
            if row:
                return text_format(text['關鍵字查詢成功'], key=self.key, value=row.reply)
            else:
                return text_format(text['關鍵字查詢失敗'], key=self.key)

        self._count({'調教':1}) #紀錄次數

        #文字處理2
        while '|||' in self.value: self.value = self.key.replace('|||', '||')
        while '___' in self.value: self.value = self.key.replace('___', '__')

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

        reply_message = ['%s 新增 <%s> ' % (self.user.name if self.user else '', self.key)]

        try:
            if self.group:
                UserKeyword.add_and_update(self.group_id, self.user_id, self.key, self.value, plus=plus)
            else:
                UserKeyword.add_and_update(self.user_id, self.user_id, self.key, self.value, plus=plus)
                
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

        #for i in self.value.replace('__', '||').split('||'):
        #    i = i.strip()
        #    if i[:4] == 'http' and not is_image_and_ready(i):
        #        reply_message.append('<%s>\n愛醬發現圖片網址是錯誤的\n請使用格式(jpg, png)\n短網址或網頁嵌圖片可能無效\n必須使用https' % i)
        #    break #如果全部都檢查時間會太久 只幫第一個檢查格式 通常使用者圖床也會使用同一個 應該不會有問題
    
        if self.group is None:
            reply_message.append('\n現在個人詞庫預設是不會在群組觸發的喔\n請在群組設定開啟全回應模式(預設開)或開啟個人詞庫(預設關)')
        else:
            #保護模式提醒 之後option寫入database將此邏輯合併計算中
            n = self.value.rfind('##')
            if n > -1 and '保護' in self.value[n:]:
                reply_message.append('\n(此為保護關鍵字 只有你可以刪除及修改 為了避免爭議 建議不要濫用)')
            
        return ''.join(reply_message) \
            + '\n\n使用「網頁設定」更好操作'


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
        reply_message = ['%s 刪除 <%s>' % (self.user.name if self.user else '', self.key)]

        try:
            if self.group:
                if UserKeyword.delete(self.group_id, self.user_id, self.key):
                    reply_message.append(' 成功')
            if self.user:
                if UserKeyword.delete(self.user_id, self.user_id, self.key):
                    reply_message.append(' 成功')

        except Exception as e:
            return '刪除失敗: %s' % str(e)
            
        return ''.join(reply_message) if len(reply_message) > 1 else '喵喵喵? 愛醬不記得<%s>' % (self.key) \
            + '\n\n使用「網頁設定」更好操作'


    def opinion(self):
        '''
            回報、建議、檢舉
        '''
        if self.key is None:
            return text['回報說明']

        self._count({'觸發':1}) #紀錄次數

        try:
            push_developer('%s\n%s\n%s\n%s' % (self.bot_id, self.group_id, self.user_id, self.message))
            return text['回報完成']
        except Exception as e:
            raise e
            return '訊息傳送失敗..%s' % str(e)


    def settings(self):
        '''
            設定
        '''
        if self.key is None:
            return [
                    '設定=別理我=開/關\n'
                    '設定=個人詞庫=開/關\n'
                    '設定=全回應=開/關\n'
                    '設定=全圖片=開/關(需要全回應)\n'
                    '設定=幫忙愛醬=開/關\n'
                    '\n'
                    '(不輸入值可查看說明)',

                    UserSettings.show(self.group_id, self.user_id)
                ]

        try:
            if self.key in ['過濾髒話', '髒話過濾']:
                return '這設定已經移除了'

            #全群組
            if self.key == '全回應':
                if self.value is None:
                    return '開啟後愛醬開頭的對話將從全部的詞庫中產生反應\n「預設:關」'
                UserSettings.update(self.group_id, None, {'全回應':text2bool(self.value)})
                return '設定完成'
            
            if self.key == '全圖片':
                if self.value is None:
                    return '開啟後全回應的結果包含圖片\n(需要開啟全圖片)\n(注意:圖片沒有任何審核 有可能出現不適圖片 如可接受再開啟)\n「預設:關」'
                UserSettings.update(self.group_id, None, {'全圖片':text2bool(self.value)})
                return '設定完成'

            if self.key == '幫忙愛醬':
                if self.value is None:
                    return '開啟後會快取群組的對話紀錄\n只用於機器學習\n作者會稍微過目後進行分類丟入程式\n用完後刪除「預設:關」\n使用「設定=幫忙愛醬=開」開啟'
                UserSettings.update(self.group_id, None, {'幫忙愛醬':text2bool(self.value)})
                return '設定完成'

            #群組中個人
            if self.key == '別理我':
                if self.value is None:
                    return '開啟後愛醬不會在此群組對你產生回應\n(愛醬開頭還是可以強制呼叫)\n「預設:關」'
                if self.user_id is None:
                    return text['權限不足']
                UserSettings.update(self.group_id, self.user_id, {'別理我':text2bool(self.value)})
                return '設定完成'

            if self.key == '個人詞庫':
                if self.value is None:
                    return '開啟後會對你的個人詞庫產生回應\n「預設:關」'
                if self.user_id is None:
                    return text['權限不足']
                UserSettings.update(self.group_id, self.user_id, {'個人詞庫':text2bool(self.value)})
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
            '圖片':1,
            '網頁':0.5,
            '髒話':-10,
            '字數':0.1,
        }

        def _score(group_data):
            score = 0
            for key, value in score_default.items():
                score += group_data.count.get(key, 0) * self.group.count.get(key, value)
            return score

        def _get(user):
            group_data = GroupUser.query.filter_by(gid=self.group.id, uid=user.id).first()
            if group_data is None:
                group_data = GroupUser(self.group.id, user.id)
                db.session.add(group_data)
            group_data._json()
            score = _score(group_data)

            return '\n'.join([
                '愛醬記得 %s' % (user.name if user.name else '你'),
                '調教愛醬 %d 次' % (group_data.count.get('調教', 0)),
                '跟愛醬說話 %d 次' % (group_data.count.get('觸發', 0)),
                '有 %d 次對話' % (group_data.count.get('對話', 0)),
                '有 %d 次貼圖' % (group_data.count.get('貼圖', 0)),
                '有 %d 次圖片' % (group_data.count.get('圖片', 0)),
                '有 %d 次傳送門' % (group_data.count.get('網頁', 0)),
                '講過 %d 次「幹」' % (group_data.count.get('髒話', 0)),
                '總計 %d 個字' % (group_data.count.get('字數', 0)),
                '----------',
                '總分 %d' % (score if score > 0 else 0),
            ])

        if is_text_like(self.key, '自己'):
            #查詢自己
            if self.user is None:
                return text['權限不足']

            if self.user.id not in self.group.count:
                self._count({}) #如果沒有任何紀錄刷新一筆空的進行初始化
            
            return _get(self.user)

        elif self.key in ['rank', '排名', '排行']:
            #排行榜
            rank = []
            for row in GroupUser.query.filter_by(gid=self.group.id):
                if row.uid is None:
                    continue
                user = User.query.get(row.uid)
                if user is None:
                    continue
                row._json()
                score = _score(row)
                for u in rank[:10]:
                    if score > u['score']:
                        rank.insert(rank.index(u), {'user':user, 'score':score})
                        break
                else:
                    if len(rank) < 3:
                        rank.append({'user':user, 'score':score})

            if len(rank) < 3:
                return '群組說話的不足3人\n(沒有權限等同不存在)'

            n = 0
            reply_message = []
            for u in rank[:10]:
                n += 1
                reply_message.append('第%s名 %s 分！\n%s ' % (n, int(u['score']), u['user'].name))
            return '\n\n'.join(reply_message)

        elif is_text_like(self.key, '設定'):
            #設定分數 (查詢)
            values = []
            for key, value in score_default.items():
                values.append('%s = %s' % (key, self.group.count.get(key, value)))
            return '目前分數設定為:\n%s\n\n調整方法為\n「回憶=類型=值」\n栗子\n回憶=對話=5' % '\n'.join(values)

        elif self.key in list(score_default.keys()):
            #設定分數
            if not isFloat(self.value):
                return '<%s>不是數字喔' % (self.value)
            self.group.count[self.key] = float(self.value)
            return '設定完成'

        elif is_text_like(self.key, '全部'):
            #查詢整群
            total = {}.fromkeys(['人數', '調教', '觸發', '對話', '貼圖', '圖片', '網頁', '髒話', '字數'], 0)
            for row in GroupUser.query.filter_by(gid=self.group.id):
                row._json()
                total['人數'] += 1
                for key in score_default.keys():
                    total[key] += row.count.get(key, 0)

            return '\n'.join([
                '愛醬記得這個群組...',
                '有 %d 個人說過話' % total['人數'],
                '愛醬被調教 %d 次' % (total['調教']),
                '跟愛醬說話 %d 次' % (total['觸發']),
                '有 %d 次對話' % (total['對話']),
                '有 %d 次貼圖' % (total['貼圖']),
                '有 %d 次圖片' % (total['圖片']),
                '有 %d 次傳送門' % (total['網頁']),
                '講過 %d 次「幹」' % (total['髒話']),
                '總計 %d 個字' % (total['字數']),
            ])

        elif self.key:
            #查詢別人
            users = {}
            self.key = self.key.strip('@ \n')
            for row in GroupUser.query.filter_by(gid=self.group.id):
                if row.uid is None:
                    continue
                user = User.query.get(row.uid)
                if user is None or user.name is None:
                    continue
                if self.key == user.name:
                    return _get(user)
                if self.key in user.name:
                    users[user.id] = user

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

        return google_search(self.message[self.message.find('=')+1:])


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
        if self.key is None:
            return text['ehentai說明']

        self._count({'觸發':1}) #紀錄次數

        return ehentai_search(self.key)


    def exhentai(self):
        '''
            EX變態搜尋
        '''
        if self.key is None:
            return text['exhentai說明']

        self._count({'觸發':1}) #紀錄次數

        return exhentai_search(self.key)

    def pixiv(self):
        if self.order[0] == '#':
            if self.key is None:
                return text['pixiv#說明']
            return pixiv.rss(self.key)
        else:
            if self.key is None:
                return text['pixiv說明']
            return pixiv.search(self.key, self.value if self.value is not None and self.value.isdigit() else 30)


    def weather(self):
        try:
            weather = get_weather(self.user, self.key)

            self._count({'觸發':1}) #紀錄次數

            return weather
        except Exception as e:
            raise Exception('天氣查詢失敗: %s' % str(e))


    def main(self):
        '''
            關鍵字觸發
        '''
        if 'http:' in self.message or 'https:' in self.message: #如果內容含有網址 做網址檢查
            if self.group:
                self._count({'網頁':1}) #紀錄次數
                return google_safe_browsing(self.message)
            else:
                return google_shorten_url(self.message) #短網址

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
                self.message = self.message[2:].strip(' \n　')
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
            if not self.group or (self.user and UserSettings.get(self.group.id, self.user.id, '個人詞庫', False)): #檢查是否使用個人詞庫
                reply_message = self.check(UserKeyword.get(self.user.id))
                if reply_message:
                    return reply_message

            if self.group and self.user:
                if not UserSettings.get(self.group.id, self.user.id, '別理我', False): #檢查不理我模式
                    reply_message = self.check(UserKeyword.get(self.group.id))
                    if reply_message:
                        return reply_message

        #全回應模式
        if self.message[:2] == text['名稱'] or self.group_id is None:
            if self.group is None or UserSettings.get(self.group_id, None, '全回應', default=False):
                if self.message != text['名稱'] and self.message[:2] == text['名稱']: #做兩層是為了方便1對1不見得也要愛醬開頭
                    self.message = self.message[2:].strip(' \n　')

                reply_message = self.check(UserKeyword.get(), all_reply=True)
                if reply_message:
                    return reply_message
                if self.group:
                    return choice(text['未知'])
            else:
                return choice(text['未知']) + '\n(全回應模式關閉)\n使用「設定」開啟'

        if self.group_id is None:
            return text['預設回覆']
        else:
            return None


    def check(self, userkeyword_list, all_reply=False):
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

            if row.keyword == self.message:
                if all_reply:
                    result.append(row_reply)
                else:
                    return self.later(row_reply)
            elif row.keyword.replace('**', '') == self.message:
                result.append(row_reply)
            elif not all_reply or len(row_reply) > 1: #超過一個字才加入全回應
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
                bots['admin'].send_message(cfg['admin_line'], '錯誤:%s\ngid:%s\nuid:%s\nmsg:%s\nkey:<%s>\n<%s>' % (str(e), self.group_id, self.user_id, self.message, k, v))
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

