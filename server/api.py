import yaml
import requests

cfg = yaml.load(open('config.yaml', 'r', encoding='utf-8-sig'))

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
    

def is_image_and_ready(url):
    try:
        return (requests.head(url, timeout=5).headers.get('content-type') in ['image/jpeg', 'image/png'])
    except:
        return False
