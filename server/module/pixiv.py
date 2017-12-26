from threading import Thread 
from api import cfg
from pixivpy3 import PixivAPI

try:
    pixiv_client = PixivAPI()
    pixiv_client.login(cfg['pixiv']['帳號'], cfg['pixiv']['密碼'])
except Exception as e:
    print('<pixiv模組初始失敗> %s' % str(e))
    pixiv_client = None


class Pixiv(Thread):
    def __init__(self):
        Thread.__init__(self)
        
    def run(self):
        self.client = PixivAPI()
        self.client.login(cfg['pixiv']['帳號'], cfg['pixiv']['密碼'])

        while True:



def pixiv_search(key):
    if pixiv_client is None:
        return '此功能現在沒有開放'
    f = pixiv_client.search_works(key, mode='tag')
    d = []
    for i in f['response']:
        d.append('(*%s) %s\n%s' % (i['stats']['favorited_count']['public'], i['title'], 'pixiv.net/member_illust.php?mode=medium&illust_id=' % i['id']))
        #圖 i['image_urls']['px_480mw']
    return d