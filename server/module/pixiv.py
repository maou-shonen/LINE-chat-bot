from threading import Thread 
from pixivpy3 import PixivAPI
from api import cfg


class Pixiv(Thread):
    search_on = 0.0 #最後查詢時間
    client = None

    def __init__(self):
        Thread.__init__(self)
        
    def __connect(self):
        if self.client is None:
            try:
                self.client = PixivAPI()
                self.client.login(cfg['pixiv']['帳號'], cfg['pixiv']['密碼'])
            except Exception as e:
                raise e
                return False
        return True

    def run(self):
        pass

    def search(self, key, number=30):
        if not self.__connect():
            return 'Pixiv模組發生錯誤 暫時不能使用'

        if number > 1000:
            number = 1000

        if key[0] == '@':
            result = self.client.users_works(int(key[1:]))
        else:
            result = self.client.search_works(
                key,
                page=1,
                per_page=number,
                mode='tag', # text標題 tag標籤 exact_tag精準標籤 caption描述
                period='all', # all所有 day一天內 week一週內 month一月內
                order='desc', # desc新順序 asc舊順序
                sort='date',
            )

        if result.status == 'failure':
            return '找不到 <%s>' % (key)

        result_rank = []
        for i in result.response:
            for i2 in result_rank:
                if i.stats.views_count > i2.stats.views_count:
                    result_rank.insert(result_rank.index(i2), i)
                    break
            else:
                result_rank.append(i)

        reply = []
        for i in result_rank:
            self.client.download(i.image_urls.px_480mw, path=cfg['temp_dir'], name=str(i.id)) #px_128x128 px_480mw
            print('%s\\%s' % (cfg['temp_dir'], i.id))
            url = imgur.upload('%s\\%s' % (cfg['temp_dir'], i.id))
            #url = 'http://temp.maou.pw/%s' % (i.id)
            reply.append(url)
            if len(reply) >= 4:
                break

        url = 'https://www.pixiv.net/search.php?word=123&s_mode=s_tag_full'
        reply = reply[:4]
        reply.append(url)
        return reply



    def rss(self):
        if not self.__connect():
            return 'Pixiv模組錯誤'
        


pixiv = Pixiv()

