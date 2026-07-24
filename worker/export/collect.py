"""Read-only extraction of the install's content into plain dataclasses.

Pure by design: give it a connection, get back an ExportBundle. No filesystem
writes and no network, so the hard parts — the relational reads and the rollups —
are testable without touching disk.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_NON_ALNUM = re.compile(r"[^a-zA-Z0-9]+")


def slugify(text: str | None, max_length: int = 40) -> str:
    """Filename-safe ASCII slug. Emoji-only and empty captions become 'untitled'.

    Google Drive and non-ASCII filenames get along badly, so we strip rather than
    percent-encode: a human reading the folder matters more than round-tripping.
    """
    if not text:
        return "untitled"
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_text = decomposed.encode("ascii", "ignore").decode("ascii")
    slug = _NON_ALNUM.sub("-", ascii_text).strip("-").lower()
    return slug[:max_length].strip("-") or "untitled"


@dataclass
class PostImage:
    """One asset as it appears inside one post, with its exported filename."""

    asset_id: int
    sort_order: int
    export_filename: str
    published_filename: str | None
    storage_path: str
    publish_path: str | None


@dataclass
class ExportedPost:
    post_id: int
    caption: str | None
    first_comment: str | None
    post_type: str
    content_kind: str
    content_status: str
    status: str
    cooldown_days: int | None
    created_by: str | None
    created_at: str | None
    updated_at: str | None
    tags: list[str] = field(default_factory=list)
    green_periods: list[str] = field(default_factory=list)
    blackout_periods: list[str] = field(default_factory=list)
    target_channels: list[str] = field(default_factory=list)
    images: list[PostImage] = field(default_factory=list)
    # Rollups, filled by add_rollups().
    times_posted: int = 0
    last_posted_at: str | None = None
    total_reach: int = 0
    total_likes: int = 0


def _grouped(conn: sqlite3.Connection, sql: str) -> dict[int, list[str]]:
    """Run a (post_id, value) query and group the values by post_id, order preserved."""
    out: dict[int, list[str]] = {}
    for row in conn.execute(sql):
        out.setdefault(row[0], []).append(row[1])
    return out


def collect_posts(conn: sqlite3.Connection) -> list[ExportedPost]:
    """Every post, with its tags, periods, targets, and named images attached.

    Rollup fields are left at their defaults here; add_rollups() fills them.
    """
    tags = _grouped(
        conn,
        "SELECT pt.post_id, t.name FROM post_tags pt"
        " JOIN tags t ON t.id = pt.tag_id ORDER BY t.name COLLATE NOCASE",
    )
    green = _grouped(
        conn,
        "SELECT pp.post_id, p.name FROM post_periods pp"
        " JOIN periods p ON p.id = pp.period_id"
        " WHERE pp.mode = 'green' ORDER BY p.name",
    )
    blackout = _grouped(
        conn,
        "SELECT pp.post_id, p.name FROM post_periods pp"
        " JOIN periods p ON p.id = pp.period_id"
        " WHERE pp.mode = 'blackout' ORDER BY p.name",
    )
    targets = _grouped(
        conn,
        "SELECT pt.post_id, c.account_name FROM post_targets pt"
        " JOIN channels c ON c.id = pt.channel_id ORDER BY c.account_name",
    )

    posts: list[ExportedPost] = []
    for row in conn.execute("SELECT * FROM posts ORDER BY id"):
        posts.append(
            ExportedPost(
                post_id=row["id"],
                caption=row["caption"],
                first_comment=row["first_comment"],
                post_type=row["post_type"],
                content_kind=row["content_kind"],
                content_status=row["content_status"],
                status=row["status"],
                cooldown_days=row["cooldown_days"],
                created_by=row["created_by"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                tags=tags.get(row["id"], []),
                green_periods=green.get(row["id"], []),
                blackout_periods=blackout.get(row["id"], []),
                target_channels=targets.get(row["id"], []),
                images=_images_for(conn, row["id"], row["caption"]),
            )
        )
    return posts


def _images_for(
    conn: sqlite3.Connection, post_id: int, caption: str | None
) -> list[PostImage]:
    """Name each of a post's assets. post_id + carousel position guarantees uniqueness,
    so no collision-suffix logic is needed (see the plan's deviation note)."""
    slug = slugify(caption)
    images: list[PostImage] = []
    rows = conn.execute(
        "SELECT pa.sort_order, a.id, a.storage_path, a.publish_path"
        " FROM post_assets pa JOIN assets a ON a.id = pa.asset_id"
        " WHERE pa.post_id = ? ORDER BY pa.sort_order",
        (post_id,),
    )
    for row in rows:
        position = row["sort_order"] + 1
        ext = Path(row["storage_path"]).suffix.lower() or ".bin"
        name = f"{post_id:04d}_{slug}_{position}{ext}"
        images.append(
            PostImage(
                asset_id=row["id"],
                sort_order=row["sort_order"],
                export_filename=name,
                published_filename=name if row["publish_path"] else None,
                storage_path=row["storage_path"],
                publish_path=row["publish_path"],
            )
        )
    return images


# Explicit allow-list. Secrets are excluded by naming what we DO emit, so a future
# migration that adds a credential column cannot leak it into an exported file.
# access_token and token_expires_at are deliberately absent.
CHANNEL_COLUMNS: tuple[str, ...] = (
    "id",
    "platform",
    "account_name",
    "business_label",
    "timezone",
    "is_active",
    "requires_approval",
    "autofill_enabled",
    "cadence_config",
    "min_queue_depth",
    "target_queue_depth",
    "reuse_min_age_days",
    "remote_account_id",
    "linked_page_id",
)

CAPTION_PREVIEW_CHARS = 60


def to_local(iso_utc: str | None, tz_name: str) -> str | None:
    """Render a stored UTC timestamp in a channel's timezone as 'YYYY-MM-DD HH:MM'.

    The database stores UTC; a spreadsheet that silently showed UTC would have every
    send time misread. Unparseable input is passed through rather than dropped.
    """
    if not iso_utc:
        return None
    try:
        dt = datetime.fromisoformat(iso_utc)
    except ValueError:
        return iso_utc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        zone = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        zone = timezone.utc
    return dt.astimezone(zone).strftime("%Y-%m-%d %H:%M")


@dataclass
class ExportedSend:
    publication_id: int
    post_id: int
    caption_preview: str
    channel_label: str
    scheduled_at_utc: str
    scheduled_at_local: str | None
    published_at_utc: str | None
    published_at_local: str | None
    status: str
    is_held: bool
    is_dry_run: bool
    attempt_count: int
    last_error: str | None
    remote_post_id: str | None


@dataclass
class ExportedMetric:
    publication_id: int
    post_id: int
    fetched_at: str
    reach: int | None
    impressions: int | None
    likes: int | None
    comments: int | None
    saves: int | None
    shares: int | None
    video_views: int | None
    raw_json: str | None


@dataclass
class ExportedAsset:
    asset_id: int
    content_hash: str
    media_kind: str
    original_filename: str | None
    storage_path: str
    publish_path: str | None
    conform_mode: str
    needs_review: bool
    mime_type: str | None
    width: int | None
    height: int | None
    byte_size: int | None


@dataclass
class ExportedChannel:
    channel_id: int
    platform: str
    account_name: str
    business_label: str | None
    timezone: str
    is_active: bool
    requires_approval: bool
    autofill_enabled: bool
    cadence_config: str | None
    min_queue_depth: int
    target_queue_depth: int
    reuse_min_age_days: int
    remote_account_id: str | None
    linked_page_id: str | None


@dataclass
class ExportBundle:
    generated_at: str
    posts: list[ExportedPost]
    sends: list[ExportedSend]
    metrics: list[ExportedMetric]
    assets: list[ExportedAsset]
    channels: list[ExportedChannel]


def collect_channels(conn: sqlite3.Connection) -> list[ExportedChannel]:
    columns = ", ".join(CHANNEL_COLUMNS)
    return [
        ExportedChannel(
            channel_id=row["id"],
            platform=row["platform"],
            account_name=row["account_name"],
            business_label=row["business_label"],
            timezone=row["timezone"],
            is_active=bool(row["is_active"]),
            requires_approval=bool(row["requires_approval"]),
            autofill_enabled=bool(row["autofill_enabled"]),
            cadence_config=row["cadence_config"],
            min_queue_depth=row["min_queue_depth"],
            target_queue_depth=row["target_queue_depth"],
            reuse_min_age_days=row["reuse_min_age_days"],
            remote_account_id=row["remote_account_id"],
            linked_page_id=row["linked_page_id"],
        )
        for row in conn.execute(f"SELECT {columns} FROM channels ORDER BY id")
    ]


def collect_sends(conn: sqlite3.Connection) -> list[ExportedSend]:
    rows = conn.execute(
        "SELECT pub.*, c.account_name, c.platform, c.timezone AS channel_tz,"
        "       p.caption"
        "  FROM publications pub"
        "  JOIN channels c ON c.id = pub.channel_id"
        "  JOIN posts    p ON p.id = pub.post_id"
        " ORDER BY pub.scheduled_at, pub.id"
    )
    sends = []
    for row in rows:
        tz_name = row["channel_tz"] or "UTC"
        caption = row["caption"] or ""
        sends.append(
            ExportedSend(
                publication_id=row["id"],
                post_id=row["post_id"],
                caption_preview=caption[:CAPTION_PREVIEW_CHARS],
                channel_label=f"{row['account_name']} ({row['platform']})",
                scheduled_at_utc=row["scheduled_at"],
                scheduled_at_local=to_local(row["scheduled_at"], tz_name),
                published_at_utc=row["published_at"],
                published_at_local=to_local(row["published_at"], tz_name),
                status=row["status"],
                is_held=bool(row["is_held"]),
                is_dry_run=bool(row["is_dry_run"]),
                attempt_count=row["attempt_count"],
                last_error=row["last_error"],
                remote_post_id=row["remote_post_id"],
            )
        )
    return sends


def collect_metrics(conn: sqlite3.Connection) -> list[ExportedMetric]:
    """Every snapshot, not just the newest — accumulation over a post's 30-day window
    is only chartable if the history survives, and discarding it is irreversible."""
    rows = conn.execute(
        "SELECT m.*, pub.post_id FROM post_metrics m"
        "  JOIN publications pub ON pub.id = m.publication_id"
        " ORDER BY m.publication_id, m.fetched_at"
    )
    return [
        ExportedMetric(
            publication_id=row["publication_id"],
            post_id=row["post_id"],
            fetched_at=row["fetched_at"],
            reach=row["reach"],
            impressions=row["impressions"],
            likes=row["likes"],
            comments=row["comments"],
            saves=row["saves"],
            shares=row["shares"],
            video_views=row["video_views"],
            raw_json=row["raw_json"],
        )
        for row in rows
    ]


def collect_assets(conn: sqlite3.Connection) -> list[ExportedAsset]:
    return [
        ExportedAsset(
            asset_id=row["id"],
            content_hash=row["content_hash"],
            media_kind=row["media_kind"],
            original_filename=row["original_filename"],
            storage_path=row["storage_path"],
            publish_path=row["publish_path"],
            conform_mode=row["conform_mode"],
            needs_review=bool(row["needs_review"]),
            mime_type=row["mime_type"],
            width=row["width"],
            height=row["height"],
            byte_size=row["byte_size"],
        )
        for row in conn.execute("SELECT * FROM assets ORDER BY id")
    ]


def add_rollups(conn: sqlite3.Connection, posts: list[ExportedPost]) -> None:
    """Fill times_posted / last_posted_at / total_reach / total_likes in place.

    Dry runs are excluded: they never reached Instagram, so counting them would
    overstate how often a piece of evergreen content has actually gone out.
    """
    counts = {
        row["post_id"]: (row["n"], row["last_at"])
        for row in conn.execute(
            "SELECT post_id, COUNT(*) AS n, MAX(published_at) AS last_at"
            "  FROM publications"
            " WHERE status = 'posted' AND is_dry_run = 0"
            " GROUP BY post_id"
        )
    }
    # Only the newest snapshot per publication, so repeated refreshes don't multiply.
    # A plain MAX(fetched_at)-then-rejoin can match more than one row when two
    # snapshots share the same fetched_at (there is no UNIQUE constraint on
    # (publication_id, fetched_at), and the worker computes one now_iso and reuses
    # it across a whole metrics-refresh batch) — that would double-count reach. A
    # window function picks exactly one row per publication_id, with ties broken on
    # id DESC so the choice is deterministic.
    totals: dict[int, tuple[int, int]] = {}
    latest = conn.execute(
        "SELECT post_id, reach, likes FROM ("
        "  SELECT pub.post_id AS post_id, m.reach AS reach, m.likes AS likes,"
        "         ROW_NUMBER() OVER ("
        "           PARTITION BY m.publication_id"
        "           ORDER BY m.fetched_at DESC, m.id DESC"
        "         ) AS rn"
        "    FROM post_metrics m"
        "    JOIN publications pub ON pub.id = m.publication_id"
        "   WHERE pub.is_dry_run = 0"
        ") ranked"
        " WHERE rn = 1"
    )
    for row in latest:
        reach, likes = totals.get(row["post_id"], (0, 0))
        totals[row["post_id"]] = (reach + (row["reach"] or 0), likes + (row["likes"] or 0))

    for post in posts:
        post.times_posted, post.last_posted_at = counts.get(post.post_id, (0, None))
        post.total_reach, post.total_likes = totals.get(post.post_id, (0, 0))


def collect_all(conn: sqlite3.Connection, generated_at: str) -> ExportBundle:
    """The whole install, as plain data. Read-only; safe under PRAGMA query_only."""
    posts = collect_posts(conn)
    add_rollups(conn, posts)
    return ExportBundle(
        generated_at=generated_at,
        posts=posts,
        sends=collect_sends(conn),
        metrics=collect_metrics(conn),
        assets=collect_assets(conn),
        channels=collect_channels(conn),
    )
