"""Entry point: python -m worker.export

Orchestration only. The database read lives in collect.py and the file writing lives
in write.py; this module owns the connection, the output directory, and exit codes.
"""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from worker.config import Config
from worker.export.collect import collect_all
from worker.export.write import CopyResult, copy_images, write_json, write_readme, write_workbook

DEFAULT_OUT_ROOT = Path.home() / "Documents" / "SocialScheduler Exports"

# The restorable copy of the whole install. Named exactly as the live file is, so a person
# who never reads a word of documentation can still see what it is.
DB_COPY_NAME = "socialscheduler.db"

# Any column whose name contains one of these is treated as a credential and emptied from
# the exported copy. The same rule the channels allow-list is held to (see
# test_channel_allow_list_rejects_any_secret_shaped_column_name) — structural rather than a
# list of known names, so a credential column added years from now is scrubbed by default
# instead of being leaked until somebody remembers to update a list.
SECRET_SHAPED = ("token", "secret", "password", "key", "credential")


def _scrub_secrets(conn: sqlite3.Connection) -> list[str]:
    """Empty every credential-shaped column in an exported copy. Returns what it cleared.

    The rest of the export keeps secrets out by NAMING WHAT IT EMITS (collect.py's
    allow-list). A database copy cannot work that way — it is the whole file, every table,
    every column, including `channels.access_token`. Left alone it would put live access
    tokens into a folder the README tells people to drag into Google Drive, which is exactly
    what the allow-list exists to prevent.

    So the copy is scrubbed, and the promise the README already makes stays true: restoring
    brings back your content and reconnects nothing. You sign the accounts back in.

    VACUUM at the end is not tidiness, it is the point. UPDATE only unlinks the old text;
    the bytes stay in the file's free pages, where a raw byte scan still finds them. VACUUM
    rebuilds the file so they are genuinely gone. secure_delete overwrites them on the way.
    """
    conn.execute("PRAGMA secure_delete = ON;")
    cleared: list[str] = []
    tables = [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    ]
    for table in tables:
        for _cid, name, _type, notnull, _default, _pk in conn.execute(
            f"PRAGMA table_info({table})"
        ):
            if not any(s in name.lower() for s in SECRET_SHAPED):
                continue
            # NOT NULL columns cannot be nulled. Empty string is the honest stand-in: the
            # value is gone, and the row still satisfies its own constraint. No credential
            # column is NOT NULL today; this is here so adding one cannot break the export
            # into leaving the secret behind.
            blank = "''" if notnull else "NULL"
            conn.execute(f"UPDATE {table} SET {name} = {blank} WHERE {name} IS NOT NULL")
            cleared.append(f"{table}.{name}")
    conn.commit()
    # Cannot run inside a transaction, hence the commit above.
    conn.execute("VACUUM")
    return cleared


