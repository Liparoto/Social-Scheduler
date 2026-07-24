"""Turn an ExportBundle into the files a human (and a future importer) can use.

Everything here writes only inside the run's own output directory. Nothing in this
module touches the database or the network.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field, asdict
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter

from worker.export.collect import ExportBundle

IMAGES_DIR = "images"
PUBLISHED_DIR = "images-published"


@dataclass
class CopyResult:
    copied: int = 0
    # Means exactly one thing: the asset's ORIGINAL (storage_path) could not be
    # exported. A missing/unreadable CONFORMED copy is recorded in `problems`
    # only — never here — since the irreplaceable source still exported fine.
    missing_asset_ids: set[int] = field(default_factory=set)
    problems: list[str] = field(default_factory=list)


def _resolve(asset_root: Path, stored_path: str) -> Path:
    """Where an asset row's file actually lives.

    storage_path holds a bare content-hash filename relative to the asset store
    (verified against the live database). Absolute paths are tolerated in case an
    install ever stores them that way.
    """
    candidate = Path(stored_path)
    return candidate if candidate.is_absolute() else asset_root / candidate


def _copy_one(
    src: Path, dest_dir: Path, name: str, result: CopyResult, asset_id: int, *, is_original: bool
) -> bool:
    kind = "original" if is_original else "conformed copy"
    if not src.is_file():
        if is_original:
            result.missing_asset_ids.add(asset_id)
        result.problems.append(f"asset {asset_id}: {kind} not found at {src}")
        return False
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest_dir / name)
    except OSError as exc:
        if is_original:
            result.missing_asset_ids.add(asset_id)
        result.problems.append(f"asset {asset_id}: could not copy {kind} {src} ({exc})")
        return False
    result.copied += 1
    return True


def copy_images(bundle: ExportBundle, asset_root: Path, out_dir: Path) -> CopyResult:
    """Copy every post's images under their exported names.

    An asset shared by two posts is written once per post, under each post's own
    name — duplication on disk is cheaper than a filename that only makes sense
    with the workbook open.

    `missing_asset_ids` reflects only the ORIGINAL file (storage_path). A missing
    or unreadable CONFORMED copy (publish_path) is noted in `problems` but never
    added there — the irreplaceable source still exported fine.
    """
    result = CopyResult()
    for post in bundle.posts:
        for image in post.images:
            _copy_one(
                _resolve(asset_root, image.storage_path),
                out_dir / IMAGES_DIR,
                image.export_filename,
                result,
                image.asset_id,
                is_original=True,
            )
            if image.publish_path and image.published_filename:
                _copy_one(
                    _resolve(asset_root, image.publish_path),
                    out_dir / PUBLISHED_DIR,
                    image.published_filename,
                    result,
                    image.asset_id,
                    is_original=False,
                )
    return result


# Bump when the JSON shape changes incompatibly, so a future importer can branch.
JSON_FORMAT_VERSION = 1


def write_json(bundle: ExportBundle, out_dir: Path) -> Path:
    """Full-fidelity machine-readable dump, for a future re-import.

    Nested rather than flat: a post CONTAINS its images, which a spreadsheet cannot
    express. Secrets are absent because collect.py never read them — this is not a
    raw table dump.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "format_version": JSON_FORMAT_VERSION,
        "generated_at": bundle.generated_at,
        "posts": [asdict(p) for p in bundle.posts],
        "sends": [asdict(s) for s in bundle.sends],
        "metrics": [asdict(m) for m in bundle.metrics],
        "assets": [asdict(a) for a in bundle.assets],
        "channels": [asdict(c) for c in bundle.channels],
    }
    path = out_dir / "export.json"
    # ensure_ascii=False keeps captions readable if someone opens this in a text editor.
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


WORKBOOK_NAME = "SocialScheduler-Export.xlsx"
MAX_COLUMN_WIDTH = 60


def _join(values: list[str] | list[int]) -> str:
    return ", ".join(str(v) for v in values)


def _add_sheet(book: Workbook, title: str, headers: list[str], rows: list[list]) -> None:
    """One tab: a bold frozen header row, the data, and readable column widths."""
    sheet = book.create_sheet(title)
    sheet.append(headers)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    sheet.freeze_panes = "A2"
    for row in rows:
        sheet.append(row)
    for index, header in enumerate(headers, start=1):
        widths = [len(str(header))]
        widths += [
            len(str(row[index - 1])) for row in rows if row[index - 1] is not None
        ]
        sheet.column_dimensions[get_column_letter(index)].width = min(
            max(widths) + 2, MAX_COLUMN_WIDTH
        )
    sheet.auto_filter.ref = sheet.dimensions


