from api import cfg
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
            if message[:4] == 'http':
                message = message.strip()
                message_object.append(ImageSendMessage(message, message))
            elif message != '':
                if len(message) > 2048:
                    message = message[:2048]
                message_object.append(TextSendMessage(message))

        try:
            if len(message_object) > 0:
                LineBotApi.reply_message(self, reply_token, message_object)
        except LineBotApiError as e:
            print(e.status_code)
            print(e.error.message)
            print(e.error.details)


bots = {}
for bot_id, bot_token in cfg['line_bot'].items():
    bots[bot_id] = LineBot(bot_token)
