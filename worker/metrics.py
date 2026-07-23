"""Metrics fetch job.

For each real (non-dry-run) published publication, periodically fetch its insights
from the Graph API and append a time-series row to post_metrics. Those rows feed the
per-channel performance ranking that auto-fill uses (see autofill.select_candidates).

Throttling: only publications published within metrics_max_age_days are refreshed, and
each is refreshed at most once per metrics_min_interval_hours.
"""

from __future__ import annotations

import json
from datetime import timedelta

from .config import Config

# Metrics requested from the IG media insights endpoint. We store whatever comes back;
# missing ones are simply null. (Available metrics vary by media type / API version.)
REQUESTED_METRICS = ["reach", "likes", "comments", "saved", "shares"]

# Map insight names -> our post_metrics columns.
COLUMN_MAP = {
    "reach": "reach",
    "impressions": "impressions",
    "likes": "likes",
    "comments": "comments",
    "saved": "saves",
    "shares": "shares",
    "video_views": "video_views",
    "plays": "video_views",
}


def publications_needing_metrics(conn, now, max_age_days: int, min_interval_hours: int):
    max_age_cutoff = (now - timedelta(days=max_age_days)).isoformat()
    interval_cutoff = (now - timedelta(hours=min_interval_hours)).isoformat()
    return conn.execute(
        """
        SELECT pub.* FROM publications pub
        WHERE pub.status = 'posted'
          AND pub.is_dry_run = 0
          AND pub.remote_post_id IS NOT NULL
          AND pub.remote_post_id != 'DRYRUN'
          AND pub.published_at IS NOT NULL
          AND pub.published_at >= ?
          AND (
            NOT EXISTS (
              SELECT 1 FROM post_metrics pm
              WHERE pm.publication_id = pub.id AND pm.fetched_at > ?
            )
            OR pub.metrics_refresh_requested_at IS NOT NULL
          )
        """,
        (max_age_cutoff, interval_cutoff),
    ).fetchall()


def _record(conn, publication_id: int, fetched_at: str, insights: dict) -> None:
    cols = {
        "reach": None, "impressions": None, "likes": None, "comments": None,
        "saves": None, "shares": None, "video_views": None,
    }
    for name, value in insights.items():
        col = COLUMN_MAP.get(name)
        if col:
            cols[col] = value
    conn.execute(
        """INSERT INTO post_metrics
             (publication_id, fetched_at, reach, impressions, likes, comments,
              saves, shares, video_views, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            publication_id, fetched_at, cols["reach"], cols["impressions"],
            cols["likes"], cols["comments"], cols["saves"], cols["shares"],
            cols["video_views"], json.dumps(insights),
        ),
    )
    conn.commit()


def run_metrics(conn, config: Config, client, now, logger=None) -> int:
    """Fetch + store metrics for all due publications. Returns count fetched."""
    now_iso = now.isoformat()
    due = publications_needing_metrics(
        conn, now, config.metrics_max_age_days, config.metrics_min_interval_hours
    )
    fetched = 0
    for pub in due:
        was_flagged = pub["metrics_refresh_requested_at"] is not None
        try:
            channel = conn.execute(
                "SELECT access_token FROM channels WHERE id = ?", (pub["channel_id"],)
            ).fetchone()
            token = channel["access_token"] if channel else None
            if not token:
                continue
            try:
                insights = client.get_media_insights(
                    pub["remote_post_id"], token, REQUESTED_METRICS
                )
            except Exception as exc:  # noqa: BLE001 — a metrics fetch failure is non-fatal
                if logger:
                    logger.info("[metrics pub %s] fetch failed: %s", pub["id"], exc)
                continue
            _record(conn, pub["id"], now_iso, insights)
            fetched += 1
        finally:
            if was_flagged:
                conn.execute(
                    "UPDATE publications SET metrics_refresh_requested_at = NULL WHERE id = ?",
                    (pub["id"],),
                )
                conn.commit()
    if logger and fetched:
        logger.info("[metrics] fetched %d snapshot(s)", fetched)
    return fetched
