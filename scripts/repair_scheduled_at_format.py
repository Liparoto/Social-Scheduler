#!/usr/bin/env python3
"""Restate every publications.scheduled_at in the worker's canonical UTC spelling.

WHY THIS EXISTS

scheduled_at holds a UTC instant, but two writers spelled it differently: the Python
worker uses datetime.isoformat() ("2026-08-18T19:30:00+00:00") and the dashboard used
JS toISOString() ("2026-08-18T19:30:00.000Z"). Same moment, different text.

A channel GROUP writes one row per member at a single instant, and auto-fill counted a
group's queued SLOTS by distinctness. Compared as text, a slot written half by each
writer counted as TWO — the queue read as fuller than it was and auto-fill silently
stopped topping it up. Nothing errored; nothing got scheduled.

The dashboard now writes the canonical spelling (lib/time.ts toUtcIso) and the worker
compares instants rather than text (worker/autofill.py _INSTANT), so this cannot recur.
This script cleans up rows written before those fixes.

WHAT IT CHANGES

Only the TEXT, never the instant:

    2026-08-18T19:30:00.000Z   ->  2026-08-18T19:30:00+00:00     (zero fraction dropped)
    2026-08-04T22:22:52Z       ->  2026-08-04T22:22:52+00:00
    2026-07-29T15:08:16.607Z   ->  2026-07-29T15:08:16.607+00:00 (real fraction KEPT)

A non-zero fraction is preserved because dropping it would move a real instant. Python's
isoformat() spells sub-second values the same way, so those stay canonical too.

Rows already in the canonical spelling, and anything this cannot parse, are left alone.

USAGE

    python3 scripts/repair_scheduled_at_format.py            # dry run, prints the diff
    python3 scripts/repair_scheduled_at_format.py --apply    # writes, in one transaction

Back up your DB first:  sqlite3 data/socialscheduler.db ".backup 'backup.db'"
"""

from __future__ import annotations

import os
import re
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# "YYYY-MM-DDTHH:MM:SS" + optional ".fraction" + a UTC zone spelled "Z" or "+00:00".
# Anchored, so anything unusual (a local offset, a date-only value) is left untouched
# rather than guessed at.
UTC_ISO = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|\+00:00)$")


def canonical(value: str) -> str | None:
    """The canonical spelling of `value`, or None if it is unparseable/already canonical."""
    m = UTC_ISO.match(value or "")
    if not m:
        return None
    base, fraction, _zone = m.groups()
    # A fraction of all zeros carries no instant — drop it so the text matches what the
    # worker writes for a whole-second slot. A real fraction stays: it IS the instant.
    if fraction and fraction.strip(".0") == "":
        fraction = ""
    out = f"{base}{fraction or ''}+00:00"
    return None if out == value else out


def db_path() -> Path:
    """The install's DB, from DATABASE_PATH in .env (same file the worker reads)."""
    env = REPO_ROOT / ".env"
    raw = os.environ.get("DATABASE_PATH")
    if not raw and env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line.startswith("DATABASE_PATH="):
                raw = line.split("=", 1)[1].strip()
                break
    if not raw:
        sys.exit("DATABASE_PATH not set (checked the environment and .env).")
    p = Path(raw)
    return p if p.is_absolute() else (REPO_ROOT / p).resolve()


def main() -> int:
    apply = "--apply" in sys.argv[1:]
    path = db_path()
    if not path.exists():
        sys.exit(f"No database at {path}")

    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, channel_id, status, scheduled_at FROM publications ORDER BY id"
    ).fetchall()

    changes = []
    unparseable = []
    for r in rows:
        new = canonical(r["scheduled_at"])
        if new:
            changes.append((r["id"], r["channel_id"], r["status"], r["scheduled_at"], new))
        elif not UTC_ISO.match(r["scheduled_at"] or ""):
            unparseable.append((r["id"], r["scheduled_at"]))

    print(f"Database: {path}")
    print(f"{len(rows)} publication(s); {len(changes)} need restating.\n")
    for pid, cid, status, old, new in changes:
        print(f"  #{pid:<4} channel {cid}  {status:<10} {old}  ->  {new}")
    if unparseable:
        print(f"\n  Left alone (not a recognised UTC instant): {len(unparseable)}")
        for pid, val in unparseable:
            print(f"    #{pid}: {val!r}")

    if not changes:
        print("\nNothing to do.")
        return 0

    if not apply:
        print("\nDry run. Re-run with --apply to write these changes.")
        return 0

    with conn:  # one transaction: all of it, or none of it
        conn.executemany(
            "UPDATE publications SET scheduled_at = ? WHERE id = ?",
            [(new, pid) for pid, _c, _s, _o, new in changes],
        )
    print(f"\nApplied. {len(changes)} row(s) restated; no instant moved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
