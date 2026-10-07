"""Thin typed client for the LINE Messaging API over httpx. Covers only
the endpoints the bot uses: reply, push, group/room member profile,
message content. Message shaping (text vs image, truncation, 5-message
cap) matches the legacy LineBot exactly."""
from collections import OrderedDict

import httpx

REPLY_PATH = "/v2/bot/message/reply"
PUSH_PATH = "/v2/bot/message/push"
PROFILE_GROUP_PATH = "/v2/bot/group/{group_id}/member/{user_id}"
PROFILE_ROOM_PATH = "/v2/bot/room/{room_id}/member/{user_id}"
CONTENT_PATH = "/v2/bot/message/{message_id}/content"

IMAGE_CONTENT_TYPES = ("image/jpeg", "image/png")
HEAD_CACHE_SIZE = 4096


def repair_image_url(message):
    if "imgur.com" in message:
        message = message.replace("http:", "https:")
        message = message.replace("m.imgur.com", "i.imgur.com")
        if message.split("/")[-1].find(".") == "-1":
            message += ".jpg"
    return message


class HeadCache(OrderedDict):
    def set(self, key, value):
        self[key] = value
        self.move_to_end(key)
        while len(self) > HEAD_CACHE_SIZE:
            self.popitem(last=False)


def format_messages(messages, is_image_and_ready, format=True):
    if type(messages) == str:
        messages = [messages]

    contents = []

    for message in messages:
        if message is None or type(message) != str:
            continue

        message = message.strip("|_ \n")
        if message == "":
            continue

        if not format:
            contents.append({"type": "text", "text": message})
            continue

        message = repair_image_url(message)

        if message[:6] == "https:":
            if "imgur.com" in message or is_image_and_ready(message):
                contents.append({
                    "type": "image",
                    "originalContentUrl": message,
                    "previewImageUrl": message,
                })
            else:
                contents.append({"type": "text", "text": message})
        else:
            if len(message) >= 1500:
                message = message[:1500] + "\n<字數過多 後略>"
            contents.append({"type": "text", "text": message})

    if len(contents) == 0:
        contents.append(
            {"type": "text", "text": "<此為空白內容>\n<由設定錯誤引發>"})

    return contents[:5]


class LineClient:
    def __init__(self, token, api_base="https://api.line.me",
                 data_api_base="https://api-data.line.me", timeout=10.0,
                 transport=None):
        self.token = token
        self.api_base = api_base.rstrip("/")
        self.data_api_base = data_api_base.rstrip("/")
        self.client = httpx.Client(
            timeout=timeout,
            transport=transport,
            headers={"Authorization": "Bearer %s" % token},
        )
        self.head_cache: OrderedDict[str, str | None] = HeadCache()

    def is_image_and_ready(self, url):
        try:
            if url in self.head_cache:
                ct = self.head_cache[url]
            else:
                ct = self.client.head(url).headers.get("content-type")
                self.head_cache.set(url, ct)
            return ct in IMAGE_CONTENT_TYPES
        except Exception:
            return False

    def format(self, messages, format=True):
        return format_messages(
            messages, self.is_image_and_ready, format=format)

    def reply(self, reply_token, content):
        r = self.client.post(self.api_base + REPLY_PATH, json={
            "replyToken": reply_token, "messages": content})
        r.raise_for_status()

    def push(self, to, content):
        r = self.client.post(self.api_base + PUSH_PATH, json={
            "to": to, "messages": content})
        r.raise_for_status()


    def get_group_member_profile(self, group_id, user_id):
        r = self.client.get(self.api_base + PROFILE_GROUP_PATH.format(
            group_id=group_id, user_id=user_id))
        r.raise_for_status()
        return r.json()

    def get_room_member_profile(self, room_id, user_id):
        r = self.client.get(self.api_base + PROFILE_ROOM_PATH.format(
            room_id=room_id, user_id=user_id))
        r.raise_for_status()
        return r.json()

    def get_message_content(self, message_id):
        r = self.client.get(self.data_api_base + CONTENT_PATH.format(
            message_id=message_id))
        r.raise_for_status()
        return r.content
