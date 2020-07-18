import os
import yaml
import requests
from time import time, sleep

cfg  = yaml.safe_load(open('config.yaml', 'r', encoding='utf-8-sig'))
text = yaml.safe_load(open('text.yaml', 'r', encoding='utf-8-sig'))

DEBUG = os.environ.get('debug', 'False') in ['True', 'true']


def download(url, file_path, timeout=30):
    response = requests.get(url, stream=True, timeout=timeout)

    with open(file_path, "wb") as handle:
        for data in response.iter_content():
            handle.write(data)


def isValueHaveKeys(value, keys):
    for key in keys:
        if key in value:
            return True
    return False


def isFloat(s):
    try:
        float(s)
        return True
    except:
        return False


#############################################
# 產生一個較短的唯一ID
def get_id():
    num = '1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    size = len(num)
    sleep(0.01)
    t = int((time() - 1500000000) * 100)
    v = []
    while t >= len(num):
        v.insert(0, num[int(t%size)])
        t = int(t / size)
    return ''.join(v)


#############################################
# 檢查 A內容 類似於 B內容
is_text_like_list = [
    ['1', 'true', 'yes', 'y', 'on', '是', '真', '開', '開啟', '打開', '確定'],
    ['0', 'false', 'no', 'n', '否', '假', '關', '關閉', '取消'],
    ['me', 'my', 'myself', '自己', '自己的', '個人', '我', '我的'],
    ['all', 'full', '全部', '全', '所有', '完整'],
    ['set', 'setting', 'settings', '設定', '設置']
]

def is_text_like(a, b):
    for arr in is_text_like_list:
        if b in arr and a in arr:
            return True
    return False

def text2bool(text):
    if is_text_like(text, 'true'): return True
    if is_text_like(text, 'false'): return False
    raise Exception('無法辨識: %s' % text)


#############################################
# 常用的格式化處理  內建的{}會在yaml出現錯誤
def text_format(text, **argv):
    for key, value in argv.items():
        text = text.replace('<%s>' % key, value)
    return text
