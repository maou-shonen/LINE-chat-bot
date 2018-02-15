from time import sleep
import requests.exceptions
from api import cfg
from database import db, MessageQueue
from linebot import LineBotApi
from linebot.exceptions import LineBotApiError
from linebot.models import TextMessage, ImageSendMessage, TextSendMessage


def repair_image_url(message):
    if 'imgur.com' in message:
        message = message.replace('http:', 'https:')
        message = message.replace('m.imgur.com', 'i.imgur.com')
        if message.split('/')[-1].find('.') == '-1': message += '.jpg'
    return message

is_image_and_ready_cache = {}
def is_image_and_ready(url):
    try:
        if url in is_image_and_ready_cache:
            ct = is_image_and_ready_cache[url]
        else:
            ct = requests.head(url, timeout=5).headers.get('content-type')
            is_image_and_ready_cache[url] = ct
        return ct in ['image/jpeg', 'image/png']
    except:
        return False

def getUrlType(url):
    try:
        ct, fe = requests.head(url, timeout=10).headers.get('content-type').split('/')

        return (requests.head(url, timeout=5).headers.get('content-type') in ['image/jpeg', 'image/png'])
    except:
        return '讀取過慢或發生錯誤 類型不明'
    if ct == 'text':
        return '一般網頁'
    if ct == 'image':
        if 1:
            return '圖片 %s ' % fe
        else:
            support = '格式支援' if fe in ['jpeg', 'png'] else '格式不支援'
        return '圖片 %s %s' % (fe, support)
    return '其他格式 目前不支援'


class LineBot(LineBotApi):
    def __init__(self, token, push):
        LineBotApi.__init__(self, token)
        self.can_push = push #push權限

    def __message_queue(self, to, messages):
        print(messages)
        for message in messages:
            row = MessageQueue(to, message)
            db.session.add(row)

    def __message_format(self, messages):
        if type(messages) == str:
            messages = [messages]

        message_object = []
        for message in messages:
            if message is None or type(message) != str:
                continue

            message = message.strip('|_ \n')
            if message == '':
                continue

            message = repair_image_url(message)
            
            if message[:6] == 'https:':
                if 'imgur.com' in message or is_image_and_ready(message):
                    message_object.append(ImageSendMessage(message, message))
                else:
                    message_object.append(TextSendMessage(message))
            else:
                if len(message) >= 1500:
                    message = message[:1500] + '\n<字數過多 後略>'
                message_object.append(TextSendMessage(message))

        if len(message_object) == 0:
            message_object.append(TextSendMessage('<此為空白內容>\n<由設定錯誤引發>'))
        return message_object[:5]

    def push(self, to=None, reply_token=None, messages=None):
        if to is None:
            raise Exception('to未定義')

        if type(messages) != list:
            messages = [messages]

        messages = MessageQueue.get(to, messages)

        if len(messages) == 0:
            return False

        error = None
            
        #reply by token
        if reply_token is not None:
            messages_object = self.__message_format(messages)
            for i in range(3):
                try:
                    self.reply_message(reply_token, messages_object)
                    return True
                except Exception as e:
                    print('to', to, 'obj', messages_object, len(messages_object))
                    error = e
                    sleep(1)
        
        #push
        if self.can_push and to is not None:
            messages_temp = messages.copy()
            messages = []
            for m in messages_temp:
                mo = self.__message_format(m)
                for i in range(3):
                    try:
                        self.push_message(to, mo) #multicast
                        break
                    except Exception as e:
                        error = e
                        sleep(1)
                else:
                    messages.append(i)

            if len(messages) == 0:
                return True

        #queue
        
        if error is not None:
            raise error
        self.__message_queue(to, messages)

        return False


bots = {}
for bot_id, bot_cfg in cfg['line_bot'].items():
    bots[bot_id] = LineBot(**bot_cfg)

def push_developer(messages):
    return bots['admin'].push(to=cfg['developer'], messages=messages)
