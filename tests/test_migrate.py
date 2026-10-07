"""Migration CLI: tiny synthetic dump, idempotent rerun, real CLI."""
import gzip
import os
import sqlite3
import subprocess
import sys

import pytest

from app.migrate import build_db, dedupe, load_dump, migrate

TINY_DUMP = """-- MariaDB dump
-- Dumping data for table `user`
--
LOCK TABLES `user` WRITE;
INSERT INTO `user` VALUES
('U1','Alice',NULL,'2020-01-01 00:00:00','2020-01-01 00:00:00'),
('U2',NULL,NULL,'2020-01-01 00:00:00','2020-01-01 00:00:00');
-- Dumping data for table `group`
--
LOCK TABLES `group` WRITE;
INSERT INTO `group` VALUES
('g-uuid-1','C1',NULL,'{}','{}','{}',NULL,'2020-01-01 00:00:00','2020-01-01 00:00:00');
-- Dumping data for table `group_user`
--
LOCK TABLES `group_user` WRITE;
INSERT INTO `group_user` VALUES
(1,'C1','U1','{\\"a\\": 1}','{}'),
(2,'C1','U1','{\\"a\\": 2}','{}'),
(3,'C1',NULL,'{}','{}');
-- Dumping data for table `keywords`
--
LOCK TABLES `keywords` WRITE;
-- Dumping data for table `keywords_logs`
--
LOCK TABLES `keywords_logs` WRITE;
INSERT INTO `keywords_logs` VALUES
('l-uuid-1','C1','hi','hello','2020-01-01 00:00:00');
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
(13,'C1','U1','**any**','anywhere',1,1);
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
