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

    conn = open_readonly(config.database_path)
    try:
        bundle = collect_all(conn, generated_at=now.isoformat())
    finally:
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

    print(f"Exported to: {out_dir}")
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
