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


class UserKeyword(db.Model):
    __tablename__ = 'Keyword'

    _id     = db.Column(db.Integer, autoincrement=True, primary_key=True)
    id      = db.Column(db.String(35))
    author  = db.Column(db.String(35))
    keyword = db.Column(db.String(128), nullable=False)
    reply   = db.Column(db.String(2048), nullable=False)
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
    def add_and_update(id, author, keyword, reply):
        for row in UserKeyword.query.filter_by(id=id, keyword=keyword):
            row.author = author
            row.reply = reply
            break
        else:
            db.session.add(UserKeyword(id, author, keyword, reply))
        return True

    @staticmethod
    def delete(id, keyword):
        for row in UserKeyword.query.filter_by(id=id, keyword=keyword):
            db.session.delete(row)
            return True
        return False

    @staticmethod
    def get(id, keyword=None):
        if keyword is None:
            return list(UserKeyword.query.filter_by(id=id))
        else:
            for row in UserKeyword.query.filter_by(id=id, keyword=keyword):
                return row
            else:
                return None



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
        for row in MessageLogs.query.filter_by(group_id=group_id, user_id=user_id):
            row.nAIset += nAIset
            row.nAItrigger += nAItrigger
            row.nText += nText
            row.nSticker += nSticker
            row.nImage += nImage
            row.nUrl += nUrl
            row.nFuck += nFuck
            row.nLenght += nLenght
            break
        else:
            db.session.add(MessageLogs(group_id, user_id, nAIset, nAItrigger, nText, nSticker, nImage, nUrl, nFuck, nLenght))

    @staticmethod
    def get(group_id):
        data = {}.fromkeys(['users', 'nAIset', 'nAItrigger', 'nText', 'nSticker', 'nUrl', 'nFuck', 'nLenght'], 0)
        for row in MessageLogs.query.filter_by(group_id=group_id):
            data['users'] += 1
            data['nAIset'] += row.nAIset
            data['nAItrigger'] += row.nAItrigger
            data['nText'] += row.nText
            data['nSticker'] += row.nSticker
            data['nUrl'] += row.nUrl
            data['nFuck'] += row.nFuck
            data['nLenght'] += row.nLenght
        return data



class UserSettings(db.Model):
    id = db.Column(db.String(35), primary_key=True)
    last_time = db.Column(db.DateTime)
    news = db.Column(db.TEXT)
    options = db.Column(db.TEXT)

    def __init__(self, id):
        self.id = id
        self.news = None
        self.options = '{}'

    @staticmethod
    def __get(id):
        for row in UserSettings.query.filter_by(id=id):
            return row
        else:
            data = UserSettings(id)
            db.session.add(data)
            return data
    
    @staticmethod
    def refresh_last_time(id):
        data = UserSettings.__get(id)
        data.last_time = datetime.now()

    @staticmethod
    def check_news(id):
        data = UserSettings.__get(id)
        if data.news != cfg['公告']['ver']:
            data.news = cfg['公告']['ver']
            return True
        return False

    @staticmethod
    def update(id, **options):
        data = UserSettings.__get(id)
        data_options = json.loads(data.options)
        for opt, val in options.items():
            data_options[opt] = val
        data.options = json.dumps(data_options)

    @staticmethod
    def get(id, option, default=None):
        data = UserSettings.__get(id)
        return json.loads(data.options).get(option, default)


if __name__ == '__main__':
    db.create_all()

    for row in UserKeywordOld.query.all():
        print(row.keyword)
        db.session.add(UserKeyword(row.id, row.id, row.keyword, row.reply))
    for row in GroupKeywordOld.query.all():
        print(row.keyword)
        db.session.add(UserKeyword(row.id, row.author, row.keyword, row.reply))
    db.session.commit()