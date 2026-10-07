"""Storage: same MariaDB tables/columns and keyword semantics as the
legacy app, via plain SQLAlchemy 2.x ORM. One session per event; the
resident keyword cache is kept for now (Unit 4 drops it)."""
import copy
import json
from datetime import datetime
from uuid import uuid1

from sqlalchemy import Boolean, DateTime, Integer, String, Text, create_engine, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker


def make_engine(url, debug=False):
    if url.startswith("sqlite"):
        return create_engine(url)
    return create_engine(url, pool_size=0, pool_timeout=10)


class Base(DeclarativeBase):
    pass


class NullObject:
    def __init__(self, **argv):
        if len(argv) > 0:
            self.__dict__.update(argv)


class User(Base):
    __tablename__ = "user"
    id: Mapped[str] = mapped_column(String(35), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(20))
    location: Mapped[str | None] = mapped_column(Text)
    create_on: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    update_on: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now())

    def __init__(self, id):
        self.id = id

    def update(self):
        self.update_on = datetime.now()


class Group(Base):
    __tablename__ = "group"
    _id: Mapped[str | None] = mapped_column(String(36))
    id: Mapped[str] = mapped_column(String(35), primary_key=True)
    _count: Mapped[str | None] = mapped_column(Text)
    _setting: Mapped[str | None] = mapped_column(Text)
    _admin: Mapped[str | None] = mapped_column(Text)
    create_on: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    update_on: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), server_default=func.now())

    def __init__(self, id):
        self._id = str(uuid1())
        self.id = id
        self._count = "{}"
        self._setting = "{}"
        self._admin = "{}"

    def _json(self):
        if "count" not in self.__dict__:
            self.count = json.loads(self._count)
            self.setting = json.loads(self._setting)
            self.admin = json.loads(self._admin)

    def update(self):
        self.update_on = datetime.now()
        self._count = json.dumps(self.count)
        self._setting = json.dumps(self.setting)
        self._admin = json.dumps(self.admin)


class GroupUser(Base):
    __tablename__ = "group_user"
    _id: Mapped[int | None] = mapped_column(
        Integer, autoincrement=True, primary_key=True)
    gid: Mapped[str | None] = mapped_column(String(35))
    uid: Mapped[str | None] = mapped_column(String(35))
    _count: Mapped[str | None] = mapped_column(Text)
    _setting: Mapped[str | None] = mapped_column(Text)

    def __init__(self, group_id, user_id):
        self.gid = group_id
        self.uid = user_id
        self._count = "{}"
        self._setting = "{}"

    def _json(self):
        if "count" not in self.__dict__:
            self.count = json.loads(self._count)
            self.setting = json.loads(self._setting)

    def update(self):
        self._count = json.dumps(self.count)
        self._setting = json.dumps(self.setting)


class Keywords(Base):
    __tablename__ = "keywords"
    _id: Mapped[str] = mapped_column(String(36), primary_key=True)
    id: Mapped[str | None] = mapped_column(String(35))
    author: Mapped[str | None] = mapped_column(String(35))
    keyword: Mapped[str] = mapped_column(String(128), nullable=False)
    reply: Mapped[str] = mapped_column(Text, nullable=False)
    _option: Mapped[str | None] = mapped_column(Text)

    def _json(self):
        if "option" not in self.__dict__:
            self.option = json.loads(self._option)

    def update(self):
        self._option = json.dumps(self.option)


class KeywordsLogs(Base):
    __tablename__ = "keywords_logs"
    _id: Mapped[str] = mapped_column(String(36), primary_key=True)
    id: Mapped[str | None] = mapped_column(String(35))
    keyword: Mapped[str | None] = mapped_column(String(128))
    reply: Mapped[str | None] = mapped_column(Text)
    create_on = mapped_column(DateTime, default=func.current_timestamp())

    def __init__(self, id, keyword, reply):
        self._id = str(uuid1())
        self.id = id
        self.keyword = keyword
        self.reply = reply


