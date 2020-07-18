import json
from time import time
from datetime import datetime, timedelta
from uuid import uuid1
from api import cfg, get_id
from app import app
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.dialects.mysql import MEDIUMTEXT


app.config['SQLALCHEMY_DATABASE_URI'] = cfg['database']['url']
app.config['SQLALCHEMY_ECHO'] = cfg['database']['debug']
app.config['SQLALCHEMY_POOL_SIZE'] = 0
app.config['SQLALCHEMY_POOL_TIMEOUT'] = 10
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['confirm_deleted_rows'] = False
db = SQLAlchemy(app)


class NullObject:
    def __init__(self, **argv):
        if len(argv) > 0:
            self.__dict__.update(argv)


class User(db.Model):
    id        = db.Column(db.String(35), primary_key=True)
    name      = db.Column(db.String(20))
    location  = db.Column(db.TEXT)
    create_on = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    update_on = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    def __init__(self, id):
        self.id = id

    def update(self):
        self.update_on = datetime.now()
        pass


class Group(db.Model):
    _id       = db.Column(db.String(36))
    id       = db.Column(db.String(35), primary_key=True)
    _count   = db.Column(db.TEXT) #db.JSON
    _setting = db.Column(db.TEXT) #db.JSON
    _admin   = db.Column(db.TEXT) #db.JSON
    create_on = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    update_on = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    def __init__(self, id):
        self._id = str(uuid1())
        self.id = id
        self._count = '{}'
        self._setting = '{}'
        self._admin = '{}'

    def _json(self):
        if 'count' not in self.__dict__:
            self.count = json.loads(self._count)
            self.setting = json.loads(self._setting)
            self.admin = json.loads(self._admin)

    def update(self):
        self.update_on = datetime.now()
        self._count = json.dumps(self.count)
        self._setting = json.dumps(self.setting)
        self._admin = json.dumps(self.admin)


class GroupUser(db.Model):
    _id      = db.Column(db.Integer, autoincrement=True, primary_key=True)
    gid      = db.Column(db.String(35))
    uid      = db.Column(db.String(35))
    _count   = db.Column(db.TEXT) #db.JSON
    _setting = db.Column(db.TEXT) #db.JSON

    def __init__(self, group_id, user_id):
        self.gid = group_id
        self.uid = user_id
        self._count = '{}'
        self._setting = '{}'

    def _json(self):
        if 'count' not in self.__dict__:
            self.count = json.loads(self._count)
            self.setting = json.loads(self._setting)

    def update(self):
        self._count = json.dumps(self.count)
        self._setting = json.dumps(self.setting)



###############################################
#   使用者關鍵字
class Keywords(db.Model):
    _id     = db.Column(db.String(36), primary_key=True)
    id      = db.Column(db.String(35))
    author  = db.Column(db.String(35))
    keyword = db.Column(db.String(128), nullable=False)
    reply   = db.Column(db.TEXT, nullable=False)
    _option = db.Column(db.TEXT) #db.JSON

    def _json(self):
        if 'option' not in self.__dict__:
            self.option = json.loads(self._option)

    def update(self):
        self._option = json.dumps(self.option)

class KeywordsLogs(db.Model):
    _id       = db.Column(db.String(36), primary_key=True)
    id        = db.Column(db.String(35))
    keyword   = db.Column(db.String(128))
    reply     = db.Column(db.TEXT)
    create_on = db.Column(db.TIMESTAMP, default=db.func.current_timestamp())

    def __init__(self, id, keyword, reply):
        self._id = str(uuid1())
        self.id = id
        self.keyword = keyword
        self.reply = reply

class UserKeywords:
    def __init__(self):
        pass


class UserKeyword(db.Model):
    _id     = db.Column(db.Integer, autoincrement=True, primary_key=True)
    id      = db.Column(db.String(35))
    author  = db.Column(db.String(35))
    keyword = db.Column(db.String(128), nullable=False)
    reply   = db.Column(db.TEXT, nullable=False)
    super   = db.Column(db.Boolean)
    level   = db.Column(db.Integer)

    __mapper_args__ = {'confirm_deleted_rows': False}

    def __init__(self, id, author, keyword, reply):
        self.id      = id
        self.author  = author
        self.keyword = keyword
        self.reply   = reply
        self.super   = ('**' in keyword)
        self.level   = len(keyword) - keyword.count('**')*(len('**')+1)
        
    @staticmethod
    def add_and_update(id, author, keyword, reply, plus=False):
        cache = UserKeyword.get(id, keyword)
        if cache is None:
            row = UserKeyword(id, author, keyword, reply)
            db.session.add(row)

            UserKeyword_cache[id][keyword] = NullObject(**row.__dict__)
        else:
            #關鍵字保護
            n = cache.reply.rfind('##')
            if n > -1 and '保護' in cache.reply[n:] and cache.author != author:
                raise Exception('此關鍵字已被保護\n只有原設定者可以修改')

            cache.author = author
            cache.reply = reply + '__' + cache.reply if plus else reply #plus模式疊加

            for row in UserKeyword.query.filter_by(id=id, keyword=keyword):
                row.author = author
                row.reply = reply + '__' + row.reply if plus else reply #plus模式疊加

        if id is not None:
            row = KeywordsLogs(id, keyword, reply)
            db.session.add(row)
        return True

    @staticmethod
    def delete(id, author, keyword):
        cache = UserKeyword.get(id, keyword)
        if cache is None:
            return False

        #關鍵字保護
        n = cache.reply.rfind('##')
        if n > -1 and '保護' in cache.reply[n:] and cache.author != author:
            raise Exception('此關鍵字已被保護\n只有原設定者可以修改')
        
        for row in UserKeyword.query.filter_by(id=id, keyword=keyword):
            db.session.delete(row)
        UserKeyword_cache[id].pop(keyword)
        return True

    @staticmethod
    def get(id=None, keyword=None):
        if not id in UserKeyword_cache:
            UserKeyword_cache[id] = {}

        if id is None:
            rows = []
            for i in UserKeyword_cache.values():
                for row in i.values():
                    rows.append(row)
            return rows
        elif keyword is None:
            return [row for row in UserKeyword_cache[id].values()]
        else:
            return UserKeyword_cache[id].get(keyword, None)

