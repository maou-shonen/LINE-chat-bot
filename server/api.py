import yaml
import requests


cfg  = yaml.load(open('config.yaml', 'r', encoding='utf-8-sig'))
text = yaml.load(open('text.yaml', 'r', encoding='utf-8-sig'))


class Cache(dict):
    def have(self, key):
        return key in self


from configparser import ConfigParser
class ConfigFile(ConfigParser):
    def __init__(self, path=None):
        ConfigParser.__init__(self, allow_no_value=True)
        self.optionxform = str #防止欄位自動轉小寫
        self.read(path, encoding='utf-8-sig')
        self.path = path

    def save(self):
        with open(self.path, 'w', encoding='utf-8-sig') as f:
            self.write(f)

    def set(self, section, option, value=None):
        if not self.has_section(section):
            self.add_section(section)
        ConfigParser.set(self, section, option, value)


def isValueHaveKeys(value, keys):
    for key in keys:
        if key in value:
            return True
    return False


def str2bool(s):
    if s in cfg['詞組']['是']:
        return True
    if s in cfg['詞組']['否']:
        return False
    raise Exception('str2bool 無法識別 <%s>' % s)

def isFloat(s):
    try:
        float(s)
        return True
    except:
        return False
    

is_image_and_ready_cache = {}
def is_image_and_ready(url):
    try:
        if url in is_image_and_ready_cache:
            ct = is_image_and_ready_cache[url]
        else:
            ct = requests.head(url, timeout=5).headers.get('content-type')
            is_image_and_ready_cache[url] = ct
        return ct in ['image/jpeg', 'image/png']
    except:
        return False

def getUrlType(url):
    try:
        ct, fe = requests.head(url, timeout=10).headers.get('content-type').split('/')

        return (requests.head(url, timeout=5).headers.get('content-type') in ['image/jpeg', 'image/png'])
    except:
        return '讀取過慢或發生錯誤 類型不明'
    if ct == 'text':
        return '一般網頁'
    if ct == 'image':
        if 1:
            return '圖片 %s ' % fe
        else:
            support = '格式支援' if fe in ['jpeg', 'png'] else '格式不支援'
        return '圖片 %s %s' % (fe, support)
    return '其他格式 目前不支援'


