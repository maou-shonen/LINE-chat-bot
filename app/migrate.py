"""One-shot MariaDB mysqldump (.sql or .sql.gz) -> SQLite migration.

Runnable inside the container: builds into a temp file next to the
target, then atomically renames. Prints an aggregate-only verification
report. Exits non-zero when keyword parity mismatches are found.
"""
import argparse
import gzip
import json
import os
import random
import re
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))

from app.keywords import anchor_of  # noqa: E402
from app.parity import legacy_check, winning_set  # noqa: E402

KEPT_TABLES = ("user", "group", "group_user", "keywords_logs",
               "user_keyword", "user_settings")
SKIPPED_TABLES = ("keywords", "message_queue", "url_shortener", "webUI")
SAMPLE_SIZE = 2000
SOURCE_COLUMNS = {
    "user": ("id", "name", "location", "create_on", "update_on"),
    "group": ("_id", "id", "use_on", "_admin", "_setting",
              "_count", "news", "create_on", "update_on"),
    "group_user": ("_id", "gid", "uid", "_count", "_setting"),
    "keywords_logs": ("_id", "id", "keyword", "reply", "create_on"),
    "user_keyword": ("_id", "id", "author", "keyword", "reply",
                     "super", "level"),
    "user_settings": ("_id", "group_id", "user_id", "options"),
}

COLUMNS = {
    "user": ("id", "name", "create_on", "update_on"),
    "group": ("_id", "id", "_admin", "_setting", "_count",
              "create_on", "update_on"),
    "group_user": ("_id", "gid", "uid", "_count", "_setting"),
    "keywords_logs": ("_id", "id", "keyword", "reply", "create_on"),
    "user_keyword": ("_id", "id", "author", "keyword", "reply"),
    "user_settings": ("_id", "group_id", "user_id", "options"),
}

TABLE_RE = re.compile(r"-- Dumping data for table `(\w+)`")


def split_values(body):
    parts, cur, instr = [], [], False
    i = 0
    while i < len(body):
        c = body[i]
        if not instr:
            if c == "'":
                instr = True
                cur.append(c)
            elif c == ",":
                parts.append("".join(cur))
                cur = []
            else:
                cur.append(c)
        else:
            if c == "\\" and i + 1 < len(body):
                cur.append(c)
                cur.append(body[i + 1])
                i += 2
                continue
            elif c == "'":
                if i + 1 < len(body) and body[i + 1] == "'":
                    cur.append("''")
                    i += 2
                    continue
                instr = False
                cur.append(c)
            else:
                cur.append(c)
        i += 1
    parts.append("".join(cur))
    return parts


_UNESCAPES = {"n": "\n", "r": "\r", "t": "\t", "b": "\b",
              "0": "\0", "Z": "\x1a"}


def unquote(value):
    value = value.strip()
    if value == "NULL":
        return None
    if not (value.startswith("'") and value.endswith("'")):
        return value
    inner = value[1:-1].replace("''", "'")
    out = []
    i = 0
    while i < len(inner):
        if inner[i] == "\\" and i + 1 < len(inner):
            nxt = inner[i + 1]
            if nxt in ("'", '"', "\\"):
                out.append(nxt)
            else:
                out.append(_UNESCAPES.get(nxt, nxt))
            i += 2
        else:
            out.append(inner[i])
            i += 1
    return "".join(out)


def iter_rows(path):
    opener = gzip.open if path.endswith(".gz") else open
    table = None
    with opener(path, "rt", encoding="utf8", errors="strict") as f:
        for line in f:
            m = TABLE_RE.match(line)
            if m:
                table = m.group(1)
                continue
            if table is not None and line.startswith("("):
                body = line.rstrip("\n")
                if body.endswith((";", ",")):
                    body = body[:-1]
                if body.endswith(")"):
                    body = body[:-1]
                else:
                    raise ValueError("bad tuple end: %r" % body[-10:])
                if not body.startswith("("):
                    raise ValueError("bad tuple start: %r" % body[:10])
                yield table, split_values(body[1:])


