import yaml
import requests

cfg = yaml.load(open('config.yaml', 'r', encoding='utf-8-sig'))


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
