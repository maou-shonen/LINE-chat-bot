import requests
import json 
import re
from api import cfg

SB_CLIENT_ID = "mao line bot"
SB_CLIENT_VER = "1.0"


class LookupAPI(object):

    
    def __init__(self, apikey):

        self.apiurl = 'https://safebrowsing.googleapis.com/v4/threatMatches:find?key=%s' % (apikey)
        self.platform_types = ['WINDOWS']
        self.threat_types = ['THREAT_TYPE_UNSPECIFIED',
                             'MALWARE', 
                             'SOCIAL_ENGINEERING', 
                             'UNWANTED_SOFTWARE', 
                             'POTENTIALLY_HARMFUL_APPLICATION']
        self.threat_entry_types = ['URL']

    def set_threat_types(self, threats):

        self.threat_types = threats

    def set_platform_types(self, platforms): 
        
        self.platform_types = platforms

    def threat_matches_find(self, *urls): 
     
        threat_entries = []
        results = {}
 
        for url_ in urls: 
            url = {'url': url_} 
            threat_entries.append(url)
 
        reqbody = {
            'client': {
                 'clientId': SB_CLIENT_ID,
                 'clientVersion': SB_CLIENT_VER
            },
            'threatInfo': {
                'threatTypes': self.threat_types,
                'platformTypes': self.platform_types,
                'threatEntryTypes': self.threat_entry_types,
                'threatEntries': threat_entries
            }
        }
        
        headers = {'Content-Type': 'application/json'}
        r = requests.post(self.apiurl, 
                          data=json.dumps(reqbody), 
                          headers=headers)
        #
        # need to include exceptions here 
        #

        return r.json()

apikey = cfg['google_api_key']
sb = LookupAPI(apikey)

def google_safe_browsing(message):
    urls = re.findall('http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+', message)
    resp = sb.threat_matches_find(*urls)

    if len(resp) == 0:
        return 'Google網址檢查：安全'
    return 'Google網址檢查：危險\n\n暫時沒有報告整理請從\nhttps://goo.gl/m5sBUu\n進行查詢'

