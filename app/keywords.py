"""Keyword matching primitives: anchor extraction, candidate probing,
and the legacy full-scan parity reference.

Anchor: the longest non-empty piece of ``keyword.split('**')``
(first longest on ties, ``''`` when every piece is empty).
Every match requires all pieces to occur in the message, hence the
anchor too — so rows whose anchor is not a substring of the message
can never match, and the probe is a strict superset filter.
"""
import json

from sqlalchemy import select, text


def anchor_of(keyword):
    best = ""
    for piece in keyword.split("**"):
        if len(piece) > len(best):
            best = piece
    return best


def anchor_lengths(session, model):
    rows = session.execute(text(
        "WITH RECURSIVE lens(n) AS ("
        "SELECT MIN(LENGTH(anchor)) FROM user_keyword "
        "UNION "
        "SELECT (SELECT MIN(LENGTH(anchor)) FROM user_keyword "
        "WHERE LENGTH(anchor) > lens.n) FROM lens "
        "WHERE lens.n IS NOT NULL"
        ") SELECT n FROM lens WHERE n IS NOT NULL ORDER BY n")).all()
    return [r[0] for r in rows if r[0]]


def probe_candidates(session, model, message, lengths=None):
    if lengths is None:
        lengths = anchor_lengths(session, model)
    subs = {""}
    n = len(message)
    for L in lengths:
        if not L or L > n:
            continue
        for i in range(n - L + 1):
            subs.add(message[i:i + L])
    stmt = select(model).where(text(
        "anchor IN (SELECT value FROM json_each(:_probes))")).params(
        _probes=json.dumps(sorted(subs), ensure_ascii=False)).order_by(
        model._id)
    return session.execute(stmt).scalars().all()


def full_scan(session, model):
    return session.execute(
        select(model).order_by(model._id)).scalars().all()