def open_readonly(database_path: Path) -> sqlite3.Connection:
    """A connection SQLite itself will not let us write through.

    query_only is enforced by the engine, so a bug in the export cannot damage the
    install's data even in principle. WAL means this is safe to run while the worker
    is mid-publish.
    """
    conn = sqlite3.connect(str(database_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON;")
    return conn


def copy_database(database_path: Path, out_dir: Path) -> Path:
    """Write a restorable copy of the database into the export folder.

    Everything else in this folder is a READABLE record — a spreadsheet, JSON, and images
    under human names. None of it can rebuild the install: the schedule, targets, cooldowns,
    tags, periods and metrics history live in relationships a spreadsheet flattens away, and
    the exported images are renamed, so their content-hash filenames no longer match what
    the database refers to. This file is the one artifact a restore actually needs.

    Uses SQLite's own online backup API, never a file copy. The database runs in WAL mode,
    where recent commits live in the -wal sidecar rather than the main file — `cp` can
    therefore catch a torn page and silently produce an unopenable copy, and it would miss
    every change still sitting in the WAL. backup() reads through the engine, so it emits a
    single consistent snapshot with the WAL already folded in, and it is safe to run while
    the worker is mid-publish.

    The source is opened read-only (mode=ro) so this cannot touch the live install even in
    principle — the same guarantee open_readonly() gives the rest of the export.

    The copy is then SCRUBBED of credentials before anyone can see it — see _scrub_secrets.
    A database copy is the one part of this export that cannot keep secrets out by choosing
    what to read, because it copies everything.
    """
    dest = out_dir / DB_COPY_NAME
    src = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
            _scrub_secrets(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return dest


def _unique_dir(out_root: Path, stamp: str) -> Path:
    """Never overwrite: a second run in the same minute gets its own suffixed folder."""
    candidate = out_root / stamp
    suffix = 2
    while candidate.exists():
        candidate = out_root / f"{stamp}-{suffix}"
        suffix += 1
    return candidate


def run_export(
    config: Config, out_root: Path, now: datetime
) -> tuple[Path, CopyResult]:
    """Produce one export folder. Returns its path and the image-copy summary."""
    out_dir = _unique_dir(out_root, now.strftime("%Y-%m-%d-%H%M"))
    out_dir.mkdir(parents=True)

    # FIRST, before any of the readable output. This is the artifact a restore needs, and
    # the rest of the export is a long tail of things that can fail on their own (a missing
    # image file, an openpyxl edge case). Writing it first means even a half-finished export
    # folder still holds a complete, restorable copy of the install.
    #
    # It is its own snapshot, taken microseconds before the read transaction below rather
    # than inside it — the backup API needs its own connection. If the worker commits a
    # publish in between, the .db copy and the spreadsheet can differ by that one row. That
    # is the right way round: the .db is the authority for restoring, the spreadsheet is a
    # readable record, and neither is internally inconsistent.
    copy_database(config.database_path, out_dir)

    conn = open_readonly(config.database_path)
    try:
        # Hold ONE read transaction across the whole collection. Python's sqlite3
        # module does not open a transaction for plain reads, so without this each
        # of collect_all's 6+ SELECTs would take its own independent WAL snapshot —
        # if the worker daemon commits a publish in between two of them, the
        # export could end up with a Sends row whose post doesn't exist, or
        # rollups that disagree with the Sends tab in the same file. BEGIN here
        # pins one snapshot for every read that follows, so the export is always
        # a consistent point-in-time backup. query_only stays ON; a read
        # transaction doesn't need write permission.
        conn.execute("BEGIN")
        bundle = collect_all(conn, generated_at=now.isoformat())
    finally:
        # Always end the transaction, even if collection raised, so the
        # connection isn't left half-open when we close it below.
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        conn.close()

    # Images first: the Assets tab reports which files were missing.
    copy_result = copy_images(bundle, config.asset_storage_dir, out_dir)
    write_workbook(bundle, out_dir, missing_asset_ids=copy_result.missing_asset_ids)
    write_json(bundle, out_dir)
    write_readme(bundle, out_dir, copy_result)
    return out_dir, copy_result


def main(argv: list[str] | None = None) -> int:
    config = Config.from_env()

    if not config.database_path.exists():
        print(f"No database found at {config.database_path}.")
        print("Run 'python3 migrate.py' first, or check DATABASE_PATH in .env.")
        return 1

    out_root = DEFAULT_OUT_ROOT
    try:
        out_dir, copy_result = run_export(
            config, out_root=out_root, now=datetime.now(timezone.utc)
        )
    except OSError as exc:
        print(f"Could not write the export: {exc}")
        return 1
    except sqlite3.Error as exc:
        # Corrupt/not-a-database, etc. The connection is query_only and we never
        # wrote to it, so the install's data is untouched — only the export failed.
        print(f"Could not read the database at {config.database_path}: {exc}")
        print("Your data was not modified. The database file may be corrupt.")
        return 1
    except Exception as exc:
        # Catch-all: the export is read-only start to finish, so nothing was
        # written to the database no matter where this came from. A person who
        # double-clicked an icon must see a plain message, never a raw traceback.
        print(f"Something went wrong while exporting: {exc}")
        print("Your data was not modified. If this keeps happening, share this")
        print("message with whoever set SocialScheduler up for you.")
        return 1

    print(f"Exported to: {out_dir}")
    print(f"  {DB_COPY_NAME} written (this is what a restore uses)")
    print(f"  {copy_result.copied} image file(s) copied")
    if copy_result.missing_asset_ids:
        # Visible, never silent — but not a failure: a partial backup still helps.
        print(
            f"  {len(copy_result.missing_asset_ids)} image file(s) were missing from disk"
            " (see README.txt)"
        )
    # Last line: the wrapper (next task) reads this line to open Finder.
    # Nothing may be printed after this — keep it the final output of main().
    print(str(out_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
