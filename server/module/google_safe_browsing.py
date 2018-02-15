import requests
import json 
import re
from api import cfg


CLIENT_ID = 'mao line bot'
CLIENT_VER = '1.0'

API_URL = 'https://safebrowsing.googleapis.com/v4/threatMatches:find?key=%s' % (cfg['google_api_key'])
PLATFORM_TYPES = ['ANY_PLATFORM']
THREAT_ENTRY_TYPES = ['URL']
THREAT_TYPES = [
    
    'MALWARE', 
    'SOCIAL_ENGINEERING', 
    'UNWANTED_SOFTWARE', 
    'POTENTIALLY_HARMFUL_APPLICATION',
    'THREAT_TYPE_UNSPECIFIED',
]
headers = {'Content-Type': 'application/json'}

THREAT_NAME = {
    'MALWARE':'惡意軟件',
    'SOCIAL_ENGINEERING':'社交工程攻擊',
    'UNWANTED_SOFTWARE':'不受歡迎軟體',
    'POTENTIALLY_HARMFUL_APPLICATION':'淺在危險軟體',
    'THREAT_TYPE_UNSPECIFIED':'未知類型',
}


def google_safe_browsing(message):
    urls = re.findall('http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+', message)

    threat_entries = [{'url':url} for url in urls]

    body = {
        'client': {
            'clientId': CLIENT_ID,
            'clientVersion': CLIENT_VER
        },
        'threatInfo': {
            'threatTypes': THREAT_TYPES,
            'platformTypes': PLATFORM_TYPES,
            'threatEntryTypes': THREAT_ENTRY_TYPES,
            'threatEntries': threat_entries
        }
    }

    r = requests.post(
        API_URL,
        data=json.dumps(body), 
        headers=headers
    )

    if not r.ok:
        return 'Google網址檢查：查詢失敗'

    if len(r.json()) == 0:
        return None

    reply_message = ['Google網址檢查：危險！\n']

    try:
        for i in r.json().get('matches'):
            url = i['threat']['url']
            threat = THREAT_NAME.get(i['threatType'], i['threatType'])
            reply_message.append('網址:%s\n類型:%s\n' % (url, threat))
    except Exception as e:
        reply_message.append('<報告產生失敗>\n%s' % str(e))

    return reply_message
