"""One-off: seed a single-image test post + a due publication for a dry-run.

Safe by design — this only writes rows to the local DB. The worker, running with
DRY_RUN=1, will assemble the post and log what it *would* send, then stop before
publishing. Delete these rows anytime (they're marked created_by='dryrun-seed').

    python3 scripts/seed_dryrun_post.py <channel_id>
"""
import sys
from datetime import datetime, timezone

from worker import db
from worker.config import Config

PLACEHOLDER_URL = "https://example.com/placeholder-not-fetched-in-dry-run.jpg"


def main() -> int:
    channel_id = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    config = Config.from_env()
    conn = db.connect(config.database_path)
    now = datetime.now(timezone.utc).isoformat()

    ch = conn.execute("SELECT account_name FROM channels WHERE id=?", (channel_id,)).fetchone()
    if ch is None:
        print(f"No channel #{channel_id}. Aborting.")
        return 1

    # A throwaway asset. In dry-run the public_url is never fetched — it only shows
    # up in the logged plan so you can see exactly what would be sent.
    cur = conn.execute(
        """INSERT INTO assets (content_hash, media_kind, original_filename,
                               storage_path, public_url, mime_type, created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (f"dryrun-{now}", "image", "dryrun.jpg", "dryrun/dryrun.jpg",
         PLACEHOLDER_URL, "image/jpeg", now),
    )
    asset_id = cur.lastrowid

    cur = conn.execute(
        """INSERT INTO posts (caption, post_type, status, created_by, created_at)
           VALUES (?,?,?,?,?)""",
        ("Dry-run test — nothing is posted to Instagram.", "single",
         "scheduled", "dryrun-seed", now),
    )
    post_id = cur.lastrowid

    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,?)",
        (post_id, asset_id, 0),
    )

    cur = conn.execute(
        """INSERT INTO publications (post_id, channel_id, scheduled_at, status,
                                     created_by, created_at)
           VALUES (?,?,?,?,?,?)""",
        (post_id, channel_id, now, "scheduled", "dryrun-seed", now),
    )
    pub_id = cur.lastrowid

    conn.commit()
    conn.close()
    print(f"Seeded dry-run: post #{post_id}, asset #{asset_id}, publication #{pub_id} "
          f"-> channel #{channel_id} ({ch['account_name']}), due now.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
