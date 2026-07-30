#!/usr/bin/env python3
"""Apply captions, topic/time tags and season windows to existing library posts.

Reads a JSON batch describing metadata for posts that already exist, then writes
it into the local SQLite DB in one transaction.

Unlike `import_manifest.py`, this writes SQLite directly rather than going through
the dashboard: there is no upload, hashing or conform step to inherit, and the
whole point is to touch many existing rows atomically so a bad batch rolls back
cleanly rather than leaving the library half-labelled.

Batch format (JSON):

    {
      "posts": [
        {
          "id": 42,
          "caption": "text of the caption",
          "tags": ["Travel", "Nature"],          # topic tags, created if missing
          "time_of_day": "evening",              # optional; one of the four bands
          "green_periods": ["Summer"]            # optional; MUST already exist
        }
      ]
    }

Season semantics (see worker/periods.py:in_season): a post with NO green period is
eligible year-round. Attaching a green period RESTRICTS the post to that window, so
only attach one when the photo is genuinely seasonal.

The caption is written to BOTH `posts.caption` and a generic `caption_variants` row.
The dashboard edit screen reads variants only, so writing just `posts.caption` makes
the caption box render empty and look lost.

Safe to re-run: every write is an upsert keyed on post id, so a second run over the
same batch is a no-op rather than a duplicate.

Usage:
    python3 scripts/apply_library_metadata.py batch.json [--db data/socialscheduler.db]
                                                         [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "data" / "socialscheduler.db"
TIME_BANDS = {"morning", "afternoon", "evening", "anytime"}


class DryRunRollback(Exception):
    """Raised to unwind the `with conn:` block so --dry-run never commits.

    Deliberately its own type rather than KeyboardInterrupt: catching Ctrl-C to do
    this would report a genuinely interrupted run as a clean dry run.
    """


def load_batch(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    posts = data.get("posts")
    if not isinstance(posts, list) or not posts:
        sys.exit(f"{path}: expected a non-empty 'posts' list")
    return posts


def validate(conn: sqlite3.Connection, posts: list[dict]) -> None:
    """Fail loudly BEFORE writing anything, so a typo can't half-apply a batch."""
    errors: list[str] = []

    known_posts = {r[0] for r in conn.execute("SELECT id FROM posts")}
    known_periods = {r[0].lower() for r in conn.execute("SELECT name FROM periods")}

    for p in posts:
        pid = p.get("id")
        if pid not in known_posts:
            errors.append(f"post {pid}: no such post")
        # `caption` is optional: omitting it means "tags/periods only, leave the
        # existing caption alone". Present-but-blank is always a mistake, though.
        if "caption" in p and not p["caption"].strip():
            errors.append(f"post {pid}: caption present but empty")
        band = p.get("time_of_day")
        if band is not None and band not in TIME_BANDS:
            errors.append(f"post {pid}: unknown time_of_day {band!r}")
        for name in p.get("green_periods", []):
            if name.lower() not in known_periods:
                errors.append(f"post {pid}: no such period {name!r}")

    if errors:
        sys.exit("Refusing to write:\n  " + "\n  ".join(errors))


def tag_id(conn: sqlite3.Connection, name: str, kind: str) -> int:
    """Resolve a tag name to an id, creating the tag if it is new.

    `tags.name` is UNIQUE COLLATE NOCASE, so the SELECT is the case-insensitive
    lookup and the INSERT only ever runs for genuinely new vocabulary.
    """
    row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
    if row:
        return row[0]
    cur = conn.execute("INSERT INTO tags (name, kind) VALUES (?, ?)", (name, kind))
    return cur.lastrowid


def apply_post(conn: sqlite3.Connection, p: dict) -> None:
    pid = p["id"]

    if "caption" in p:
        caption = p["caption"].strip()
        conn.execute(
            "UPDATE posts SET caption = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (caption, pid),
        )
        # The generic (platform-NULL) variant is what the edit screen renders. Replace
        # rather than append so re-running cannot stack duplicate variants.
        conn.execute(
            "DELETE FROM caption_variants WHERE post_id = ? AND platform IS NULL", (pid,)
        )
        conn.execute(
            "INSERT INTO caption_variants (post_id, platform, body, sort_order)"
            " VALUES (?, NULL, ?, 0)",
            (pid, caption),
        )

    for name in p.get("tags", []):
        conn.execute(
            "INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)",
            (pid, tag_id(conn, name, "topic")),
        )

    band = p.get("time_of_day")
    if band:
        conn.execute(
            "INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)",
            (pid, tag_id(conn, band, "time_of_day")),
        )

    for name in p.get("green_periods", []):
        conn.execute(
            "INSERT OR IGNORE INTO post_periods (post_id, period_id, mode)"
            " SELECT ?, id, 'green' FROM periods WHERE name = ?",
            (pid, name),
        )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("batch", type=Path, help="JSON batch file")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and report, then roll back without committing",
    )
    args = ap.parse_args()

    posts = load_batch(args.batch)
    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA foreign_keys = ON")

    try:
        validate(conn, posts)
        with conn:  # commits on success, rolls back on any exception
            for p in posts:
                apply_post(conn, p)
            if args.dry_run:
                raise DryRunRollback  # unwind the transaction deliberately
    except DryRunRollback:
        print(f"DRY RUN ok — {len(posts)} posts validated and applied, then rolled back.")
        return
    except KeyboardInterrupt:
        # `with conn:` has already rolled back on the way out. Say so plainly rather
        # than letting this look like either a success or a completed dry run.
        sys.exit("\nInterrupted — nothing was written.")
    finally:
        conn.close()

    print(f"Applied metadata to {len(posts)} posts.")


if __name__ == "__main__":
    main()
