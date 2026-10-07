"""Outbound HTTP services other than LINE: Safe Browsing, random.org,
imgur direct upload. Explicit timeouts everywhere."""
import json
import re

SAFE_BROWSING_URL = (
    "https://safebrowsing.googleapis.com/v4/threatMatches:find")
RANDOM_ORG_URL = ("https://www.random.org/integers/"
                  "?num=%s&min=0&max=%s&col=1&base=10&format=plain&rnd=new")
IMGUR_UPLOAD_URL = "https://api.imgur.com/3/image"

CLIENT_ID = "mao line bot"
CLIENT_VER = "1.0"
PLATFORM_TYPES = ["ANY_PLATFORM"]
THREAT_ENTRY_TYPES = ["URL"]
THREAT_TYPES = [
    "MALWARE",
    "SOCIAL_ENGINEERING",
    "UNWANTED_SOFTWARE",
    "POTENTIALLY_HARMFUL_APPLICATION",
    "THREAT_TYPE_UNSPECIFIED",
]
HEADERS = {"Content-Type": "application/json"}

THREAT_NAME = {
    "MALWARE": "惡意軟件",
    "SOCIAL_ENGINEERING": "社交工程攻擊",
    "UNWANTED_SOFTWARE": "不受歡迎軟體",
    "POTENTIALLY_HARMFUL_APPLICATION": "淺在危險軟體",
    "THREAT_TYPE_UNSPECIFIED": "未知類型",
}


def google_safe_browsing(http, api_key, message):
    urls = re.findall(
        r"http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\(\),]|"
        r"(?:%[0-9a-fA-F][0-9a-fA-F]))+",
        message)

    threat_entries = [{"url": url} for url in urls]

    body = {
        "client": {
            "clientId": CLIENT_ID,
            "clientVersion": CLIENT_VER,
        },
        "threatInfo": {
            "threatTypes": THREAT_TYPES,
            "platformTypes": PLATFORM_TYPES,
            "threatEntryTypes": THREAT_ENTRY_TYPES,
            "threatEntries": threat_entries,
        },
    }

    r = http.post(SAFE_BROWSING_URL, params={"key": api_key},
                  content=json.dumps(body), headers=HEADERS, timeout=10.0)

    if r.status_code != 200:
        return "Google網址檢查：查詢失敗"

    if len(r.json()) == 0:
        return None

    reply_message = ["Google網址檢查：危險！\n"]

    try:
        for i in r.json().get("matches"):
            url = i["threat"]["url"]
            threat = THREAT_NAME.get(i["threatType"], i["threatType"])
            reply_message.append("網址:%s\n類型:%s\n" % (url, threat))
    except Exception as e:
        reply_message.append("<報告產生失敗>\n%s" % str(e))

    return reply_message


def random_org_ints(http, count, weight_total):
    r = http.get(RANDOM_ORG_URL % (count, int(weight_total)), timeout=3.0)
    if "Error" in r.text:
        raise ValueError("random.org error")
    elif "<!DOCTYPE html>" in r.text:
        raise ValueError("random.org error")
    return r.text.split("\n")[:-1]


def upload_by_line(http, client_id, bot, message_id):
    chunks = []
    for chunk in bot.get_message_content(message_id).iter_content():
        chunks.append(chunk)
    data = b"".join(chunks)
    r = http.post(IMGUR_UPLOAD_URL,
                  headers={"Authorization": "Client-ID %s" % client_id},
                  files={"image": ("line-%s" % message_id, data)},
                  timeout=10.0)
    r.raise_for_status()
    return r.json()["data"]["link"]
