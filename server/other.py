import json
import requests
from api import cfg
from bs4 import BeautifulSoup
from urllib.parse import urlencode
from time import time, sleep


def google_shorten_url(url):
    if cfg['google_api_key'] is None:
        return '此功能現在沒有開放喵'
    api_url = 'https://www.googleapis.com/urlshortener/v1/url?key=%s' % (cfg['google_api_key'])
    datas = {'longUrl': url}
    headers = {'content-type': 'application/json'}
    try:
        ret = requests.post(api_url, data=json.dumps(datas), headers=headers)
        return ret.json()['id']
    except:
        return url #'[網址格式錯誤]'


google_search_time = 0
def google_search(key):
    headers = {'user-agent':cfg['user_agent']}
    url = 'https://www.google.com.tw/search?' + urlencode({
        'q':key,
        'safe':'off',
        'aqs':'chrome.0.69i59j0l5.369j0j4',
        'sourceid':'chrome',
        'ie':'UTF-8',
    })
    global google_search_time
    while time() - google_search_time < 1:
        sleep(1.0)
    google_search_time = time() + 1

    r = requests.get(url, headers=headers)
    if not r.ok:
        print(r.text)
        return '愛醬搜尋失敗了！'
    reply_messages = []
    soup = BeautifulSoup(r.text, 'lxml')
    results = soup.select('h3.r a')
    for result in results[:5]:
        link = result.get('href')
        reply_messages.append('%s\n%s' % (result.text, link))
    
    if len(reply_messages) > 0:
        reply_messages.append('<查詢更多>\n%s' % url)
        return '\n\n'.join(reply_messages) + '\n(未來會添加短連結)'
    return '沒有找到符合的結果喔'


ehentai_search_time = 0
def ehentai_search(key):
    headers = {'User-Agent':cfg['user_agent']}
    url = 'https://e-hentai.org/?' + urlencode({
        'f_doujinshi':'1',
        'f_manga':'1',
        'f_artistcg':'1',
        'f_gamecg':'1',
        'f_western':'1',
        'f_non-h':'1',
        'f_imageset':'1',
        'f_cosplay':'1',
        'f_asianporn':'1',
        'f_misc':'1',
        'f_apply':'Apply+Filter',
        'f_search':key,
    })
    global ehentai_search_time
    while time() - ehentai_search_time < 1:
        sleep(1.0)
    ehentai_search_time = time() + 1

    r = requests.get(url, headers=headers)
    if not r.ok:
        return '愛醬搜尋失敗了！'
    reply_messages = []
    soup = BeautifulSoup(r.text, 'lxml')
    results = soup.select('.it5')
    for result in results[:5]:
        link = result.find('a').get('href')
        reply_messages.append('%s\n%s' % (result.text, link))
    
    if len(reply_messages) > 0:
        reply_messages.append('<查詢更多>\n%s' % url)
        return '\n\n'.join(reply_messages) + '\n(未來會添加短連結)'
    return '沒有找到符合的結果喔'




client = requests.Session()
client.headers.update({'User-Agent': cfg['user_agent']})
client.get('https://e-hentai.org')
client.post('https://forums.e-hentai.org/index.php?act=Login&CODE=01', data={
	'CookieDate': '1',
	'b': 'd',
	'bt': '1-1',
	'UserName':cfg['ehentai']['帳號'],
	'PassWord':cfg['ehentai']['密碼'],
	'ipb_login_submit':'Login!',
})

exhentai_search_time = 0
def exhentai_search(key):
    headers = {'User-Agent':cfg['user_agent']}
    url = 'https://exhentai.org/?' + urlencode({
        'f_doujinshi':'1',
        'f_manga':'1',
        'f_artistcg':'1',
        'f_gamecg':'1',
        'f_western':'1',
        'f_non-h':'1',
        'f_imageset':'1',
        'f_cosplay':'1',
        'f_asianporn':'1',
        'f_misc':'1',
        'f_apply':'Apply+Filter',
        'f_search':key,
    })
    global exhentai_search_time
    while time() - exhentai_search_time < 1:
        sleep(1.0)
    exhentai_search_time = time() + 1

    r = client.get(url)
    if not r.ok:
        return '愛醬搜尋失敗了！'
    reply_messages = []
    soup = BeautifulSoup(r.text, 'lxml')
    results = soup.select('.it5')
    for result in results[:5]:
        link = result.find('a').get('href')
        reply_messages.append('%s\n%s' % (result.text, link))
    
    if len(reply_messages) > 0:
        reply_messages.append('<查詢更多>\n%s' % url)
        return '\n\n'.join(reply_messages) + '\n(未來會添加短連結)'
    return '沒有找到符合的結果喔'


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