def load_dump(path):
    rows = {t: [] for t in KEPT_TABLES}
    source_counts = {}
    for table, values in iter_rows(path):
        source_counts[table] = source_counts.get(table, 0) + 1
        if table in rows:
            rows[table].append([unquote(v) for v in values])
    for table in SKIPPED_TABLES:
        source_counts.setdefault(table, 0)
    return rows, source_counts


def dedupe(rows):
    report = {}
    uk = rows["user_keyword"]
    seen, kept, dropped = set(), [], 0
    case_variants = 0
    lowered = {}
    for r in sorted(uk, key=lambda r: -int(r[0])):
        key = (r[1], r[3])
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        kept.append(r)
        lk = (r[1], (r[3] or "").lower())
        if lk in lowered and lowered[lk] != r[3]:
            case_variants += 1
        lowered.setdefault(lk, r[3])
    rows["user_keyword"] = kept
    report["user_keyword"] = {"dropped": dropped,
                              "case_variants": case_variants}
    for table, pair in (("group_user", (1, 2)),
                        ("user_settings", (1, 2))):
        seen, kept, dropped = set(), [], 0
        for r in sorted(rows[table], key=lambda r: int(r[0])):
            key = (r[pair[0]] or "", r[pair[1]] or "")
            if key in seen:
                dropped += 1
                continue
            seen.add(key)
            kept.append(r)
        rows[table] = kept
        report[table] = {"dropped": dropped}
    return report


def build_db(rows):
    from sqlalchemy import create_engine

    from app.db import Base

    con = sqlite3.connect(":memory:")
    engine = create_engine("sqlite://", creator=lambda: con)
    Base.metadata.create_all(engine)
    target_cols = {t: [c.name for c in Base.metadata.tables[t].columns]
                   for t in KEPT_TABLES}
    for table in KEPT_TABLES:
        cols = [c for c in COLUMNS[table] if c in target_cols[table]]
        idx = {c: i for i, c in enumerate(SOURCE_COLUMNS[table])}
        for r in rows[table]:
            vals = [r[idx[c]] for c in cols]
            if table == "user_keyword":
                vals.append(anchor_of(vals[cols.index("keyword")] or ""))
            con.execute(
                "INSERT INTO \"%s\" (%s) VALUES (%s)" % (
                    table, ",".join('"%s"' % c for c in cols + (
                        ["anchor"] if table == "user_keyword" else [])),
                    ",".join("?" * len(vals))), vals)
    con.commit()
    return con


def sample_messages(con, n=SAMPLE_SIZE):
    rng = random.Random(20261008)
    kws = [r[0] for r in con.execute(
        "SELECT keyword FROM user_keyword").fetchall()]
    pieces = []
    for k in kws:
        pieces.extend(p for p in k.split("**") if p)
    cjk = "".join(chr(c) for c in range(0x4E00, 0x4E60))
    ascii_ = "abcdefghijklmnopqrstuvwxyz0123456789 "
    msgs = set()
    while len(msgs) < n // 2 and pieces:
        frag = rng.choice(pieces)
        msgs.add("".join(rng.choice(ascii_ + cjk) for _ in range(3))
                 + frag + "".join(rng.choice(ascii_) for _ in range(3)))
    while len(msgs) < n:
        msgs.add("".join(rng.choice(ascii_ + cjk)
                         for _ in range(rng.randint(1, 30))))
    return sorted(msgs)


class _Row:
    def __init__(self, keyword, reply):
        self.keyword = keyword
        self.reply = reply