class UserKeyword(Base):
    __tablename__ = "user_keyword"
    _id: Mapped[int | None] = mapped_column(
        Integer, autoincrement=True, primary_key=True)
    id: Mapped[str | None] = mapped_column(String(35))
    author: Mapped[str | None] = mapped_column(String(35))
    keyword: Mapped[str] = mapped_column(String(128), nullable=False)
    reply: Mapped[str] = mapped_column(Text, nullable=False)
    super: Mapped[bool | None] = mapped_column(Boolean)
    level: Mapped[int | None] = mapped_column(Integer)

    def __init__(self, id, author, keyword, reply):
        self.id = id
        self.author = author
        self.keyword = keyword
        self.reply = reply
        self.super = ("**" in keyword)
        self.level = len(keyword) - keyword.count("**") * (len("**") + 1)

    @staticmethod
    def add_and_update(session, id, author, keyword, reply, plus=False):
        cache = UserKeyword.get(session, id, keyword)
        if cache is None:
            row = UserKeyword(id, author, keyword, reply)
            session.add(row)
            session.flush()
            UserKeyword_cache.setdefault(id, {})[keyword] = NullObject(
                **{k: v for k, v in row.__dict__.items()
                   if k != "_sa_instance_state"})
        else:
            n = cache.reply.rfind("##")
            if n > -1 and "保護" in cache.reply[n:] and cache.author != author:
                raise Exception("此關鍵字已被保護\n只有原設定者可以修改")

            cache.author = author
            cache.reply = reply + "__" + cache.reply if plus else reply

            for row in session.query(UserKeyword).filter_by(
                    id=id, keyword=keyword):
                row.author = author
                row.reply = reply + "__" + row.reply if plus else reply

        if id is not None:
            session.add(KeywordsLogs(id, keyword, reply))
        return True

    @staticmethod
    def delete(session, id, author, keyword):
        cache = UserKeyword.get(session, id, keyword)
        if cache is None:
            return False

        n = cache.reply.rfind("##")
        if n > -1 and "保護" in cache.reply[n:] and cache.author != author:
            raise Exception("此關鍵字已被保護\n只有原設定者可以修改")

        for row in session.query(UserKeyword).filter_by(id=id, keyword=keyword):
            session.delete(row)
        UserKeyword_cache[id].pop(keyword)
        return True

    @staticmethod
    def get(session, id=None, keyword=None):
        if id not in UserKeyword_cache:
            UserKeyword_cache[id] = {}

        if id is None:
            rows = []
            for i in UserKeyword_cache.values():
                for row in i.values():
                    rows.append(row)
            return rows
        elif keyword is None:
            return [row for row in UserKeyword_cache[id].values()]
        else:
            return UserKeyword_cache[id].get(keyword, None)


UserKeyword_cache: dict = {}


def load_cache(session):
    UserKeyword_cache.clear()
    for row in session.query(UserKeyword):
        UserKeyword_cache.setdefault(row.id, {})[row.keyword] = NullObject(
            **{k: v for k, v in row.__dict__.items()
               if k != "_sa_instance_state"})


class UserSettings(Base):
    __tablename__ = "user_settings"
    _id: Mapped[int | None] = mapped_column(
        Integer, autoincrement=True, primary_key=True)
    group_id: Mapped[str | None] = mapped_column(String(35))
    user_id: Mapped[str | None] = mapped_column(String(35))
    options: Mapped[str | None] = mapped_column(Text)

    def __init__(self, group_id, user_id):
        self.group_id = group_id
        self.user_id = user_id
        self.options = "{}"

    @staticmethod
    def _get(session, group_id, user_id):
        row = session.query(UserSettings).filter_by(
            group_id=group_id, user_id=user_id).first()
        if row is None:
            row = UserSettings(group_id, user_id)
            session.add(row)
        return row

    @staticmethod
    def update(session, group_id, user_id, options):
        if type(options) != dict:
            Exception("參數類型錯誤")

        row = UserSettings._get(session, group_id, user_id)

        row_options = json.loads(row.options)
        row_options.update(options)
        row.options = json.dumps(row_options)

    @staticmethod
    def get(session, group_id, user_id, option, default=None):
        row = UserSettings._get(session, group_id, user_id)

        return json.loads(row.options).get(option, default)

    @staticmethod
    def show(session, group_id, user_id):
        def bool2str(b):
            return "開啟" if b else "關閉"

        data = ["目前的設定"]

        row = UserSettings._get(session, group_id, None)
        data.append("<群組>")
        settings = json.loads(row.options)
        if len(settings) > 0:
            for k, v in settings.items():
                data.append("%s = %s" % (k, bool2str(v)))
        else:
            data.append("無 (預設)")

        row = UserSettings._get(session, group_id, user_id)
        data.append("<群組中的你>")
        settings = json.loads(row.options)
        if len(settings) > 0:
            for k, v in settings.items():
                data.append("%s = %s" % (k, bool2str(v)))
        else:
            data.append("無 (預設)")

        return "\n".join(data)


class Store:
    """Engine + per-event sessions + keyword cache for one app instance."""

    def __init__(self, url, debug=False):
        self.engine = make_engine(url, debug)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        load_cache(self.sessions())

    def session(self):
        return self.sessions()

    def db_state(self):
        session = self.sessions()
        try:
            keywords = sorted(
                [r.id, r.keyword, r.reply]
                for r in session.query(UserKeyword).all())
            settings = sorted(
                [r.group_id or "", r.user_id or "", r.options]
                for r in session.query(UserSettings).all())
            counts = {}
            for r in session.query(GroupUser).all():
                r._json()
                counts["%s\0%s" % (r.gid, r.uid)] = copy.deepcopy(r.count)
            return {"keywords": keywords, "settings": settings,
                    "counts": counts}
        finally:
            session.close()
