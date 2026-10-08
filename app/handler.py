"""Message handling: verbatim port of the legacy EventText semantics —
full-width quote normalization, lowercase-on-write, reply DSL (weights,
multi-draw, pity pools, seeding, percentage mode, protected keywords),
router order, and the exact order of random calls — on SQLAlchemy 2.x
sessions and the typed LINE client. Only deliberate fixes differ
(recorded in tests/README.md): 意見 pushes to the developer when
DEVELOPER_USER_ID + DEVELOPER_BOT_TOKEN are set, else replies that
feedback isn't configured; the check() error path logs instead of
calling a nonexistent admin client."""
import json
import random as random_module
import re
import time
from datetime import datetime
from hashlib import md5

from loguru import logger
from sqlalchemy import func

from . import services
from .db import Group, GroupUser, User, UserKeyword, UserSettings
from .texts import OWN_WORDS, is_text_like, isFloat, text, text2bool, text_format


def _error_status(e):
    status = getattr(getattr(e, "response", None), "status_code", None)
    return " status=%s" % status if status is not None else ""


class Bot:
    """Per-token sender bound to one LINE channel access token."""

    def __init__(self, client, push=False):
        self.client = client
        self.can_push = push

    @property
    def token(self):
        return self.client.token

    def push(self, to, messages, reply_token=None, format=True, source=None):
        if type(messages) != list:
            messages = [messages]

        if len(messages) == 0:
            return False

        if reply_token:
            content = self.client.format(messages, format=format)
            try:
                self.client.reply(reply_token, content)
                return True
            except Exception as e:
                logger.warning("傳送失敗 source=%s count=%d%s error=%s" % (
                    source, len(content), _error_status(e), type(e).__name__))
                logger.debug("傳送失敗 content=%s" % (content,))
                return False

        elif self.can_push:
            while len(messages) > 0:
                content = self.client.format(
                    messages.pop(0), format=format)
                try:
                    self.client.push(to, content)
                except Exception as e:
                    logger.warning("傳送失敗 source=%s count=1%s error=%s" % (
                        source, _error_status(e), type(e).__name__))
                    logger.debug("傳送失敗 content=%s" % (content,))
            return True

        return False

    def get_group_member_profile(self, group_id, user_id):
        d = self.client.get_group_member_profile(group_id, user_id)
        return type("Profile", (), {"display_name": d.get("displayName")})()

    def get_room_member_profile(self, room_id, user_id):
        d = self.client.get_room_member_profile(room_id, user_id)
        return type("Profile", (), {"display_name": d.get("displayName")})()

    def get_message_content(self, message_id):
        data = self.client.get_message_content(message_id)

        class Content:
            def iter_content(self, chunk_size=1024):
                yield data

        return Content()


def push_developer(ctx, messages):
    if not ctx.developer_user_id or not ctx.developer_token:
        return False
    client = ctx.line_client_factory(ctx.developer_token)
    client.push(ctx.developer_user_id, client.format(messages))
    return True


class Ctx:
    def __init__(self, store, settings, http, bots,
                 line_client_factory, time_now=None, epoch=None,
                 monotonic=None):
        self.store = store
        self.settings = settings
        self.http = http
        self.bots = bots
        self.line_client_factory = line_client_factory
        self.time_now = time_now or datetime.now
        self.epoch = epoch or time.time
        self.monotonic = monotonic or time.monotonic
        self.developer_user_id = settings.DEVELOPER_USER_ID
        self.developer_token = settings.DEVELOPER_BOT_TOKEN

    def get_bot(self, token):
        if token not in self.bots:
            self.bots[token] = Bot(
                self.line_client_factory(token), push=False)
        return self.bots[token]