POSTS_HEADERS = [
    "post_id", "caption", "first_comment", "post_type", "content_kind", "content_status",
    "status", "tags", "green_periods", "blackout_periods", "cooldown_days",
    "target_channels", "image_files", "times_posted", "last_posted_at", "total_reach",
    "total_likes", "created_by", "created_at",
]

SENDS_HEADERS = [
    "publication_id", "post_id", "caption_preview", "channel", "scheduled_at_local",
    "scheduled_at_utc", "published_at_local", "status", "is_held", "is_dry_run",
    "attempt_count", "last_error", "remote_post_id",
]

METRICS_HEADERS = [
    "publication_id", "post_id", "fetched_at", "reach", "impressions", "likes",
    "comments", "saves", "shares", "video_views",
]

ASSETS_HEADERS = [
    "asset_id", "exported_filename", "original_filename", "media_kind", "width", "height",
    "byte_size", "conform_mode", "needs_review", "content_hash", "used_by_posts",
    "published_copy_filename",
]

CHANNELS_HEADERS = [
    "channel_id", "platform", "account_name", "business_label", "timezone", "is_active",
    "requires_approval", "autofill_enabled", "cadence_config", "min_queue_depth",
    "target_queue_depth", "reuse_min_age_days", "remote_account_id", "linked_page_id",
]


def write_workbook(
    bundle: ExportBundle, out_dir: Path, missing_asset_ids: set[int]
) -> Path:
    """The human artifact: five tabs, each with one clear grain.

    Written after the images are copied, because the Assets tab reports which files
    were missing from disk.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    book = Workbook()
    book.remove(book.active)  # drop openpyxl's default empty sheet

    _add_sheet(book, "Posts", POSTS_HEADERS, [
        [
            p.post_id, p.caption, p.first_comment, p.post_type, p.content_kind,
            p.content_status, p.status, _join(p.tags), _join(p.green_periods),
            _join(p.blackout_periods), p.cooldown_days, _join(p.target_channels),
            _join([i.export_filename for i in p.images]), p.times_posted,
            p.last_posted_at, p.total_reach, p.total_likes, p.created_by, p.created_at,
        ]
        for p in bundle.posts
    ])

    _add_sheet(book, "Sends", SENDS_HEADERS, [
        [
            s.publication_id, s.post_id, s.caption_preview, s.channel_label,
            s.scheduled_at_local, s.scheduled_at_utc, s.published_at_local, s.status,
            s.is_held, s.is_dry_run, s.attempt_count, s.last_error, s.remote_post_id,
        ]
        for s in bundle.sends
    ])

    _add_sheet(book, "Metrics", METRICS_HEADERS, [
        [
            m.publication_id, m.post_id, m.fetched_at, m.reach, m.impressions, m.likes,
            m.comments, m.saves, m.shares, m.video_views,
        ]
        for m in bundle.metrics
    ])

    # An asset can appear in several posts under a different name in each.
    usage: dict[int, list[int]] = {}
    names: dict[int, list[str]] = {}
    published: dict[int, list[str]] = {}
    for post in bundle.posts:
        for image in post.images:
            usage.setdefault(image.asset_id, []).append(post.post_id)
            names.setdefault(image.asset_id, []).append(image.export_filename)
            if image.published_filename:
                published.setdefault(image.asset_id, []).append(image.published_filename)

    _add_sheet(book, "Assets", ASSETS_HEADERS, [
        [
            a.asset_id,
            "MISSING" if a.asset_id in missing_asset_ids else _join(names.get(a.asset_id, [])),
            a.original_filename, a.media_kind, a.width, a.height, a.byte_size,
            a.conform_mode, a.needs_review, a.content_hash,
            _join(usage.get(a.asset_id, [])), _join(published.get(a.asset_id, [])),
        ]
        for a in bundle.assets
    ])

    _add_sheet(book, "Channels", CHANNELS_HEADERS, [
        [
            c.channel_id, c.platform, c.account_name, c.business_label, c.timezone,
            c.is_active, c.requires_approval, c.autofill_enabled, c.cadence_config,
            c.min_queue_depth, c.target_queue_depth, c.reuse_min_age_days,
            c.remote_account_id, c.linked_page_id,
        ]
        for c in bundle.channels
    ])

    # Captions are long; wrapping keeps the Posts tab scannable.
    for cell in book["Posts"]["B"]:
        cell.alignment = Alignment(wrap_text=True, vertical="top")

    path = out_dir / WORKBOOK_NAME
    book.save(path)
    return path
