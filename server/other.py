import json
import requests
from api import cfg
from bs4 import BeautifulSoup
from urllib.parse import urlencode
from time import time, sleep
from database import db, UrlShortener


def google_shorten_url(url):
    if cfg['google.com']['api_key'] is None:
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
        link = UrlShortener.add(link)
        reply_messages.append('%s\n%s' % (result.text, link))
    
    if len(reply_messages) > 0:
        url = UrlShortener.add(url)
        reply_messages.append('<查詢更多>\n%s' % url)
        return '\n\n'.join(reply_messages)
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
        link = UrlShortener.add(link)
        reply_messages.append('%s\n%s' % (result.text, link))
    
    if len(reply_messages) > 0:
        url = UrlShortener.add(url)
        reply_messages.append('<查詢更多>\n%s' % url)
        return '\n\n'.join(reply_messages)
    return '沒有找到符合的結果喔'



client = None

exhentai_search_time = 0
def exhentai_search(key):
    global client
    if client is None:
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
        link = UrlShortener.add(link)
        reply_messages.append('%s\n%s' % (result.text, link))
    
    if len(reply_messages) > 0:
        url = UrlShortener.add(url)
        reply_messages.append('<查詢更多>\n%s' % url)
        return '\n\n'.join(reply_messages)
    return '沒有找到符合的結果喔'

