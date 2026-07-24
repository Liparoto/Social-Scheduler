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
from pathlib import Path

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