class EventText:
    bot_id = None
    user_id = None
    group_id = None
    message = None
    reply_token = None
    sticker = None
    image = None
    message_id = None

    def __init__(self, ctx, session, **argv):
        self.ctx = ctx
        self.session = session
        self.__dict__.update(**argv)

        self.bot = ctx.bots.get(self.bot_id, None)

        self.user = session.get(User, self.user_id) if self.user_id else None
        if self.user_id:
            if not self.user:
                self.user = User(self.user_id)
                session.add(self.user)

        self.group = session.get(Group, self.group_id) \
            if self.group_id else None
        if self.group_id:
            if not self.group:
                self.group = Group(self.group_id)
                session.add(self.group)
            self.group._json()

        self.group_data = session.query(GroupUser).filter(
            func.coalesce(GroupUser.gid, "") == (self.group_id or ""),
            func.coalesce(GroupUser.uid, "") == (self.user_id or ""),
        ).order_by(GroupUser._id).first() if self.group_id else None
        if self.group_id:
            if not self.group_data:
                self.group_data = GroupUser(self.group_id, self.user_id)
                session.add(self.group_data)
            self.group_data._json()

        if self.message:
            self.message = self.message.replace('"', "＂").replace(
                "'", "’").replace(";", "；")
            self.order, *self.value = self.message.split("=")
            self.order = self.order.lower()
            self.key = self.value[0].strip(" \n") \
                if len(self.value) > 0 else None
            self.value = "=".join(self.value[1:]).strip(" \n") \
                if len(self.value) > 1 else None
            if self.key == "":
                self.key = None
            if self.value == "":
                self.value = None

    def _count(self, values):
        if self.group is None:
            return

        for key, value in values.items():
            if key in self.group_data.count:
                self.group_data.count[key] += value
            else:
                self.group_data.count[key] = value

    def run(self):
        session = self.session
        try:
            self.run2()
            session.commit()
        except Exception as e:
            session.commit()
            try:
                if not push_developer(
                        self.ctx, "<愛醬BUG>\n%s" % str(e)):
                    logger.warning("error report not configured error=%s" % (
                        type(e).__name__))
                    logger.debug("error report not configured: %s" % e)
                self.bot.push(self.group.id,
                              "愛醬出錯了！\n作者可能會察看此錯誤報告",
                              reply_token=self.reply_token,
                              source="group" if self.group else "user")
            except Exception:
                logger.warning("傳送失敗")
            raise e
        finally:
            session.close()

    def run2(self):
        _time = self.ctx.monotonic

        if self.message:
            source = "group" if self.group else "user"
            logger.debug("text message=%s" % (self.message,))

            t0 = _time()
            reply_message = self.index()
            t1 = _time() - t0

            if reply_message is None:
                reply_message = []
            elif type(reply_message) == str:
                reply_message = [reply_message]

            n = len(reply_message)
            if self.bot:
                if self.bot.push(
                        self.group.id if self.group else self.user.id,
                        reply_message, reply_token=self.reply_token,
                        source=source):
                    t2 = _time() - t1 - t0
                    logger.debug("text reply=%s" % (reply_message,))
                    logger.info("text source=%s matched=yes count=%d (%dms, %dms)" % (
                        source, n, t1 * 1000, t2 * 1000))
                else:
                    logger.debug("text reply=%s" % (reply_message,))
                    logger.info("text source=%s matched=no count=%d (%dms)" % (
                        source, n, t1 * 1000))
            else:
                logger.debug("text reply=%s" % (reply_message,))
                logger.info("text source=%s matched=no count=%d (%dms)" % (
                    source, n, t1 * 1000))

        elif self.sticker:
            reply_message = []
            self._count({"貼圖": 1})

        elif self.image:
            reply_message = []
            self._count({"圖片": 1})

            if not self.group:
                try:
                    content = services.upload_by_line(
                        self.ctx.http, self.ctx.settings.IMGUR_CLIENT_ID,
                        self.bot, self.message_id)
                except Exception as e:
                    content = str(e)
                self.bot.push(self.user.id, content,
                              reply_token=self.reply_token, format=False,
                              source="user")

        if self.user:
            try:
                self.user.name = self.bot.get_group_member_profile(
                    self.group.id, self.user.id).display_name
            except Exception:
                try:
                    self.user.name = self.bot.get_room_member_profile(
                        self.group.id, self.user.id).display_name
                except Exception:
                    pass
            self.user.update()
        if self.group:
            self.group.update()
            self.group_data.update()
        self.session.commit()

        return reply_message

    def index(self):
        if self.group:
            if self.order in ["-s", "set", "settings", "設定", "設置"]:
                return self.settings()
            elif self.order in ["愛醬安靜", "愛醬閉嘴", "愛醬睡覺", "愛醬下線"]:
                return self.sleep()
            elif self.order in ["愛醬講話", "愛醬說話", "愛醬聊天",
                                 "愛醬起床", "愛醬起來", "愛醬上線"]:
                return self.wake_up()
            elif self.order in ["log", "logs", "紀錄", "回憶"]:
                return self.logs()
        else:
            pass

        if self.order in ["-?", "-h", "help", "說明", "指令", "命令"]:
            return text["指令說明"]
        elif self.order in ["-l", "list", "列表"]:
            return self.list()
        elif self.order in ["-a", "add", "keyword", "新增", "關鍵字", "學習"]:
            return self.add()
        elif self.order in ["-a+", "add+", "keyword+", "新增+", "關鍵字+",
                             "學習+"]:
            return self.add_plus()
        elif self.order in ["-d", "delete", "del", "刪除", "移除"]:
            return self.delete()
        elif self.order in ["-o", "opinion", "意見", "建議", "回報", "檢舉"]:
            return self.opinion()
        else:
            return self.main()

    def sleep(self):
        h = int(self.key) if self.key and self.key.isdigit() else 12
        t = self.ctx.epoch() + 60 * 60 * (24 * 7 if h > 24 * 7 else 1 if h < 1 else h)
        UserSettings.update(
            self.session, self.group_id, "__sleep__", {"暫停": t})
        return "%s\n(%s)" % (
            text["睡覺"], datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M"))

    def wake_up(self):
        row = UserSettings._lookup(self.session, self.group_id, "__sleep__")
        opts = {}
        if row is not None:
            opts = json.loads(row.options)
        if "暫停" in opts:
            opts.pop("暫停")
            row.options = json.dumps(opts)
            return text["睡醒"]
        else:
            return text["沒睡"]

    def list(self):
        reply_message = []
        if self.group is None or self.key in OWN_WORDS:
            if self.user is None:
                return text["權限不足"]
            else:
                reply_message.append("現在群組中預設不使用個人詞庫\n有需要請用「設定」開啟")
                reply_message.append("\n".join(
                    [k.keyword for k in UserKeyword.get(
                        self.session, self.user.id)]))
        else:
            reply_message.append("「列表=我」查詢自己")
            reply_message.append("\n".join(
                [k.keyword for k in UserKeyword.get(
                    self.session, self.group.id)]))

        return "\n".join(reply_message)

    def add(self, plus=False):
        if self.key is None:
            return text["學習說明"]

        self.key = self.key.lower()
        while "***" in self.key:
            self.key = self.key.replace("***", "**")

        if self.value is None:
            if self.group:
                row = UserKeyword.get(self.session, self.group.id, self.key)
            else:
                row = UserKeyword.get(self.session, self.user.id, self.key)
            if row:
                return text_format(
                    text["關鍵字查詢成功"], key=self.key, value=row.reply)
            else:
                return text_format(text["關鍵字查詢失敗"], key=self.key)

        self._count({"調教": 1})

        self.value = re.sub(r"\|{3,}", "||", self.value)
        self.value = re.sub(r"_{3,}", "__", self.value)

        ban_key = ["**", "** **", "愛醬**", "**愛醬**"]
        if self.key in ban_key:
            return "%s\n%s" % (text["關鍵字禁用"], text["分隔符"].join(ban_key))

        if self.value[:2] == "##":
            return "由於規則問題 沒辦法使用##開頭的內容喔"

        if self.key != text["名稱"] and self.key[:2] == text["名稱"]:
            self.key = self.key[2:].strip(" \n")

        n = self.value.rfind("##")
        if n > -1 and "保護" in self.value[n:] and self.key[:2] == "**" \
                and self.key[-2:] == "**":
            return "為了避免過度觸發\n保護模式關鍵字不接受前後**喔"

        reply_message = ["%s 新增 <%s> " % (
            self.user.name if self.user else "", self.key)]

        try:
            if self.group:
                UserKeyword.add_and_update(
                    self.session, self.group_id, self.user_id,
                    self.key, self.value, plus=plus)
            else:
                UserKeyword.add_and_update(
                    self.session, self.user_id, self.user_id,
                    self.key, self.value, plus=plus)

        except Exception as e:
            return "學習失敗: %s" % str(e)

        level = len(self.key) - self.key.count("**") * (len("**") + 1)
        if level < 0:
            reply_message.append("\n愛醬非常不建議這種會過度觸發的詞喔\n請慎用")
        elif level == 0:
            reply_message.append("\n這種容易觸發的詞容易造成過多訊息喔\n請注意使用")
        elif level >= 7:
            reply_message.append("\n這種詞命中率較低喔 請善加利用萬用字元雙米號")

        if "*" in self.key and "**" not in self.key:
            reply_message.append("\n愛醬發現你似乎要使用萬用字元?\n如果是的話請把 *(單米號) 換成 **(雙米號)")
        if "_" in self.value and self.value.count("__") == 0:
            reply_message.append("\n愛醬發現你似乎要使用隨機模式?\n如果是的話請把 _(單底線) 換成 __(雙底線)")

        if self.group is None:
            reply_message.append("\n現在個人詞庫預設是不會在群組觸發的喔\n請在群組設定開啟全回應模式(預設開)或開啟個人詞庫(預設關)")
        else:
            n = self.value.rfind("##")
            if n > -1 and "保護" in self.value[n:]:
                reply_message.append("\n(此為保護關鍵字 只有你可以刪除及修改 為了避免爭議 建議不要濫用)")

        return "".join(reply_message)

    def add_plus(self):
        if self.key is None:
            return text["學習說明+"]

        return self.add(plus=True)

    def delete(self):
        if self.key is None:
            return "格式:\n刪除=<關鍵字>"

        self._count({"調教": 1})

        if self.key != text["名稱"] and self.key[:2] == text["名稱"]:
            self.key = self.key[2:].strip(" \n")

        self.key = self.key.lower()
        reply_message = ["%s 刪除 <%s>" % (
            self.user.name if self.user else "", self.key)]

        try:
            if self.group:
                if UserKeyword.delete(
                        self.session, self.group_id, self.user_id, self.key):
                    reply_message.append(" 成功")
            if self.user:
                if UserKeyword.delete(
                        self.session, self.user_id, self.user_id, self.key):
                    reply_message.append(" 成功")

        except Exception as e:
            return "刪除失敗: %s" % str(e)

        return "".join(reply_message) if len(reply_message) > 1 \
            else "喵喵喵? 愛醬不記得<%s>" % (self.key)

    def opinion(self):
        if self.key is None:
            return text["回報說明"]

        self._count({"觸發": 1})

        if push_developer(
                self.ctx, "%s\n%s\n%s\n%s" % (
                    self.bot_id, self.group_id, self.user_id, self.message)):
            return text["回報完成"]
        return "回報功能尚未設定，著急的話請直接聯絡開發者"

    def settings(self):
        if self.key is None:
            return [
                "設定=別理我=開/關\n"
                "設定=個人詞庫=開/關\n"
                "設定=全回應=開/關\n"
                "設定=全圖片=開/關(需要全回應)\n"
                "設定=幫忙愛醬=開/關\n"
                "\n"
                "(不輸入值可查看說明)",

                UserSettings.show(self.session, self.group_id, self.user_id),
            ]

        try:
            if self.key in ["過濾髒話", "髒話過濾"]:
                return "這設定已經移除了"

            if self.key == "全回應":
                if self.value is None:
                    return "開啟後愛醬開頭的對話將從全部的詞庫中產生反應\n「預設:關」"
                UserSettings.update(self.session, self.group_id, None,
                                    {"全回應": text2bool(self.value)})
                return "設定完成"

            if self.key == "全圖片":
                if self.value is None:
                    return "開啟後全回應的結果包含圖片\n(需要開啟全圖片)\n(注意:圖片沒有任何審核 有可能出現不適圖片 如可接受再開啟)\n「預設:關」"
                UserSettings.update(self.session, self.group_id, None,
                                    {"全圖片": text2bool(self.value)})
                return "設定完成"

            if self.key == "幫忙愛醬":
                if self.value is None:
                    return "開啟後會快取群組的對話紀錄\n只用於機器學習\n作者會稍微過目後進行分類丟入程式\n用完後刪除「預設:關」\n使用「設定=幫忙愛醬=開」開啟"
                UserSettings.update(self.session, self.group_id, None,
                                    {"幫忙愛醬": text2bool(self.value)})
                return "設定完成"

            if self.key == "別理我":
                if self.value is None:
                    return "開啟後愛醬不會在此群組對你產生回應\n(愛醬開頭還是可以強制呼叫)\n「預設:關」"
                if self.user_id is None:
                    return text["權限不足"]
                UserSettings.update(self.session, self.group_id, self.user_id,
                                    {"別理我": text2bool(self.value)})
                return "設定完成"

            if self.key == "個人詞庫":
                if self.value is None:
                    return "開啟後會對你的個人詞庫產生回應\n「預設:關」"
                if self.user_id is None:
                    return text["權限不足"]
                UserSettings.update(self.session, self.group_id, self.user_id,
                                    {"個人詞庫": text2bool(self.value)})
                return "設定完成"

            return "沒有此設定喔"
        except Exception as e:
            return "設定錯誤 <%s>" % str(e)

    def logs(self):
        score_default = {
            "調教": 30,
            "觸發": 10,
            "對話": 1,
            "貼圖": 1,
            "圖片": 1,
            "網頁": 0.5,
            "髒話": -10,
            "字數": 0.1,
        }

        def _score(group_data):
            score = 0
            for key, value in score_default.items():
                score += group_data.count.get(key, 0) * self.group.count.get(
                    key, value)
            return score

        def _get(user):
            group_data = self.session.query(GroupUser).filter(
                func.coalesce(GroupUser.gid, "") == (self.group.id or ""),
                func.coalesce(GroupUser.uid, "") == (user.id or ""),
            ).order_by(GroupUser._id).first()
            if group_data is None:
                group_data = GroupUser(self.group.id, user.id)
                self.session.add(group_data)
            group_data._json()
            score = _score(group_data)

            return "\n".join([
                "愛醬記得 %s" % (user.name if user.name else "你"),
                "調教愛醬 %d 次" % (group_data.count.get("調教", 0)),
                "跟愛醬說話 %d 次" % (group_data.count.get("觸發", 0)),
                "有 %d 次對話" % (group_data.count.get("對話", 0)),
                "有 %d 次貼圖" % (group_data.count.get("貼圖", 0)),
                "有 %d 次圖片" % (group_data.count.get("圖片", 0)),
                "有 %d 次傳送門" % (group_data.count.get("網頁", 0)),
                "講過 %d 次「幹」" % (group_data.count.get("髒話", 0)),
                "總計 %d 個字" % (group_data.count.get("字數", 0)),
                "----------",
                "總分 %d" % (score if score > 0 else 0),
            ])

        if is_text_like(self.key, "自己"):
            if self.user is None:
                return text["權限不足"]

            if self.user.id not in self.group.count:
                self._count({})
            return _get(self.user)

        elif self.key in ["rank", "排名", "排行"]:
            rank = []
            for row in self.session.query(GroupUser).filter_by(
                    gid=self.group.id):
                if row.uid is None:
                    continue
                user = self.session.get(User, row.uid)
                if user is None:
                    continue
                row._json()
                score = _score(row)
                for u in rank[:10]:
                    if score > u["score"]:
                        rank.insert(rank.index(u), {"user": user,
                                                   "score": score})
                        break
                else:
                    if len(rank) < 3:
                        rank.append({"user": user, "score": score})

            if len(rank) < 3:
                return "群組說話的不足3人\n(沒有權限等同不存在)"

            n = 0
            reply_message = []
            for u in rank[:10]:
                n += 1
                reply_message.append("第%s名 %s 分！\n%s " % (
                    n, int(u["score"]), u["user"].name))
            return "\n\n".join(reply_message)

        elif is_text_like(self.key, "設定"):
            values = []
            for key, value in score_default.items():
                values.append("%s = %s" % (
                    key, self.group.count.get(key, value)))
            return "目前分數設定為:\n%s\n\n調整方法為\n「回憶=類型=值」\n栗子\n回憶=對話=5" % "\n".join(
                values)

        elif self.key in list(score_default.keys()):
            if not isFloat(self.value):
                return "<%s>不是數字喔" % (self.value)
            self.group.count[self.key] = float(self.value)
            return "設定完成"

        elif is_text_like(self.key, "全部"):
            total = {}.fromkeys(
                ["人數", "調教", "觸發", "對話", "貼圖", "圖片", "網頁",
                 "髒話", "字數"], 0)
            for row in self.session.query(GroupUser).filter_by(
                    gid=self.group.id):
                row._json()
                total["人數"] += 1
                for key in score_default.keys():
                    total[key] += row.count.get(key, 0)

            return "\n".join([
                "愛醬記得這個群組...",
                "有 %d 個人說過話" % total["人數"],
                "愛醬被調教 %d 次" % (total["調教"]),
                "跟愛醬說話 %d 次" % (total["觸發"]),
                "有 %d 次對話" % (total["對話"]),
                "有 %d 次貼圖" % (total["貼圖"]),
                "有 %d 次圖片" % (total["圖片"]),
                "有 %d 次傳送門" % (total["網頁"]),
                "講過 %d 次「幹」" % (total["髒話"]),
                "總計 %d 個字" % (total["字數"]),
            ])

        elif self.key in ["clean", "clear", "清除"]:
            if is_text_like(self.value, "全部"):
                self.session.query(GroupUser).filter_by(
                    gid=self.group.id).delete()
                return "好好好！愛醬就當作大家什麼都沒說過吧！"
            else:
                users = {}
                for row in self.session.query(GroupUser).filter_by(
                        gid=self.group.id):
                    if row.uid is None:
                        continue
                    user = self.session.get(User, row.uid)
                    if user is None or user.name is None:
                        continue
                    if self.value == user.name:
                        users[user.id] = user
                        break
                    if self.value in user.name:
                        users[user.id] = user

                if len(users) == 0:
                    return "找不到 <%s>\n可能是\n1.名稱輸入錯誤\n2.該人沒有說過話\n3.權限不足" % (
                        self.value)
                if len(users) > 1:
                    return "查詢到 %s 人\n請輸入更完整的名稱" % (len(users))

                for uid, user in users.items():
                    self.session.query(GroupUser).filter_by(
                        gid=self.group.id, uid=uid).delete()
                    return f"{user.name}...是誰?"

        elif self.key:
            users = {}
            self.key = self.key.strip("@ \n")
            for row in self.session.query(GroupUser).filter_by(
                    gid=self.group.id):
                if row.uid is None:
                    continue
                user = self.session.get(User, row.uid)
                if user is None or user.name is None:
                    continue
                if self.key == user.name:
                    return _get(user)
                if self.key in user.name:
                    users[user.id] = user

            if len(users) == 0:
                return "找不到 <%s>\n可能是\n1.名稱輸入錯誤\n2.該人沒有說過話\n3.權限不足" % (
                    self.key)
            if len(users) > 1:
                return "查詢到 %s 人\n請輸入更完整的名稱" % (len(users))
            return _get(list(users.values())[0])

        return "\n".join([
            "「回憶=我」　　查詢自己",
            "「回憶=全部」　查詢全部",
            "「回憶=<名字>」查詢別人",
            "「回憶=設定」　查詢設定",
            "「回憶=清除=全部」　清除群組全對話次數紀錄 (無法復原)",
            "「回憶=清除=<名字>」　清除群組某人的對話次數紀錄 (無法復原)",
        ])

    def main(self):
        if "http:" in self.message or "https:" in self.message:
            if self.group:
                self._count({"網頁": 1})
                return services.google_safe_browsing(
                    self.ctx.http, self.ctx.settings.GOOGLE_SAFE_BROWSING_KEY,
                    self.message)

        self.message = self.message.lower().strip(" \n")
        self._count({
            "對話": 1,
            "髒話": self.message.count("幹") + self.message.count("fuck"),
            "字數": len(self.message),
        })

        if self.message == "":
            return None

        if self.group:
            if self.message != text["名稱"] and self.message[:2] == text["名稱"]:
                message_old = self.message
                self.message = self.message[2:].strip(" \n　")
                reply_message = self.check(
                    UserKeyword.get(self.session, self.group_id))
                if reply_message:
                    return reply_message

                reply_message = self.check(
                    UserKeyword.get(self.session, self.user_id))
                if reply_message:
                    return reply_message
                self.message = message_old

        sleep_until = self._sleep_until()
        if sleep_until is not None:
            if self.ctx.epoch() > sleep_until:
                self._clear_sleep_row()
                return text["睡醒"]
        else:
            if not self.group or (self.user and UserSettings.get(
                    self.session, self.group.id, self.user.id,
                    "個人詞庫", False)):
                reply_message = self.check(
                    UserKeyword.get(self.session, self.user.id))
                if reply_message:
                    return reply_message

            if self.group and self.user:
                if not UserSettings.get(
                        self.session, self.group.id, self.user.id,
                        "別理我", False):
                    reply_message = self.check(
                        UserKeyword.get(self.session, self.group.id))
                    if reply_message:
                        return reply_message

        if self.message[:2] == text["名稱"] or self.group_id is None:
            if self.group is None or UserSettings.get(
                    self.session, self.group_id, None, "全回應",
                    default=False):
                if self.message != text["名稱"] and self.message[:2] == text[
                        "名稱"]:
                    self.message = self.message[2:].strip(" \n　")

                reply_message = self.check(
                    UserKeyword.probe_all_reply(self.session, self.message),
                    all_reply=True)
                if reply_message:
                    return reply_message
                if self.group:
                    return random_module.choice(text["未知"])
            else:
                return random_module.choice(text["未知"]) + "\n(全回應模式關閉)\n使用「設定」開啟"

        if self.group_id is None:
            return text["預設回覆"]
        else:
            return None

    def _sleep_until(self):
        row = self._sleep_row()
        if row is None:
            return None
        return json.loads(row.options).get("暫停")

    def _sleep_row(self):
        return UserSettings._lookup(
            self.session, self.group_id, "__sleep__")

    def _clear_sleep_row(self):
        row = self._sleep_row()
        opts = json.loads(row.options)
        opts.pop("暫停", None)
        row.options = json.dumps(opts)

    def check(self, userkeyword_list, all_reply=False):
        exclude_url = all_reply and not (
            not self.group or UserSettings.get(
                self.session, self.group.id, None, "全圖片", default=False))

        keys = []
        result = []

        for row in userkeyword_list:
            row_reply = row.reply

            if row_reply[:1] == "@":
                if all_reply:
                    continue
                else:
                    row_reply = row.reply[1:]

            if exclude_url and "https:" in row_reply:
                continue

            if row.keyword == self.message:
                if all_reply:
                    result.append(row_reply)
                else:
                    return self.later(row_reply)
            elif row.keyword.replace("**", "") == self.message:
                result.append(row_reply)
            elif not all_reply or len(row_reply) > 1:
                keys.append((row.keyword, row_reply))

        if len(result) > 0:
            return self.later(random_module.choice(result))

        results = {}
        result_level = -99
        for k, v in keys:
            try:
                kn = -1
                k_arr = k.split("**")
                for k2 in k_arr:
                    if k2 != "":
                        n = self.message.find(k2)
                        if n > kn:
                            kn = n
                        else:
                            break
                    if k_arr[0] != "" and self.message[0] != k[0]:
                        break
                    if k_arr[-1] != "" and self.message[-1] != k[-1]:
                        break
                else:
                    level = len(k) - k.count("**") - (
                        2 if k[:2] == "**" else 0) - (
                        2 if k[-2:] == "**" else 0)
                    if level not in results:
                        results[level] = []
                    if level > result_level:
                        result_level = level
                    results[level].append(v)
            except Exception as e:
                logger.warning("check error error=%s" % type(e).__name__)
                logger.debug("check error: %s" % e)
                raise e

        if len(results) > 0:
            return self.later(random_module.choice(results[result_level]))

        return None

    def later(self, reply_message):
        self._count({"觸發": 1})

        opt = {}
        if "##" in reply_message:
            reply_message_new = []
            for i in reply_message.split("##"):
                if "=" in i:
                    a, *b = i.split("=")
                    opt[a] = "=".join(b)
                else:
                    reply_message_new.append(i)
            reply_message = reply_message[:reply_message.find("##")]

        if "__" in reply_message:
            weight_total = 0
            result_pool = {}
            minimum_pool = []
            for msg in reply_message.split("__"):
                if msg == "":
                    continue

                index = msg.rfind("%")
                if index > -1 and isFloat(msg[index + 1:].strip()):
                    weight = float(msg[index + 1:].strip())
                    msg = msg[:index]
                else:
                    weight = 1
                weight_total += weight

                is_minimum = msg[:1] == "*"
                if is_minimum:
                    is_minimum_pool = msg[:2] == "**"
                    msg = msg[2:] if is_minimum_pool else msg[1:]

                result_pool[msg] = {
                    "weight": weight,
                    "is_minimum": is_minimum,
                }
                if is_minimum and is_minimum_pool:
                    minimum_pool.append(msg)

            if opt.get("百分比", "0").isdigit():
                number = int(opt.get("百分比", "0"))
                if number > 0:
                    reply_message = []
                    total = 100.0

                    if number > len(result_pool):
                        number = len(result_pool)
                    result_pool = random_module.sample(
                        [msg for msg, msg_opt in result_pool.items()], number)

                    n = 0
                    for msg in result_pool:
                        n += 1
                        if n >= number or n >= len(result_pool):
                            ratio = total
                            total = 0
                        else:
                            ratio = random_module.uniform(0, total)
                            total -= ratio
                        reply_message.append("%s（%3.2f％）" % (msg, ratio))
                        if total <= 0:
                            break

                    return "\n".join(reply_message)

            count = int(self.message[self.message.rfind("*") + 1:]) \
                if "*" in self.message and self.message[
                    self.message.rfind("*") + 1:].isdigit() else 1
            if count > 10000:
                count = 10000
            if count < 1:
                count = 1
            if count == 1 and "種子" in opt and opt["種子"].isdigit() \
                    and int(opt["種子"]) > 0:
                seed_time = int(
                    (self.ctx.time_now() - datetime(2017, 1, 1)).days * 24
                    / int(opt["種子"]))
                seed = int(md5((str(self.user_id) + str(
                    seed_time)).encode()).hexdigest().encode(), 16) \
                    % weight_total
            else:
                try:
                    if count > 1:
                        seed = services.random_org_ints(
                            self.ctx.http, count, weight_total)
                    else:
                        raise ValueError("single draw uses local random")
                except Exception:
                    seed = [random_module.uniform(0, int(weight_total))
                            for i in range(count)]

            minimum_count = 0
            minimum_index = int(opt.get("保底", 10))
            reply_message_new = {}
            reply_message_image = []
            for i in range(count):
                r = float(seed[i]) if type(seed) == list else seed
                for msg, msg_opt in result_pool.items():
                    if r > msg_opt["weight"]:
                        r -= msg_opt["weight"]
                    else:
                        minimum_count = 0 if msg_opt["is_minimum"] \
                            else minimum_count + 1
                        if minimum_count >= minimum_index and len(
                                minimum_pool) > 0:
                            minimum_count = 0
                            msg = random_module.choice(minimum_pool)
                        if msg[:6] == "https:":
                            reply_message_image.append(msg)
                            if len(reply_message_image) > 5:
                                break
                        else:
                            reply_message_new[msg] = (
                                reply_message_new[msg] + 1) \
                                if msg in reply_message_new else 1
                        break

            if len(reply_message_new) > 0:
                if count == 1:
                    reply_message = list(reply_message_new.keys())
                else:
                    reply_message = []
                    for msg, num in reply_message_new.items():
                        reply_message.append("%s x %s" % (msg, num))
                    reply_message = ["\n".join(reply_message)]
            else:
                reply_message = []
            reply_message.extend(reply_message_image[:5])

        if type(reply_message) == str:
            reply_message = [reply_message]
        reply_message_new = []
        for msg in reply_message:
            for msg_split in msg.split("||"):
                reply_message_new.append(msg_split)
        return reply_message_new