def parity_check(con, messages):
    rows = [_Row(k, r) for k, r in con.execute(
        "SELECT keyword, reply FROM user_keyword ORDER BY _id").fetchall()]
    lengths = sorted(
        r[0] for r in con.execute(
            "WITH RECURSIVE lens(n) AS ("
            "SELECT MIN(LENGTH(anchor)) FROM user_keyword "
            "UNION "
            "SELECT (SELECT MIN(LENGTH(anchor)) FROM user_keyword "
            "WHERE LENGTH(anchor) > lens.n) FROM lens "
            "WHERE lens.n IS NOT NULL"
            ") SELECT n FROM lens WHERE n IS NOT NULL ORDER BY n"
        ).fetchall() if r[0])
    mismatches = 0
    matched = 0
    for msg in messages:
        subs = {""}
        for L in lengths:
            if not L or L > len(msg):
                continue
            for j in range(len(msg) - L + 1):
                subs.add(msg[j:j + L])
        got_rows = con.execute(
            "SELECT keyword, reply FROM user_keyword WHERE anchor IN "
            "(SELECT value FROM json_each(?)) ORDER BY _id",
            (json.dumps(sorted(subs), ensure_ascii=False),)).fetchall()
        got_rows = [_Row(k, r) for k, r in got_rows]
        for exclude_url in (False, True):
            want_set = winning_set(
                msg, rows, all_reply=True, exclude_url=exclude_url)
            got_set = winning_set(
                msg, got_rows, all_reply=True, exclude_url=exclude_url)
            if want_set:
                matched += 1
            if want_set != got_set:
                mismatches += 1
                break
            random.seed(hash((msg, exclude_url)) & 0xFFFFFFFF)
            want = legacy_check(
                msg, rows, all_reply=True, exclude_url=exclude_url)
            random.seed(hash((msg, exclude_url)) & 0xFFFFFFFF)
            got = legacy_check(
                msg, got_rows, all_reply=True, exclude_url=exclude_url)
            if want != got:
                mismatches += 1
                break
    return mismatches, matched


JSON_COLUMNS = {
    "group": ("_count", "_setting", "_admin"),
    "group_user": ("_count", "_setting"),
    "user_settings": ("options",),
}


def json_invalid_counts(con):
    invalid = {}
    for table, cols in JSON_COLUMNS.items():
        for col in cols:
            bad = 0
            for (value,) in con.execute(
                    "SELECT \"%s\" FROM \"%s\" WHERE \"%s\" IS NOT NULL" % (
                        col, table, col)).fetchall():
                try:
                    json.loads(value)
                except (ValueError, TypeError):
                    bad += 1
            invalid["%s.%s" % (table, col)] = bad
    return invalid


def migrate(source, target):
    rows, source_counts = load_dump(source)
    report = dedupe(rows)
    con = build_db(rows)
    target_counts = {t: con.execute(
        "SELECT COUNT(*) FROM \"%s\"" % t).fetchone()[0] for t in KEPT_TABLES}
    invalid = json_invalid_counts(con)
    messages = sample_messages(con)
    mismatches, matched = parity_check(con, messages)

    fd, tmp = tempfile.mkstemp(
        suffix=".db", prefix=".migrate-", dir=os.path.dirname(
            os.path.abspath(target)))
    os.close(fd)
    try:
        dest = sqlite3.connect(tmp)
        con.backup(dest)
        dest.execute("PRAGMA journal_mode=WAL")
        dest.commit()
        dest.close()
        os.chmod(tmp, 0o600)
        os.replace(tmp, target)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise

    lines = ["table source target deduped"]
    for t in KEPT_TABLES:
        lines.append("%s %d %d -%d" % (
            t, source_counts.get(t, 0), target_counts[t],
            source_counts.get(t, 0) - target_counts[t]))
    for t in SKIPPED_TABLES:
        lines.append("%s %d 0 skipped" % (t, source_counts.get(t, 0)))
    lines.append("user_keyword case-variant pairs: %d" % report[
        "user_keyword"]["case_variants"])
    lines.append("json invalid: %s" % ", ".join(
        "%s=%d" % (k, invalid[k]) for k in sorted(invalid)))
    lines.append("parity messages=%d matched=%d mismatches=%d" % (
        len(messages), matched, mismatches))
    print("\n".join(lines))
    return 1 if mismatches or any(invalid.values()) else 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="mysqldump -> SQLite one-shot migration")
    parser.add_argument("--from-dump", required=True)
    parser.add_argument("--to", required=True)
    args = parser.parse_args(argv)
    if not os.path.exists(args.from_dump):
        print("dump not found: %s" % args.from_dump, file=sys.stderr)
        return 2
    return migrate(args.from_dump, args.to)


if __name__ == "__main__":
    sys.exit(main())
