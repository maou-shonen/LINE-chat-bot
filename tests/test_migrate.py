"""Migration CLI: tiny synthetic dump, idempotent rerun, real CLI."""
import gzip
import os
import sqlite3
import subprocess
import sys

import pytest

from app.migrate import build_db, dedupe, json_invalid_counts, load_dump, migrate

TINY_DUMP = """-- MariaDB dump
-- Dumping data for table `user`
--
LOCK TABLES `user` WRITE;
INSERT INTO `user` VALUES
('U1','Alice',NULL,'2020-01-01 00:00:00','2020-01-01 00:00:00'),
('U2',NULL,NULL,'2020-01-01 00:00:00','2020-01-01 00:00:01');
-- Dumping data for table `group`
--
LOCK TABLES `group` WRITE;
INSERT INTO `group` VALUES
('g-uuid-1','C1',NULL,'{}','{}','{}',NULL,'2020-01-01 00:00:00','2020-01-01 00:00:02');
-- Dumping data for table `group_user`
--
LOCK TABLES `group_user` WRITE;
INSERT INTO `group_user` VALUES
(1,'C1','U1','{\\"a\\": 1}','{}'),
(2,'C1','U1','{\\"a\\": 2}','{}'),
(3,'C1',NULL,'{\\"n\\": "a\\\\nb"}','{}');
-- Dumping data for table `keywords`
--
LOCK TABLES `keywords` WRITE;
-- Dumping data for table `keywords_logs`
--
LOCK TABLES `keywords_logs` WRITE;
INSERT INTO `keywords_logs` VALUES
('l-uuid-1','C1','hi','hello','2020-01-01 00:00:03');
-- Dumping data for table `message_queue`
--
LOCK TABLES `message_queue` WRITE;
-- Dumping data for table `url_shortener`
--
LOCK TABLES `url_shortener` WRITE;
INSERT INTO `url_shortener` VALUES
('abc','https://example.com/','2020-01-01 00:00:00');
-- Dumping data for table `user_keyword`
--
LOCK TABLES `user_keyword` WRITE;
INSERT INTO `user_keyword` VALUES
(10,'C1','U1','hello','hi',0,5),
(11,'C1','U1','hello','hi-again',0,5),
(12,'C1','U1','he**lo','wild',1,1),
(13,'C1','U1','**any**','it\\'s \\\\ fine\\nnow',1,1);
-- Dumping data for table `user_settings`
--
LOCK TABLES `user_settings` WRITE;
INSERT INTO `user_settings` VALUES
(20,'C1','U1','{\\"x\\": true}'),
(21,'C1','U1','{\\"x\\": false}'),
(22,'C1',NULL,'{\\"y\\": true}');
-- Dumping data for table `webUI`
--
LOCK TABLES `webUI` WRITE;
INSERT INTO `webUI` VALUES
('U1','C1','2020-01-01 00:00:00','2020-01-01 00:00:00');
"""


@pytest.fixture
def dump_path(tmp_path):
    path = str(tmp_path / "tiny.sql.gz")
    with gzip.open(path, "wt", encoding="utf8") as f:
        f.write(TINY_DUMP)
    return path


def test_tiny_dump_counts_and_dedupe(dump_path):
    rows, counts = load_dump(dump_path)
    assert counts["user"] == 2
    assert counts["user_keyword"] == 4
    assert counts["keywords"] == 0
    assert counts["message_queue"] == 0
    assert counts["url_shortener"] == 1
    assert counts["webUI"] == 1
    report = dedupe(rows)
    assert report["user_keyword"]["dropped"] == 1
    assert report["group_user"]["dropped"] == 1
    assert report["user_settings"]["dropped"] == 1
    con = build_db(rows)
    assert con.execute("SELECT COUNT(*) FROM user_keyword").fetchone() == (3,)
    assert con.execute(
        "SELECT reply FROM user_keyword WHERE _id = 11").fetchone() == (
        "hi-again",)
    assert con.execute(
        "SELECT anchor FROM user_keyword WHERE keyword = 'he**lo'"
    ).fetchone() == ("he",)
    assert con.execute(
        "SELECT reply FROM user_keyword WHERE keyword = '**any**'"
    ).fetchone() == ("it's \\ fine\nnow",)
    assert con.execute(
        "SELECT _count FROM group_user WHERE gid = 'C1' AND uid IS NULL"
    ).fetchone() == ('{"n": "a\\nb"}',)
    assert con.execute(
        "SELECT update_on FROM \"user\" WHERE id = 'U2'").fetchone() == (
        "2020-01-01 00:00:01",)
    assert con.execute(
        "SELECT update_on FROM \"group\" WHERE id = 'C1'").fetchone() == (
        "2020-01-01 00:00:02",)
    assert con.execute(
        "SELECT create_on FROM keywords_logs").fetchone() == (
        "2020-01-01 00:00:03",)
    assert json_invalid_counts(con) == {
        "group._admin": 0, "group._count": 0, "group._setting": 0,
        "group_user._count": 0, "group_user._setting": 0,
        "user_settings.options": 0}


