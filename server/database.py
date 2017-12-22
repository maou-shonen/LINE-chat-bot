import json
from datetime import datetime
from api import cfg
from app import app
from flask_sqlalchemy import SQLAlchemy


app.config['SQLALCHEMY_DATABASE_URI'] = cfg['database']['url']
app.config['SQLALCHEMY_ECHO'] = cfg['database']['debug']
app.config['SQLALCHEMY_POOL_SIZE'] = 100
app.config['SQLALCHEMY_POOL_TIMEOUT'] = 10
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = True
db = SQLAlchemy(app)


class NullObject:
    def __init__(self, **argv):
        if len(argv) > 0:
            self.__dict__.update(argv)


###############################################
#   使用者狀態
class UserStatus(db.Model):
    id     = db.Column(db.String(35), primary_key=True)
    use_on = db.Column(db.DateTime)
    news   = db.Column(db.TEXT)

    def __init__(self, id):
        self.id = id
        self.news = None

    @staticmethod
    def __get(id):
        '''
            取得ID
            如果沒有新增一筆
        '''
        row = UserStatus.query.get(id)
        if row is None:
            row = UserStatus(id)
            db.session.add(row)
        return row

    @staticmethod
    def refresh(id):
        '''
            刷新最後使用時間
        '''
        if id is None:
            return

        row = UserStatus.__get(id)

        row.use_on = datetime.now()

    @staticmethod
    def check_news(id):
        '''
            檢查公告版本
        '''
        if id is None:
            return

        row = UserStatus.__get(id)

        if row.news != cfg['公告']['ver']:
            row.news = cfg['公告']['ver']
            return True
        return False



###############################################
#   使用者關鍵字
class UserKeyword(db.Model):
    _id     = db.Column(db.Integer, autoincrement=True, primary_key=True)
    id      = db.Column(db.String(35))
    author  = db.Column(db.String(35))
    keyword = db.Column(db.String(128), nullable=False)
    reply   = db.Column(db.TEXT, nullable=False)
    super   = db.Column(db.Boolean)
    level   = db.Column(db.Integer)

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



###############################################
#   使用狀況計數器
class MessageLogs(db.Model):
    _id        = db.Column(db.Integer, autoincrement=True, primary_key=True)
    group_id   = db.Column(db.String(35))
    user_id    = db.Column(db.String(35))
    nAIset     = db.Column(db.Integer, server_default='0') #設定愛醬的次數
    nAItrigger = db.Column(db.Integer, server_default='0') #觸發愛醬的次數
    nText      = db.Column(db.Integer, server_default='0') #文字訊息的次數 以下類推
    nSticker   = db.Column(db.Integer, server_default='0')
    nImage     = db.Column(db.Integer, server_default='0')
    nUrl       = db.Column(db.Integer, server_default='0')
    nFuck      = db.Column(db.Integer, server_default='0') #髒話 幹的次數
    nLenght    = db.Column(db.BigInteger, server_default='0') #文字總長度

    def __init__(self, group_id, user_id, nAIset=0, nAItrigger=0, nText=0, nSticker=0, nImage=0, nUrl=0, nFuck=0, nLenght=0):
        self.group_id = group_id
        self.user_id = user_id
        self.nAIset = nAIset
        self.nAItrigger = nAItrigger
        self.nText = nText
        self.nSticker = nSticker
        self.nImage = nImage
        self.nUrl = nUrl
        self.nFuck = nFuck
        self.nLenght = nLenght

    @staticmethod
    def add(group_id, user_id, nAIset=0, nAItrigger=0, nText=0, nSticker=0, nImage=0, nUrl=0, nFuck=0, nLenght=0):
        data =  MessageLogs.query.filter_by(group_id=group_id, user_id=user_id).first()
        if data is None:
            db.session.add(MessageLogs(group_id, user_id, nAIset, nAItrigger, nText, nSticker, nImage, nUrl, nFuck, nLenght))
        else:
            data.nAIset += nAIset
            data.nAItrigger += nAItrigger
            data.nText += nText
            data.nSticker += nSticker
            data.nImage += nImage
            data.nUrl += nUrl
            data.nFuck += nFuck
            data.nLenght += nLenght

    @staticmethod
    def get(**argv):
        data = {}.fromkeys(['users', 'nAIset', 'nAItrigger', 'nText', 'nSticker', 'nUrl', 'nFuck', 'nLenght'], 0)
        for row in MessageLogs.query.filter_by(**argv):
            data['users'] += 1
            data['nAIset'] += row.nAIset
            data['nAItrigger'] += row.nAItrigger
            data['nText'] += row.nText
            data['nSticker'] += row.nSticker
            data['nSticker'] += row.nImage
            data['nUrl'] += row.nUrl
            data['nFuck'] += row.nFuck
            data['nLenght'] += row.nLenght
        return data




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
