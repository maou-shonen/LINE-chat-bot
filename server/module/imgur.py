###############################################
# imgur上傳
import os
from time import sleep
from imgurpython import ImgurClient
from api import cfg

class Imgur:
    client = None

    def _connect(self):
        if not self.client:
            try:
                self.client = ImgurClient(cfg['imgur.com']['id'], cfg['imgur.com']['secret'])
            except Exception as e:
                raise Exception('imgur連線錯誤: %s' % (str(e)))

    def upload(self, path, delete_on_uploaded=True):
        self._connect()

        for i in range(10):
            try:
                image = self.client.upload_from_path(path)
                break
            except Exception as e:
                sleep(1)
        else:
            raise Exception('imgur上傳錯誤: %s' % (str(e)))
        url = image['link']

        if delete_on_uploaded:
            os.remove(path)

        return url


    def uploadByLine(self, bot, message_id):
        self._connect()

        tmp_file = '%s\%s.tmp' % (cfg['temp_dir'], message_id)
        message_content = bot.get_message_content(message_id)

        with open(tmp_file, 'wb') as f:
            for chunk in message_content.iter_content():
                f.write(chunk)

        return self.upload(tmp_file)

imgur = Imgur()
