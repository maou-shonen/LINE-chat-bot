"""Anchor extraction, probe-vs-full-scan parity, dedupe, index use."""
import inspect
import json
import random

import pytest
from sqlalchemy import text

from app.db import GroupUser, Store, UserKeyword, UserSettings
from app.keywords import anchor_of, full_scan, probe_candidates
from app.parity import legacy_check, winning_set


@pytest.fixture
def store(tmp_path):
    return Store("sqlite:///%s" % (tmp_path / "kw.db"))


KEYWORDS = [
    ("G1", "U1", "hello", "hi"),
    ("G1", "U1", "he**lo", "wild"),
    ("G1", "U1", "**any**", "anywhere"),
    ("G1", "U1", "a**b", "ab"),
    ("G1", "U1", "**", "empty-anchor"),
    ("G1", "U1", "****", "empty-anchor-2"),
    ("G1", "U1", "ab**cd**ef", "three"),
    ("G1", "U1", "long**short", "longest-wins"),
    ("G1", "U1", "ab**cd", "tie-first"),
    ("G1", "U1", "@secret", "hidden"),
    ("G1", "U1", "a", "y"),
    ("G1", "U1", "愛醬**晚安", "night"),
]


@pytest.fixture
def seeded(store):
    session = store.session()
    for owner, author, kw, reply in KEYWORDS:
        UserKeyword.add_and_update(session, owner, author, kw, reply)
    session.commit()
    yield store
    session.close()


def test_anchor_extraction():
    assert anchor_of("hello") == "hello"
    assert anchor_of("he**lo") == "he"
    assert anchor_of("**any**") == "any"
    assert anchor_of("**睡午覺") == "睡午覺"
    assert anchor_of("安裝**") == "安裝"
    assert anchor_of("**") == ""
    assert anchor_of("****") == ""
    assert anchor_of("a**b") == "a"
    assert anchor_of("ab**cd") == "ab"
    assert anchor_of("long**short") == "short"
    assert anchor_of("ab**cd**ef") == "ab"
    assert anchor_of("**a**bc") == "bc"


def test_anchor_stored_on_write(store):
    session = store.session()
    UserKeyword.add_and_update(session, "G9", "U1", "安**裝", "r")
    session.commit()
    row = UserKeyword.get(session, "G9", "安**裝")
    assert row.anchor == "安"
    session.close()


def _assert_probe_parity(session, messages):
    for msg in messages:
        for exclude_url in (False, True):
            want_set = winning_set(
                msg, full_scan(session, UserKeyword),
                all_reply=True, exclude_url=exclude_url)
            got_set = winning_set(
                msg, probe_candidates(session, UserKeyword, msg),
                all_reply=True, exclude_url=exclude_url)
            assert want_set == got_set, (msg, exclude_url)
            seed = hash((msg, exclude_url)) & 0xFFFFFFFF
            random.seed(seed)
            want = legacy_check(
                msg, full_scan(session, UserKeyword),
                all_reply=True, exclude_url=exclude_url)
            random.seed(seed)
            got = legacy_check(
                msg, probe_candidates(session, UserKeyword, msg),
                all_reply=True, exclude_url=exclude_url)
            assert want == got, (msg, exclude_url)


def test_probe_parity_synthetic(seeded):
    session = seeded.session()
    _assert_probe_parity(session, [
        "hello", "heXXlo", "xxanyyy", "aXb", "zzz", "foo",
        "afoo", "foobar", "@secret", "a", "",
        "愛醬請說晚安", "abcdef", "longXXXshort"])
    session.close()


def test_probe_parity_pin_quirk_and_at(seeded):
    session = seeded.session()
    _assert_probe_parity(session, [
        "xhello", "hellox", "xhellox", "@secretX",
        "aX", "Xa", "愛醬晚安", "晚安"])
    session.close()


def test_probe_uses_anchor_index(seeded):
    session = seeded.session()
    plan = session.execute(
        text("EXPLAIN QUERY PLAN SELECT keyword FROM user_keyword "
             "WHERE anchor IN (SELECT value FROM json_each(:p))"),
        {"p": json.dumps(["hello", ""])}).fetchall()
    assert any("ix_user_keyword_anchor" in str(r) for r in plan)
    session.close()


def test_anchor_lengths_avoids_full_scan(seeded):
    session = seeded.session()
    plan = session.execute(text(
        "EXPLAIN QUERY PLAN WITH RECURSIVE lens(n) AS ("
        "SELECT MIN(LENGTH(anchor)) FROM user_keyword "
        "UNION "
        "SELECT (SELECT MIN(LENGTH(anchor)) FROM user_keyword "
        "WHERE LENGTH(anchor) > lens.n) FROM lens "
        "WHERE lens.n IS NOT NULL"
        ") SELECT n FROM lens WHERE n IS NOT NULL ORDER BY n")).fetchall()
    text_plan = " ".join(str(r) for r in plan)
    assert "ix_user_keyword_anchor_len" in text_plan
    assert "SCAN user_keyword" not in text_plan
    session.close()


