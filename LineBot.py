from time import sleep
import requests.exceptions
from api import cfg
from app import app
from database import db, MessageQueue
from linebot import LineBotApi
from linebot.exceptions import LineBotApiError
from linebot.models import TextMessage, ImageSendMessage, TextSendMessage
from loguru import logger


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
        self.token = token
        self.can_push = push #push權限

    def __message_queue(self, to, messages):
        print(messages)
        for message in messages:
            row = MessageQueue(to, message)
            db.session.add(row)

    def __message_format(self, messages, format=True):
        if type(messages) == str:
            messages = [messages]

        contents = []

        for message in messages:
            if message is None or type(message) != str:
                continue

            message = message.strip('|_ \n')
            if message == '':
                continue

            if not format:
                contents.append(TextSendMessage(message))
                continue

            message = repair_image_url(message)
            
            if message[:6] == 'https:':
                if 'imgur.com' in message or is_image_and_ready(message):
                    contents.append(ImageSendMessage(message, message))
                else:
                    contents.append(TextSendMessage(message))
            else:
                if len(message) >= 1500:
                    message = message[:1500] + '\n<字數過多 後略>'
                contents.append(TextSendMessage(message))

        if len(contents) == 0:
            contents.append(TextSendMessage('<此為空白內容>\n<由設定錯誤引發>'))

        return contents[:5]

    def push(self, to, messages, reply_token=None, format=True):
        logger.debug(self.token)

        if type(messages) != list:
            messages = [messages]

        messages = MessageQueue.get(to, messages)

        if len(messages) == 0:
            return False

        #reply by token
        if reply_token:
            content = self.__message_format(messages, format=format)
            for i in range(1):
                try:
                    self.reply_message(reply_token, content)
                    return True
                except Exception as e:
                    sleep(1)
            else:
                logger.warning('傳送失敗 to=%s messages=%s' % (to, content))
                return False
        
        #push
        elif self.can_push:
            while len(messages) > 0:
                content = self.__message_format(messages.pop(0), format=format)
                for i in range(1):
                    try:
                        self.push_message(to, content)
                        break
                    except Exception as e:
                        sleep(1)
                else:
                    logger.warning('傳送失敗 to=%s messages=%s' % (to, messages))
            return True

        #queue
        #self.__message_queue(to, messages)

        return False


bots = {}
#for bot_id, bot_cfg in cfg['line_bot'].items():
#    bots[bot_id] = LineBot(**bot_cfg)

def push_developer(messages):
    return bots['admin'].push(to=cfg['developer'], messages=messages)
