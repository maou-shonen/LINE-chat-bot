import json
import requests
from api import cfg


def google_shorten_url(url):
    if cfg['google_api_key'] is None:
        return '此功能現在沒有開放喵'
    api_url = 'https://www.googleapis.com/urlshortener/v1/url?key=%s' % (cfg['google_api_key'])
    datas = {'longUrl': url}
    headers = {'content-type': 'application/json'}
    ret = requests.post(api_url, data=json.dumps(datas), headers=headers)
    try:
        return ret.json()['id']
    except:
        return '[網址格式錯誤]'


#pixiv功能暫時不理它
'''
from pixivpy3 import PixivAPI
try:
    pixiv_client = PixivAPI()
    pixiv_client.login(cfg['pixiv']['帳號'], cfg['pixiv']['密碼'])
except Exception as e:
    print('<pixiv模組初始失敗> %s' % str(e))
    pixiv_client = None
def pixiv_search(key):
    if pixiv_client is None:
        return '此功能現在沒有開放'
    pixiv_client.search_works(key, mode='tag')
    d = []
    for i in f['response']:
        d.append('(*%s) %s\n%s' % (i['stats']['favorited_count']['public'], i['title'], 'pixiv.net/member_illust.php?mode=medium&illust_id=' % i['id']))
        #圖 i['image_urls']['px_480mw']
    return d
'''