def test_owner_lookups_hit_indexes(seeded):
    session = seeded.session()
    plan = session.execute(
        text("EXPLAIN QUERY PLAN SELECT * FROM user_keyword "
             "WHERE id = :a AND keyword = :b"),
        {"a": "G1", "b": "hello"}).fetchall()
    assert any("ux_user_keyword_id_keyword" in str(r) for r in plan)
    plan = session.execute(
        text("EXPLAIN QUERY PLAN SELECT * FROM group_user "
             "WHERE coalesce(gid, '') = :a AND coalesce(uid, '') = :b"),
        {"a": "G1", "b": "U1"}).fetchall()
    assert any("ux_group_user_gid_uid" in str(r) for r in plan)
    plan = session.execute(
        text("EXPLAIN QUERY PLAN SELECT * FROM user_settings "
             "WHERE coalesce(group_id, '') = :a "
             "AND coalesce(user_id, '') = :b"),
        {"a": "G1", "b": ""}).fetchall()
    assert any("ux_user_settings_group_user" in str(r) for r in plan)
    session.close()


def test_group_user_dedupe_keeps_lowest(store):
    session = store.session()
    session.execute(text(
        "CREATE TABLE gu_src (_id INTEGER PRIMARY KEY, gid TEXT, uid TEXT, "
        "_count TEXT, _setting TEXT)"))
    session.execute(text(
        "INSERT INTO gu_src (gid, uid, _count, _setting) "
        "VALUES ('G1', 'U1', '{}', '{}'), ('G1', 'U1', '{}', '{}')"))
    session.execute(text(
        "INSERT INTO group_user (gid, uid, _count, _setting) "
        "SELECT gid, uid, _count, _setting FROM gu_src WHERE _id IN "
        "(SELECT MIN(_id) FROM gu_src "
        "GROUP BY coalesce(gid,''), coalesce(uid,''))"))
    session.commit()
    rows = session.query(GroupUser).all()
    assert len(rows) == 1
    from sqlalchemy.exc import IntegrityError
    session.add(GroupUser("G1", "U1"))
    with pytest.raises(IntegrityError):
        session.commit()
    session.rollback()
    session.close()


def test_user_settings_unique_with_nulls_and_sleep(store):
    session = store.session()
    UserSettings.update(session, "G1", None, {"全回應": True})
    UserSettings.update(session, "G1", "__sleep__", {"暫停": 1700000000.0})
    session.commit()
    UserSettings.update(session, "G1", None, {"全圖片": True})
    session.commit()
    assert UserSettings.get(session, "G1", None, "全回應") is True
    assert UserSettings.get(session, "G1", None, "全圖片") is True
    row = UserSettings._lookup(session, "G1", "__sleep__")
    assert json.loads(row.options)["暫停"] == 1700000000.0
    from sqlalchemy.exc import IntegrityError
    session.add(UserSettings("G1", None))
    with pytest.raises(IntegrityError):
        session.commit()
    session.rollback()
    session.close()


def test_keyword_unique_pair(store):
    session = store.session()
    UserKeyword.add_and_update(session, "G1", "U1", "hi", "r1")
    session.commit()
    UserKeyword.add_and_update(session, "G1", "U2", "hi", "r2")
    session.commit()
    rows = session.query(UserKeyword).filter_by(id="G1", keyword="hi").all()
    assert len(rows) == 1 and rows[0].reply == "r2"
    session.close()


def test_handler_check_unchanged_against_parity(seeded):
    import app.handler as handler_mod
    src = inspect.getsource(handler_mod.EventText.check)
    assert "anchor" not in src
    assert "k.split(\"**\")" in src or "k.split('**')" in src

def _long_messages(seed):
    rng = random.Random(seed)
    alphabet = "的一是不了人我在有他這中大來上國個hello "
    out = []
    for n in (1000, 5000):
        body = "".join(rng.choice(alphabet) for _ in range(n))
        out.append(body)
        for kw in ("hello", "晚安", "longXXXshort"):
            for pos in (0, max(0, n - len(kw))):
                out.append(body[:pos] + kw + body[pos + len(kw):])
    return out


def test_probe_parity_long_messages(seeded):
    session = seeded.session()
    _assert_probe_parity(session, _long_messages(7))
    session.close()


def test_probe_parity_long_messages_other_seed(seeded):
    session = seeded.session()
    _assert_probe_parity(session, _long_messages(99))
    session.close()


def test_long_path_streams_anchors(seeded):
    session = seeded.session()
    plan = session.execute(
        text("EXPLAIN QUERY PLAN SELECT DISTINCT anchor FROM user_keyword")
    ).fetchall()
    assert any(
        "ix_user_keyword_anchor" in str(r) for r in plan)
    from app import keywords as kw_mod
    assert kw_mod.PROBE_MESSAGE_LIMIT == 300
    rng = random.Random(7)
    msg = "".join(rng.choice("ab的一") for _ in range(301))
    assert [r._id for r in probe_candidates(session, UserKeyword, msg)] == [
        r._id for r in kw_mod._streamed_candidates(
            session, UserKeyword, msg)]
    session.close()
