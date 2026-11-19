"""Delete user_settings rows whose options are exactly '{}'.

Not run by the app, the image, or deploy. The operator decides when to run it.
Default is a count only. Pass --apply to delete.
執行 --apply 前必須先停 bot。

    uv run python scripts/purge_empty_user_settings.py /path/to/line.db
    uv run python scripts/purge_empty_user_settings.py /path/to/line.db --apply

Only the exact string '{}' is removed. A row with any real option is kept.
"""
import argparse
import sqlite3
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db")
    parser.add_argument(
        "--apply", action="store_true",
        help="delete the rows; default is a count only. 執行 --apply 前必須先停 bot。")
    args = parser.parse_args(argv)
    if args.apply:
        print("執行 --apply 前必須先停 bot。", file=sys.stderr)
    con = sqlite3.connect(args.db)
    try:
        n = con.execute(
            "SELECT COUNT(*) FROM user_settings WHERE options = '{}'"
        ).fetchone()[0]
        if args.apply:
            con.execute("DELETE FROM user_settings WHERE options = '{}'")
            con.commit()
        print(n)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
