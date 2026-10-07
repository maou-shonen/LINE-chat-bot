"""Storage: SQLite only (WAL). Keyword matching for reply-to-all goes
through the indexed ``anchor`` column (see app/keywords.py); the
unchanged check() semantics in handler.py decide the winner."""
import copy
import json
from datetime import datetime
from uuid import uuid1

from sqlalchemy import (
    DateTime,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    event,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .keywords import anchor_lengths, anchor_of, probe_candidates


def make_engine(url):
    if not url.startswith("sqlite"):
        raise ValueError("only sqlite DATABASE_URL is supported")
    engine = create_engine(url)

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

    return engine


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "user"
    id: Mapped[str] = mapped_column(String(35), primary_key=True)
    name: Mapped[str | None] = mapped_column(String(20))
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

    __table_args__ = (
        Index("ux_group_user_gid_uid",
              func.coalesce(gid, ""), func.coalesce(uid, ""),
              unique=True),
    )

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
    anchor: Mapped[str] = mapped_column(Text, nullable=False, default="")

    __table_args__ = (
        Index("ix_user_keyword_anchor", "anchor"),
        Index("ux_user_keyword_id_keyword", "id", "keyword", unique=True),
    )

    def __init__(self, id, author, keyword, reply):
        self.id = id
        self.author = author
        self.keyword = keyword
        self.reply = reply
        self.anchor = anchor_of(keyword)

    @staticmethod
    def add_and_update(session, id, author, keyword, reply, plus=False):
        row = session.query(UserKeyword).filter_by(
            id=id, keyword=keyword).first()
        if row is None:
            row = UserKeyword(id, author, keyword, reply)
            session.add(row)
            session.flush()
        else:
            n = row.reply.rfind("##")
            if n > -1 and "保護" in row.reply[n:] and row.author != author:
                raise Exception("此關鍵字已被保護\n只有原設定者可以修改")

            row.author = author
            row.reply = reply + "__" + row.reply if plus else reply
            row.anchor = anchor_of(row.keyword)

        if id is not None:
            session.add(KeywordsLogs(id, keyword, reply))
        return True

    @staticmethod
    def delete(session, id, author, keyword):
        row = session.query(UserKeyword).filter_by(
            id=id, keyword=keyword).first()
        if row is None:
            return False

        n = row.reply.rfind("##")
        if n > -1 and "保護" in row.reply[n:] and row.author != author:
            raise Exception("此關鍵字已被保護\n只有原設定者可以修改")

        session.delete(row)
        return True

    @staticmethod
    def get(session, id=None, keyword=None):
        if id is None:
            raise ValueError("reply-to-all must use probe_all_reply")
        if keyword is None:
            return session.query(UserKeyword).filter_by(
                id=id).order_by(UserKeyword._id).all()
        return session.query(UserKeyword).filter_by(
            id=id, keyword=keyword).first()

    @staticmethod
    def probe_all_reply(session, message, _lengths=None):
        if _lengths is None:
            _lengths = anchor_lengths(session, UserKeyword)
        return probe_candidates(session, UserKeyword, message, _lengths)


class UserSettings(Base):
    __tablename__ = "user_settings"
    _id: Mapped[int | None] = mapped_column(
        Integer, autoincrement=True, primary_key=True)
    group_id: Mapped[str | None] = mapped_column(String(35))
    user_id: Mapped[str | None] = mapped_column(String(35))
    options: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        Index("ux_user_settings_group_user",
              func.coalesce(group_id, ""), func.coalesce(user_id, ""),
              unique=True),
    )

    def __init__(self, group_id, user_id):
        self.group_id = group_id
        self.user_id = user_id
        self.options = "{}"

    @staticmethod
    def _lookup(session, group_id, user_id):
        q = session.query(UserSettings)
        if group_id is None:
            q = q.filter(UserSettings.group_id.is_(None))
        else:
            q = q.filter(UserSettings.group_id == group_id)
        if user_id is None:
            q = q.filter(UserSettings.user_id.is_(None))
        else:
            q = q.filter(UserSettings.user_id == user_id)
        return q.order_by(UserSettings._id).first()

    @staticmethod
    def _get(session, group_id, user_id):
        row = UserSettings._lookup(session, group_id, user_id)
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
    """Engine + per-event sessions for one app instance (no resident cache)."""

    def __init__(self, url):
        self.engine = make_engine(url)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)

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