def test_json_gate_fails_on_invalid(dump_path):
    rows, _ = load_dump(dump_path)
    dedupe(rows)
    rows["user_settings"].append(
        ["99", "C9", "U9", "{not json"])
    con = build_db(rows)
    invalid = json_invalid_counts(con)
    assert invalid["user_settings.options"] == 1


def test_cli_idempotent_identical_counts(dump_path, tmp_path, capsys):
    target = str(tmp_path / "tiny.db")
    assert migrate(dump_path, target) == 0
    first = capsys.readouterr().out
    assert "mismatches=0" in first
    assert "user_keyword 4 3 -1" in first
    mode = os.stat(target).st_mode & 0o777
    assert mode == 0o600
    assert migrate(dump_path, target) == 0
    second = capsys.readouterr().out
    assert "mismatches=0" in second
    assert "user_keyword 4 3 -1" in second
    con = sqlite3.connect(target)
    assert con.execute(
        "SELECT journal_mode FROM pragma_journal_mode").fetchone() == ("wal",)
    assert con.execute(
        "SELECT COUNT(*) FROM user_keyword").fetchone() == (3,)
    con.close()


def test_cli_module_entrypoint(dump_path, tmp_path):
    target = str(tmp_path / "cli.db")
    proc = subprocess.run(
        [sys.executable, "-m", "app.migrate", "--from-dump", dump_path,
         "--to", target], capture_output=True, text=True, cwd=".")
    assert proc.returncode == 0, proc.stderr
    assert "mismatches=0" in proc.stdout


def test_parity_sample_zero_skips(dump_path, tmp_path, capsys):
    target = str(tmp_path / "skip.db")
    assert migrate(dump_path, target, parity_sample=0) == 0
    out = capsys.readouterr().out
    assert "parity skipped" in out
    assert "mismatches=" not in out
    con = sqlite3.connect(target)
    assert con.execute(
        "SELECT COUNT(*) FROM user_keyword").fetchone() == (3,)
    con.close()


def test_parity_sample_small_reports_count(dump_path, tmp_path, capsys):
    target = str(tmp_path / "small.db")
    assert migrate(dump_path, target, parity_sample=2) == 0
    out = capsys.readouterr().out
    assert "parity messages=2 matched=" in out
    assert "mismatches=0" in out


def test_parity_sample_zero_keeps_json_gate(dump_path, tmp_path):
    import gzip as gzip_mod

    bad = str(tmp_path / "bad.sql.gz")
    with gzip_mod.open(dump_path, "rt", encoding="utf8") as f:
        content = f.read()
    old = "(20,'C1','U1','{\\\"x\\\": true}')"
    assert old in content
    content = content.replace(old, "(20,'C1','U1','{not json}')")
    with gzip_mod.open(bad, "wt", encoding="utf8") as f:
        f.write(content)
    target = str(tmp_path / "bad.db")
    assert migrate(bad, target, parity_sample=0) == 1


def test_parity_sample_negative_rejected(dump_path, tmp_path):
    from app.migrate import main

    with pytest.raises(SystemExit) as exc:
        main(["--from-dump", dump_path, "--to",
              str(tmp_path / "neg.db"), "--parity-sample", "-1"])
    assert exc.value.code == 2


def test_migrated_schema_matches_store(dump_path, tmp_path):
    import json as json_mod

    from app.db import Base, Store

    target = str(tmp_path / "schema.db")
    assert migrate(dump_path, target) == 0
    Store("sqlite:///%s" % (tmp_path / "fresh.db"))

    def schema(con):
        tables = {}
        for (name, sql) in con.execute(
                "SELECT name, sql FROM sqlite_master WHERE type = 'table' "
                "ORDER BY name").fetchall():
            cols = [r[1] for r in con.execute(
                'PRAGMA table_info("%s")' % name).fetchall()]
            tables[name] = cols
        indexes = {}
        for (name, sql) in con.execute(
                "SELECT name, sql FROM sqlite_master WHERE type = 'index' "
                "AND sql IS NOT NULL ORDER BY name").fetchall():
            indexes[name] = " ".join(sql.split())
        return tables, indexes

    mig_con = sqlite3.connect(target)
    fresh_con = sqlite3.connect(str(tmp_path / "fresh.db"))
    assert schema(mig_con) == schema(fresh_con)
    assert set(Base.metadata.tables) == set(schema(mig_con)[0])
    mig_con.close()
    fresh_con.close()

    for plan_sql, param in (
            ("WITH RECURSIVE lens(n) AS ("
             "SELECT MIN(LENGTH(anchor)) FROM user_keyword "
             "UNION "
             "SELECT (SELECT MIN(LENGTH(anchor)) FROM user_keyword "
             "WHERE LENGTH(anchor) > lens.n) FROM lens "
             "WHERE lens.n IS NOT NULL"
             ") SELECT n FROM lens WHERE n IS NOT NULL ORDER BY n", None),
            ("SELECT keyword FROM user_keyword WHERE anchor IN "
             "(SELECT value FROM json_each(?))",
             json_mod.dumps(["hello", ""]))):
        con = sqlite3.connect(target)
        plan = con.execute("EXPLAIN QUERY PLAN " + plan_sql,
                           (param,) if param is not None else []).fetchall()
        text_plan = " ".join(str(r) for r in plan)
        assert "SCAN user_keyword" not in text_plan, text_plan
        con.close()
