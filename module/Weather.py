'''
    天氣模組
'''
import os
from api import cfg, download
from time import time
from datetime import datetime
from lxml import etree
from module.ConfigFile import ConfigFile


DATA_TYPE = 'F-C0032-001'
DATA_URL  = 'http://opendata.cwb.gov.tw/opendataapi?authorizationkey=%s&dataid=%s' % (cfg['opendata.cwb.gov.tw']['api_key'], DATA_TYPE)
TMP_FILE  = '%s\%s.xml' % (cfg['temp_dir'], DATA_TYPE)

weathers = {}
weathers_time = 0


def __conver_date(dt):
    today = datetime.now()
    try:
        dt2 = datetime.strptime(dt, '%Y-%m-%dT%H:%M:%S+08:00')
        return '%s%s%s點' % (
            '今天' if dt2.day == today.day else '明天' if dt2.day == today.day+1 else '後天' if dt2.day == today.day+2 else '昨天' if dt2.day == today.day-1 else '%s/%s' % (dt2.month, dt2.day),
            '晚上' if dt2.hour >= 18 else '中午' if dt2.hour >= 12 else '早上' if dt2.hour >= 6 else '半夜',
            dt2.hour,
        )
    except Exception as e:
        return dt
            

def __update():
    global weathers
    download(DATA_URL, TMP_FILE)
    xml = etree.parse(TMP_FILE)
    root = xml.getroot()

    for node in root.iter('{urn:cwb:gov:tw:cwbcommon:0.1}location'):
        name = node.find('{urn:cwb:gov:tw:cwbcommon:0.1}locationName').text #城市名稱
        weathers[name] = {}
        
        for weather in node.iter('{urn:cwb:gov:tw:cwbcommon:0.1}weatherElement'):
            weather_type = weather.find('{urn:cwb:gov:tw:cwbcommon:0.1}elementName').text
            weathers[name][weather_type] = []

            for weather_value in weather.iter('{urn:cwb:gov:tw:cwbcommon:0.1}parameterName'):
                weathers[name][weather_type].append(weather_value.text)

        for weather_time in ['startTime', 'endTime']:
            weathers[name][weather_time] = []
            for t in weather.iter('{urn:cwb:gov:tw:cwbcommon:0.1}%s' % weather_time):
                if len(weathers[name][weather_time]) > 3:
                    break
                weathers[name][weather_time].append(t.text)


def get_weather(user, key):
    global weathers, weathers_time
    if time() - weathers_time > (60*60):
        try:
            __update()
            weathers_time = time()
        except Exception as e:
            raise e

    if key is None or key == '':
        try:
            loc = user.location
        except:
            loc = None
    else:
        loc = key

    if loc is not None:
        loc = loc.replace('台', '臺')
        if loc in ['馬祖', '東引', '西引', '莒光', '南竿']:
            loc = '連江縣'
        
        for localtion in weathers.keys():
            if loc in localtion:
                reply_message = ['[%s]' % (localtion)]
                
                for i in range(3):
                    start_time = __conver_date(weathers[localtion]['startTime'][i])
                    end_time = __conver_date(weathers[localtion]['endTime'][i])

                    reply_message.append('\n%s 到 %s' % (start_time, end_time))
                    reply_message.append('%s（降雨%s％）' % (weathers[localtion]['Wx'][i], weathers[localtion]['PoP'][i]))
                    reply_message.append('%s℃ - %s℃ %s' % (weathers[localtion]['MinT'][i], weathers[localtion]['MaxT'][i], weathers[localtion]['CI'][i]))

                reply_message.append('\n已紀錄你最後查詢的<%s>\n變更請輸入「天氣=<地點>」' % loc)
                reply_message.append('資料來自氣象開放平台\nopendata.cwb.gov.tw')

                if user:
                    user.location = loc

                return '\n'.join(reply_message)

    return '台中市輸入「天氣=台中」\n新北市輸入「天氣=新北」即可\n暫時只有台灣的氣象資料\n其他地方的之後會增加'