#載入快取
UserKeyword_cache = {}
for row in UserKeyword.query:
    if row.id not in UserKeyword_cache:
        UserKeyword_cache[row.id] = {}
    UserKeyword_cache[row.id][row.keyword] = NullObject(**row.__dict__)



###############################################
#   使用者設定
class UserSettings(db.Model):
    _id       = db.Column(db.Integer, autoincrement=True, primary_key=True)
    group_id  = db.Column(db.String(35))
    user_id   = db.Column(db.String(35))
    options   = db.Column(db.TEXT)

    def __init__(self, group_id, user_id):
        self.group_id = group_id
        self.user_id  = user_id
        self.options  = '{}'

    @staticmethod
    def __get(group_id, user_id):
        '''
            取得ID
            如果沒有新增一筆
        '''
        row = UserSettings.query.filter_by(group_id=group_id, user_id=user_id).first()
        if row is None:
            row = UserSettings(group_id, user_id)
            db.session.add(row)
        return row
        
    @staticmethod
    def update(group_id, user_id, options):
        '''
            更新設定
        '''
        if type(options) != dict:
            Exception('參數類型錯誤')

        row = UserSettings.__get(group_id, user_id)

        row_options = json.loads(row.options)
        row_options.update(options)
        row.options = json.dumps(row_options)

    @staticmethod
    def get(group_id, user_id, option, default=None):
        '''
            取得設定
        '''
        row = UserSettings.__get(group_id, user_id)

        return json.loads(row.options).get(option, default)

    @staticmethod
    def show(group_id, user_id):
        '''
            取得設定
        '''
        def bool2str(b):
            return '開啟' if b else '關閉'

        data = ['目前的設定']

        row = UserSettings.__get(group_id, None)
        data.append('<群組>')
        settings = json.loads(row.options)
        if len(settings) > 0:
            for k, v in settings.items():
                data.append('%s = %s' % (k, bool2str(v)))
        else:
            data.append('無 (預設)')

        row = UserSettings.__get(group_id, user_id)
        data.append('<群組中的你>')
        settings = json.loads(row.options)
        if len(settings) > 0:
            for k, v in settings.items():
                data.append('%s = %s' % (k, bool2str(v)))
        else:
            data.append('無 (預設)')

        return '\n'.join(data)



###################################
#   訊息隊列
class MessageQueue(db.Model):
    _id       = db.Column(db.String(36), primary_key=True)
    id        = db.Column(db.String(35))
    message   = db.Column(db.TEXT)
    create_on = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    
    def __init__(self, id, message):
        self._id = str(uuid1())
        self.id = id
        self.message = message

    @staticmethod
    def add(id, message):
        row = MessageQueue(id, message)
        db.session.add(row)

    @staticmethod
    def get(id, message):
        if id is None or len(message) >= 5:
            return message

        for row in MessageQueue.query.filter_by(id=id).order_by(MessageQueue._id):
            row.pushed = False
            db.session.delete(row)

            message.append(row.message)
            if len(message) >= 5:
                break
        
        return message



###################################
#   WebUI
class WebUI(db.Model):
    uid         = db.Column(db.String(35), primary_key=True)
    gid         = db.Column(db.String(35))
    gid_timeout = db.Column(db.DateTime(timezone=True))
    create_on   = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    #update_on  = db.Column(db.DateTime(timezone=True))

    def __init__(self, uid):
        self.uid  = uid

    def setGroup(self, gid, timeout):
        self.gid = gid
        self.gid_timeout = datetime.now() + timedelta(seconds=timeout)



###################################
#   短連結
class UrlShortener(db.Model):
    id        = db.Column(db.String(7), primary_key=True)
    url       = db.Column(db.TEXT)
    create_on = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    def __init__(self, url):
        self.url  = url
        self.id = get_id()

    def get(self):
        return '%s/l/%s' % (cfg['web_url'], self.id)

    @staticmethod
    def add(url):
        if not 'http' in url:
            return '<無效網址>'
        row = UrlShortener(url)
        db.session.add(row)
        return row.get()



###################################
#   清除與備份
def clean():
    today = datetime.now()
    timeout = 60*60*24*90
    users = []

    for Type in [User, Group]:
        for row in Type.query.all():
            diff = (today-row.use_on).total_seconds()
            if diff >= timeout:
                print('移除 %s' % row.id)
                db.session.delete(row)
            else:
                users.append(row.id)
    for row in GroupUser.query.all():
        if row.gid not in users:
            print('---group_data > %s' % row._id)
            db.session.delete(row)
    for row in UserKeyword.get():
        if row.id not in users:
            print('---keyword > %s > %s' % (row.keyword, row.reply))
            db.session.delete(row)

    db.session.commit()

def backup():
    pass


###################################
#   手動克隆關鍵字
def UserKeywordClone(_from, to):
    for i in UserKeyword.query.filter_by(id=_from):
        UserKeyword.add_and_update(to, _from, i.keyword, i.reply)
        print(i.keyword)
    db.session.commit()
    print('------------------\n完成')


if __name__ == '__main__':
    db.create_all()
    #clean()