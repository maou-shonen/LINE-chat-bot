from api import cfg, is_image_and_ready
import requests.exceptions
from linebot import LineBotApi
from linebot.exceptions import LineBotApiError
from linebot.models import TextMessage, ImageSendMessage, TextSendMessage


class LineBot(LineBotApi):
    def __init__(self, access_token):
        LineBotApi.__init__(self, access_token)
        
    def send_message(self, to, msg):
        if type(to) == list:
            self.multicast(to, TextSendMessage(text=msg))
        else:
            self.push_message(to, TextSendMessage(text=msg))

    def reply_message(self, reply_token, messages):
        if messages is None:
            return

        if type(messages) == str:
            messages = [messages]
        
        message_object = []
        for message in messages[:5]:
            message = message.strip(' \n')
            if message == '' or message == '\n':
                message_object.append(TextSendMessage('<設定錯誤此為空白內容>'))
            if message[:6] == 'https:':
                message = message.strip(' \n')
                if is_image_and_ready(message):
                    message_object.append(ImageSendMessage(message, message))
                else:
                    message_object.append(TextSendMessage(message))
            else:
                if len(message) > 2000:
                    message = message[:2000]
                message_object.append(TextSendMessage(message))

        try:
            if len(message_object) > 0:
                while True:
                    try:
                        LineBotApi.reply_message(self, reply_token, message_object)
                        break
                    except requests.exceptions.ReadTimeout as e:
                        pass
        except LineBotApiError as e:
            Exception(''.join([
                '[錯誤內容]' + message,
                str(e.status_code),
                str(e.error.message),
                str(e.error.details),
            ]))


bots = {}
for bot_id, bot_token in cfg['line_bot'].items():
    bots[bot_id] = LineBot(bot_token)
