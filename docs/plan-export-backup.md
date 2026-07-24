# Export & Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A double-click script that exports every post, send, metric, tag, and image into a dated folder containing a 5-tab Excel workbook, a full-fidelity JSON file, and the image files themselves.

**Architecture:** Three focused modules under `worker/export/`. `collect.py` turns a database connection into plain dataclasses — pure, no filesystem, no network, so the relational reads and rollups are testable in isolation. `write.py` turns those dataclasses into files on disk. `__main__.py` orchestrates and is the `python -m worker.export` entry point. A `Export-Mac.command` wrapper makes it double-clickable.

**Tech Stack:** Python 3 (stdlib: `sqlite3`, `zoneinfo`, `json`, `shutil`, `unicodedata`), `openpyxl` for `.xlsx`, `pytest` for tests.

**Spec:** `docs/design-export-backup.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **The `channels` allow-list is absolute.** `access_token` and `token_expires_at` must never appear in any output file — workbook, JSON, or README. Columns are named explicitly; never `SELECT *` from `channels`.
- **Read-only.** The export connection sets `PRAGMA query_only = ON`. No task may add a write.
- **Zero network calls.** No Graph API, no tunnel, no `requests` import anywhere in `worker/export/`.
- **Never overwrite.** Each run creates a new `YYYY-MM-DD-HHMM` folder.
- **Never log secrets**, consistent with existing project rules.
- Timestamps render as `YYYY-MM-DD HH:MM` in the relevant channel's IANA timezone, with raw UTC in an adjacent column.
- Slugs: ASCII-only, lowercased, non-alphanumerics collapsed to `-`, truncated to 40 chars, `untitled` fallback.
- Image filename format: `{post_id:04d}_{slug}_{position}{ext}` where `position` is `sort_order + 1`.
- New dependency floor: `openpyxl>=3.1`.
- Python: run everything through the repo venv — `.venv/bin/python`, `.venv/bin/pytest`.

## Deviations from the spec

Both are deliberate; the spec text is otherwise authoritative.

1. **Package, not a single module.** The spec said `worker/export.py`. One file covering DB reads, slugging, image copying, xlsx and JSON writing would be ~600 lines. Split into `worker/export/{collect,write,__main__}.py`. The invocation `python -m worker.export` is unchanged.
2. **No filename-uniqueness suffix.** The spec mentioned suffixing collisions. Since a filename embeds `post_id` and a carousel `position` (unique per post via the `UNIQUE (post_id, sort_order)` constraint), collisions cannot occur. Untested defensive code is replaced by Task 2's test asserting all filenames in a bundle are unique.

## File Structure

| File | Responsibility |
|---|---|
| `worker/export/__init__.py` | Empty package marker. |
| `worker/export/collect.py` | Database → dataclasses. Pure. Owns SQL, rollups, slugs, timezone conversion, the channel allow-list. |
| `worker/export/write.py` | Dataclasses → files. Owns image copying, xlsx layout, JSON serialization, README. |
| `worker/export/__main__.py` | Entry point. Owns config loading, the read-only connection, output directory naming, exit codes, console output. |
| `worker/tests/test_export_collect.py` | Tests for `collect.py`. |
| `worker/tests/test_export_write.py` | Tests for `write.py`. |
| `worker/tests/test_export_main.py` | End-to-end + safety tests. |
| `Export-Mac.command` | Double-click wrapper. |
| `requirements.txt` | Add `openpyxl>=3.1`. |

Tests are split by module rather than the single `test_export.py` the spec named, matching the existing one-file-per-module convention in `worker/tests/`.

Existing fixtures in `worker/tests/conftest.py` are reused throughout: `db_path` (a temp DB built from all migrations), `config`, `conn`, and `make_publication`. Do not duplicate them.

---

### Task 1: Package scaffold, dependency, and slugify

**Files:**
- Create: `worker/export/__init__.py`
- Create: `worker/export/collect.py`
- Create: `worker/tests/test_export_collect.py`
- Modify: `requirements.txt`

**Interfaces:**
- Consumes: nothing.
- Produces: `slugify(text: str | None, max_length: int = 40) -> str`

- [ ] **Step 1: Install the dependency**

```bash
.venv/bin/pip install 'openpyxl>=3.1'
```

Expected: `Successfully installed openpyxl-3.x.x et-xmlfile-x.x.x`

- [ ] **Step 2: Record the dependency**

Append to `requirements.txt`, after the `requests>=2.32` line:

```
# Export: writing the multi-tab .xlsx workbook (pure Python, no system libraries).
openpyxl>=3.1
```

- [ ] **Step 3: Create the empty package marker**

Create `worker/export/__init__.py` containing exactly:

```python
"""Read-only export of the install's content to a portable folder."""
```

- [ ] **Step 4: Write the failing test**

Create `worker/tests/test_export_collect.py`:

```python
"""Tests for turning the database into export dataclasses."""

from __future__ import annotations

import pytest

from worker.export.collect import slugify


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Shoulder Mobility Tips", "shoulder-mobility-tips"),
        ("  Balance   Screening!! ", "balance-screening"),
        ("Café naïve", "cafe-naive"),
        ("🎉🎉🎉", "untitled"),
        ("", "untitled"),
        (None, "untitled"),
        ("a" * 80, "a" * 40),
    ],
)
def test_slugify_normalizes_captions(raw, expected):
    assert slugify(raw) == expected


def test_slugify_does_not_end_in_a_dash_after_truncation():
    # Truncating mid-word must not leave a trailing separator.
    assert not slugify("word " * 20).endswith("-")
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `.venv/bin/pytest worker/tests/test_export_collect.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'worker.export.collect'`

- [ ] **Step 6: Write the implementation**

Create `worker/export/collect.py`:

```python
"""Read-only extraction of the install's content into plain dataclasses.

Pure by design: give it a connection, get back an ExportBundle. No filesystem
writes and no network, so the hard parts — the relational reads and the rollups —
are testable without touching disk.
"""

from __future__ import annotations

import re
import unicodedata

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
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `.venv/bin/pytest worker/tests/test_export_collect.py -v`
Expected: PASS — 8 passed

- [ ] **Step 8: Commit**

```bash
git add worker/export/__init__.py worker/export/collect.py worker/tests/test_export_collect.py requirements.txt
git commit -m "feat(export): package scaffold, openpyxl dependency, filename slugify"
```

---

### Task 2: Collect posts, tags, periods, targets, and images

**Files:**
- Modify: `worker/export/collect.py`
- Modify: `worker/tests/test_export_collect.py`

**Interfaces:**
- Consumes: `slugify` from Task 1.
- Produces:
  - `@dataclass PostImage` — fields `asset_id: int`, `sort_order: int`, `export_filename: str`, `published_filename: str | None`, `storage_path: str`, `publish_path: str | None`
  - `@dataclass ExportedPost` — fields `post_id: int`, `caption: str | None`, `first_comment: str | None`, `post_type: str`, `content_kind: str`, `content_status: str`, `status: str`, `cooldown_days: int | None`, `created_by: str | None`, `created_at: str | None`, `updated_at: str | None`, `tags: list[str]`, `green_periods: list[str]`, `blackout_periods: list[str]`, `target_channels: list[str]`, `images: list[PostImage]`, `times_posted: int`, `last_posted_at: str | None`, `total_reach: int`, `total_likes: int`
  - `collect_posts(conn) -> list[ExportedPost]` — rollup fields are all zero/None at this stage; Task 3 fills them.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_export_collect.py`:

```python
from worker.export.collect import collect_posts


def _post_with(conn, caption="Shoulder Mobility Tips", post_type="single"):
    cur = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES (?, ?)", (caption, post_type)
    )
    return cur.lastrowid


def test_collect_posts_returns_empty_list_for_empty_database(conn):
    assert collect_posts(conn) == []


def test_collect_posts_reads_core_fields(conn):
    post_id = _post_with(conn)
    conn.commit()

    posts = collect_posts(conn)

    assert len(posts) == 1
    assert posts[0].post_id == post_id
    assert posts[0].caption == "Shoulder Mobility Tips"
    assert posts[0].post_type == "single"
    assert posts[0].content_kind == "evergreen"


def test_collect_posts_joins_tags_periods_and_targets(conn):
    post_id = _post_with(conn)
    tag_id = conn.execute("INSERT INTO tags (name) VALUES ('mobility')").lastrowid
    conn.execute("INSERT INTO post_tags (post_id, tag_id) VALUES (?,?)", (post_id, tag_id))

    green = conn.execute(
        "INSERT INTO periods (name, start_month, start_day, end_month, end_day)"
        " VALUES ('Summer', 6, 1, 8, 31)"
    ).lastrowid
    black = conn.execute(
        "INSERT INTO periods (name, start_month, start_day, end_month, end_day)"
        " VALUES ('Holidays', 12, 20, 12, 31)"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?,'green')",
        (post_id, green),
    )
    conn.execute(
        "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?,'blackout')",
        (post_id, black),
    )

    channel_id = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram', 'Test IG')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (post_id, channel_id)
    )
    conn.commit()

    post = collect_posts(conn)[0]

    assert post.tags == ["mobility"]
    assert post.green_periods == ["Summer"]
    assert post.blackout_periods == ["Holidays"]
    assert post.target_channels == ["Test IG"]


def test_collect_posts_names_images_by_post_and_carousel_position(conn):
    post_id = _post_with(conn, caption="Shoulder Mobility Tips", post_type="carousel")
    for i in range(2):
        asset_id = conn.execute(
            "INSERT INTO assets (content_hash, media_kind, storage_path)"
            " VALUES (?, 'image', ?)",
            (f"hash-{i}", f"assets/raw-{i}.JPG"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,?)",
            (post_id, asset_id, i),
        )
    conn.commit()

    post = collect_posts(conn)[0]

    assert [img.export_filename for img in post.images] == [
        f"{post_id:04d}_shoulder-mobility-tips_1.jpg",
        f"{post_id:04d}_shoulder-mobility-tips_2.jpg",
    ]


def test_collect_posts_orders_images_by_sort_order_not_insertion(conn):
    post_id = _post_with(conn, post_type="carousel")
    first = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path)"
        " VALUES ('h-b', 'image', 'assets/b.jpg')"
    ).lastrowid
    second = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path)"
        " VALUES ('h-a', 'image', 'assets/a.jpg')"
    ).lastrowid
    # Insert position 1 before position 0.
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,1)",
        (post_id, first),
    )
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
        (post_id, second),
    )
    conn.commit()

    post = collect_posts(conn)[0]

    assert [img.asset_id for img in post.images] == [second, first]


def test_collect_posts_sets_published_filename_only_when_conformed(conn):
    post_id = _post_with(conn)
    plain = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path)"
        " VALUES ('h-plain', 'image', 'assets/plain.jpg')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
        (post_id, plain),
    )
    other_id = _post_with(conn, caption="Cropped One")
    cropped = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path, publish_path,"
        " conform_mode) VALUES ('h-crop', 'image', 'assets/c.jpg', 'assets/c-pub.jpg', 'crop')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
        (other_id, cropped),
    )
    conn.commit()

    by_id = {p.post_id: p for p in collect_posts(conn)}

    assert by_id[post_id].images[0].published_filename is None
    assert by_id[other_id].images[0].published_filename == (
        f"{other_id:04d}_cropped-one_1.jpg"
    )


def test_collect_posts_produces_globally_unique_image_filenames(conn):
    # An asset shared by two posts is exported under each post's own name; post_id
    # plus carousel position makes every name unique without any suffix logic.
    shared = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path)"
        " VALUES ('h-shared', 'image', 'assets/shared.jpg')"
    ).lastrowid
    for _ in range(2):
        post_id = _post_with(conn, caption="Same Caption")
        conn.execute(
            "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
            (post_id, shared),
        )
    conn.commit()

    names = [img.export_filename for p in collect_posts(conn) for img in p.images]

    assert len(names) == 2
    assert len(set(names)) == 2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest worker/tests/test_export_collect.py -v`
Expected: FAIL — `ImportError: cannot import name 'collect_posts'`

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `worker/export/collect.py`:

```python
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
```

Append to `worker/export/collect.py`:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest worker/tests/test_export_collect.py -v`
Expected: PASS — 15 passed

- [ ] **Step 5: Commit**

```bash
git add worker/export/collect.py worker/tests/test_export_collect.py
git commit -m "feat(export): collect posts with tags, periods, targets, named images"
```

---

### Task 3: Collect sends, metrics, assets, channels, and rollups

**Files:**
- Modify: `worker/export/collect.py`
- Modify: `worker/tests/test_export_collect.py`

**Interfaces:**
- Consumes: `ExportedPost`, `PostImage`, `collect_posts` from Task 2.
- Produces:
  - `CHANNEL_COLUMNS: tuple[str, ...]` — the allow-list.
  - `to_local(iso_utc: str | None, tz_name: str) -> str | None`
  - `@dataclass ExportedSend` — `publication_id`, `post_id`, `caption_preview`, `channel_label`, `scheduled_at_utc`, `scheduled_at_local`, `published_at_utc`, `published_at_local`, `status`, `is_held`, `is_dry_run`, `attempt_count`, `last_error`, `remote_post_id`
  - `@dataclass ExportedMetric` — `publication_id`, `post_id`, `fetched_at`, `reach`, `impressions`, `likes`, `comments`, `saves`, `shares`, `video_views`, `raw_json`
  - `@dataclass ExportedAsset` — `asset_id`, `content_hash`, `media_kind`, `original_filename`, `storage_path`, `publish_path`, `conform_mode`, `needs_review`, `mime_type`, `width`, `height`, `byte_size`
  - `@dataclass ExportedChannel` — one attribute per name in `CHANNEL_COLUMNS`, with `id` renamed to `channel_id`
  - `@dataclass ExportBundle` — `generated_at: str`, `posts`, `sends`, `metrics`, `assets`, `channels`
  - `collect_all(conn, generated_at: str) -> ExportBundle`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_export_collect.py`:

```python
import sqlite3

from worker.export.collect import CHANNEL_COLUMNS, collect_all, to_local

GENERATED_AT = "2026-07-24T19:30:00+00:00"


def test_channel_allow_list_excludes_every_secret():
    assert "access_token" not in CHANNEL_COLUMNS
    assert "token_expires_at" not in CHANNEL_COLUMNS


def test_channel_allow_list_only_names_real_columns(conn):
    actual = {r[1] for r in conn.execute("PRAGMA table_info(channels)")}
    assert set(CHANNEL_COLUMNS) <= actual


def test_to_local_converts_utc_into_the_channel_timezone():
    assert to_local("2026-07-24T18:00:00+00:00", "America/New_York") == "2026-07-24 14:00"


def test_to_local_treats_naive_timestamps_as_utc():
    assert to_local("2026-07-24T18:00:00", "America/New_York") == "2026-07-24 14:00"


def test_to_local_falls_back_to_utc_for_an_unknown_timezone():
    assert to_local("2026-07-24T18:00:00+00:00", "Mars/Olympus") == "2026-07-24 18:00"


def test_to_local_returns_none_for_missing_timestamps():
    assert to_local(None, "UTC") is None


def test_collect_all_never_reads_the_access_token(conn, make_publication):
    make_publication()

    bundle = collect_all(conn, GENERATED_AT)

    assert len(bundle.channels) == 1
    assert not hasattr(bundle.channels[0], "access_token")


def test_collect_all_on_an_empty_database_returns_empty_lists(conn):
    bundle = collect_all(conn, GENERATED_AT)

    assert bundle.generated_at == GENERATED_AT
    assert bundle.posts == []
    assert bundle.sends == []
    assert bundle.metrics == []
    assert bundle.assets == []
    assert bundle.channels == []


def test_collect_all_builds_sends_with_local_and_utc_times(conn, make_publication):
    pub = make_publication()
    conn.execute("UPDATE channels SET timezone = 'America/New_York'")
    conn.execute(
        "UPDATE publications SET scheduled_at = '2026-07-24T18:00:00+00:00' WHERE id = ?",
        (pub["id"],),
    )
    conn.commit()

    send = collect_all(conn, GENERATED_AT).sends[0]

    assert send.scheduled_at_utc == "2026-07-24T18:00:00+00:00"
    assert send.scheduled_at_local == "2026-07-24 14:00"
    assert send.caption_preview == "hello world"


def test_rollups_count_only_real_posted_sends(conn, make_publication):
    pub = make_publication()
    post_id = pub["post_id"]
    channel_id = pub["channel_id"]
    conn.execute(
        "UPDATE publications SET status='posted', published_at='2026-07-01T12:00:00+00:00'"
        " WHERE id = ?",
        (pub["id"],),
    )
    # A dry run and a failure must not count toward times_posted.
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at,"
        " is_dry_run) VALUES (?,?,'2026-07-02T12:00:00+00:00','posted',"
        "'2026-07-02T12:00:00+00:00',1)",
        (post_id, channel_id),
    )
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status)"
        " VALUES (?,?,'2026-07-03T12:00:00+00:00','failed')",
        (post_id, channel_id),
    )
    conn.commit()

    post = collect_all(conn, GENERATED_AT).posts[0]

    assert post.times_posted == 1
    assert post.last_posted_at == "2026-07-01T12:00:00+00:00"


def test_rollups_sum_only_the_latest_metric_snapshot_per_send(conn, make_publication):
    pub = make_publication()
    conn.execute("UPDATE publications SET status='posted' WHERE id = ?", (pub["id"],))
    for fetched, reach, likes in [
        ("2026-07-01T00:00:00+00:00", 100, 10),
        ("2026-07-05T00:00:00+00:00", 400, 40),
    ]:
        conn.execute(
            "INSERT INTO post_metrics (publication_id, fetched_at, reach, likes)"
            " VALUES (?,?,?,?)",
            (pub["id"], fetched, reach, likes),
        )
    conn.commit()

    bundle = collect_all(conn, GENERATED_AT)

    # Both snapshots are kept for charting, but the rollup counts the newest only.
    assert len(bundle.metrics) == 2
    assert bundle.posts[0].total_reach == 400
    assert bundle.posts[0].total_likes == 40


def test_collect_all_is_read_only_under_query_only(db_path):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON;")

    # Must not raise: every statement collect_all issues is a read.
    bundle = collect_all(conn, GENERATED_AT)

    assert bundle.posts == []
    conn.close()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest worker/tests/test_export_collect.py -v`
Expected: FAIL — `ImportError: cannot import name 'CHANNEL_COLUMNS'`

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `worker/export/collect.py`:

```python
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
```

Append to `worker/export/collect.py`:

```python
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
    # ROW_NUMBER rather than a MAX(fetched_at) re-join: nothing constrains
    # (publication_id, fetched_at) to be unique, and a re-join would sum BOTH rows
    # on a tie. id DESC makes the pick deterministic when timestamps collide.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest worker/tests/test_export_collect.py -v`
Expected: PASS — 28 passed

- [ ] **Step 5: Commit**

```bash
git add worker/export/collect.py worker/tests/test_export_collect.py
git commit -m "feat(export): collect sends, metrics, assets, channels, and post rollups"
```

---

### Task 4: Copy image files, tolerating missing ones

**Files:**
- Create: `worker/export/write.py`
- Create: `worker/tests/test_export_write.py`

**Interfaces:**
- Consumes: `ExportBundle`, `ExportedPost`, `PostImage` from Task 3.
- Produces:
  - `@dataclass CopyResult` — `copied: int`, `missing_asset_ids: set[int]`, `problems: list[str]`
  - `copy_images(bundle: ExportBundle, asset_root: Path, out_dir: Path) -> CopyResult`

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_export_write.py`:

```python
"""Tests for turning an ExportBundle into files on disk."""

from __future__ import annotations

from worker.export.collect import ExportBundle, ExportedPost, PostImage
from worker.export.write import copy_images

GENERATED_AT = "2026-07-24T19:30:00+00:00"


def _bundle(posts):
    return ExportBundle(
        generated_at=GENERATED_AT, posts=posts, sends=[], metrics=[],
        assets=[], channels=[],
    )


def _post(post_id, images):
    return ExportedPost(
        post_id=post_id, caption="Test Post", first_comment=None, post_type="single",
        content_kind="evergreen", content_status="ready", status="draft",
        cooldown_days=None, created_by=None, created_at=None, updated_at=None,
        images=images,
    )


def _image(asset_id, name, storage_path, publish_path=None, published_name=None):
    return PostImage(
        asset_id=asset_id, sort_order=0, export_filename=name,
        published_filename=published_name, storage_path=storage_path,
        publish_path=publish_path,
    )


def test_copy_images_writes_originals_into_the_images_folder(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "a.jpg").write_bytes(b"original-bytes")
    out = tmp_path / "out"

    result = copy_images(
        _bundle([_post(42, [_image(1, "0042_test-post_1.jpg", "a.jpg")])]),
        asset_root=assets,
        out_dir=out,
    )

    assert result.copied == 1
    assert result.missing_asset_ids == set()
    assert (out / "images" / "0042_test-post_1.jpg").read_bytes() == b"original-bytes"


def test_copy_images_writes_conformed_copies_into_a_separate_folder(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "a.jpg").write_bytes(b"original-bytes")
    (assets / "a-pub.jpg").write_bytes(b"cropped-bytes")
    out = tmp_path / "out"

    copy_images(
        _bundle([_post(42, [_image(
            1, "0042_test-post_1.jpg", "a.jpg",
            publish_path="a-pub.jpg", published_name="0042_test-post_1.jpg",
        )])]),
        asset_root=assets,
        out_dir=out,
    )

    assert (out / "images" / "0042_test-post_1.jpg").read_bytes() == b"original-bytes"
    assert (out / "images-published" / "0042_test-post_1.jpg").read_bytes() == b"cropped-bytes"


def test_copy_images_skips_the_published_folder_when_nothing_was_conformed(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "a.jpg").write_bytes(b"x")
    out = tmp_path / "out"

    copy_images(
        _bundle([_post(42, [_image(1, "0042_test-post_1.jpg", "a.jpg")])]),
        asset_root=assets,
        out_dir=out,
    )

    assert not (out / "images-published").exists()


def test_copy_images_records_missing_files_instead_of_raising(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "present.jpg").write_bytes(b"here")
    out = tmp_path / "out"

    result = copy_images(
        _bundle([_post(42, [
            _image(1, "0042_test-post_1.jpg", "present.jpg"),
            _image(2, "0042_test-post_2.jpg", "gone.jpg"),
        ])]),
        asset_root=assets,
        out_dir=out,
    )

    # A partial backup you know is partial beats a crash and no backup.
    assert result.copied == 1
    assert result.missing_asset_ids == {2}
    assert len(result.problems) == 1
    assert "gone.jpg" in result.problems[0]


def test_copy_images_exports_a_shared_asset_once_per_post(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "shared.jpg").write_bytes(b"shared-bytes")
    out = tmp_path / "out"

    result = copy_images(
        _bundle([
            _post(42, [_image(1, "0042_test-post_1.jpg", "shared.jpg")]),
            _post(51, [_image(1, "0051_test-post_1.jpg", "shared.jpg")]),
        ]),
        asset_root=assets,
        out_dir=out,
    )

    assert result.copied == 2
    assert (out / "images" / "0042_test-post_1.jpg").exists()
    assert (out / "images" / "0051_test-post_1.jpg").exists()


def test_copy_images_handles_a_bundle_with_no_images(tmp_path):
    out = tmp_path / "out"

    result = copy_images(_bundle([_post(42, [])]), asset_root=tmp_path, out_dir=out)

    assert result.copied == 0
    assert result.missing_asset_ids == set()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest worker/tests/test_export_write.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'worker.export.write'`

- [ ] **Step 3: Write the implementation**

Create `worker/export/write.py`:

```python
"""Turn an ExportBundle into the files a human (and a future importer) can use.

Everything here writes only inside the run's own output directory. Nothing in this
module touches the database or the network.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from worker.export.collect import ExportBundle

IMAGES_DIR = "images"
PUBLISHED_DIR = "images-published"


@dataclass
class CopyResult:
    copied: int = 0
    # AS SHIPPED (review fix): missing_asset_ids means the asset's ORIGINAL could not
    # be exported — that is the only thing the Assets tab should mark MISSING. A
    # missing CONFORMED copy is recorded in `problems` only, because the original is
    # still sitting in images/ and calling it missing would be a false alarm about
    # irreplaceable data. See worker/export/write.py for the shipped wording.
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


def _copy_one(src: Path, dest_dir: Path, name: str, result: CopyResult, asset_id: int) -> bool:
    if not src.is_file():
        result.missing_asset_ids.add(asset_id)
        result.problems.append(f"asset {asset_id}: file not found at {src}")
        return False
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest_dir / name)
    except OSError as exc:
        result.problems.append(f"asset {asset_id}: could not copy {src} ({exc})")
        return False
    result.copied += 1
    return True


def copy_images(bundle: ExportBundle, asset_root: Path, out_dir: Path) -> CopyResult:
    """Copy every post's images under their exported names.

    An asset shared by two posts is written once per post, under each post's own
    name — duplication on disk is cheaper than a filename that only makes sense
    with the workbook open.
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
            )
            if image.publish_path and image.published_filename:
                _copy_one(
                    _resolve(asset_root, image.publish_path),
                    out_dir / PUBLISHED_DIR,
                    image.published_filename,
                    result,
                    image.asset_id,
                )
    return result
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest worker/tests/test_export_write.py -v`
Expected: PASS — 6 passed

- [ ] **Step 5: Commit**

```bash
git add worker/export/write.py worker/tests/test_export_write.py
git commit -m "feat(export): copy original and conformed images, flagging missing files"
```

---

### Task 5: Write export.json

**Files:**
- Modify: `worker/export/write.py`
- Modify: `worker/tests/test_export_write.py`

**Interfaces:**
- Consumes: `ExportBundle`, `CopyResult` from Tasks 3–4.
- Produces: `write_json(bundle: ExportBundle, out_dir: Path) -> Path`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_export_write.py`:

```python
import json

from worker.export.collect import ExportedChannel, ExportedSend
from worker.export.write import write_json


def _channel():
    return ExportedChannel(
        channel_id=1, platform="instagram", account_name="Test IG",
        business_label=None, timezone="UTC", is_active=True, requires_approval=False,
        autofill_enabled=False, cadence_config=None, min_queue_depth=0,
        target_queue_depth=0, reuse_min_age_days=180, remote_account_id="178414",
        linked_page_id=None,
    )


def test_write_json_round_trips_the_bundle(tmp_path):
    bundle = _bundle([_post(42, [_image(1, "0042_test-post_1.jpg", "assets/a.jpg")])])
    bundle.channels = [_channel()]

    path = write_json(bundle, tmp_path)
    data = json.loads(path.read_text())

    assert path.name == "export.json"
    assert data["generated_at"] == GENERATED_AT
    assert data["posts"][0]["post_id"] == 42
    assert data["posts"][0]["images"][0]["export_filename"] == "0042_test-post_1.jpg"
    assert data["channels"][0]["account_name"] == "Test IG"


def test_write_json_contains_no_token_field_anywhere(tmp_path):
    bundle = _bundle([_post(42, [])])
    bundle.channels = [_channel()]

    raw = write_json(bundle, tmp_path).read_text()

    assert "access_token" not in raw
    assert "token_expires_at" not in raw


def test_write_json_preserves_non_ascii_captions(tmp_path):
    post = _post(42, [])
    post.caption = "Café ☕ mobility"
    bundle = _bundle([post])

    data = json.loads(write_json(bundle, tmp_path).read_text())

    assert data["posts"][0]["caption"] == "Café ☕ mobility"


def test_write_json_includes_sends_and_records_schema_version(tmp_path):
    bundle = _bundle([])
    bundle.sends = [ExportedSend(
        publication_id=7, post_id=42, caption_preview="hello", channel_label="Test IG (instagram)",
        scheduled_at_utc="2026-07-24T18:00:00+00:00", scheduled_at_local="2026-07-24 18:00",
        published_at_utc=None, published_at_local=None, status="scheduled", is_held=False,
        is_dry_run=False, attempt_count=0, last_error=None, remote_post_id=None,
    )]

    data = json.loads(write_json(bundle, tmp_path).read_text())

    assert data["sends"][0]["publication_id"] == 7
    assert data["format_version"] == 1
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest worker/tests/test_export_write.py -v`
Expected: FAIL — `ImportError: cannot import name 'write_json'`

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `worker/export/write.py`:

```python
import json
from dataclasses import asdict
```

Append to `worker/export/write.py`:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest worker/tests/test_export_write.py -v`
Expected: PASS — 10 passed

- [ ] **Step 5: Commit**

```bash
git add worker/export/write.py worker/tests/test_export_write.py
git commit -m "feat(export): write full-fidelity export.json"
```

---

### Task 6: Write the five-tab workbook

**Files:**
- Modify: `worker/export/write.py`
- Modify: `worker/tests/test_export_write.py`

**Interfaces:**
- Consumes: `ExportBundle`, `CopyResult` from Tasks 3–4.
- Produces: `write_workbook(bundle: ExportBundle, out_dir: Path, missing_asset_ids: set[int]) -> Path`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_export_write.py`:

```python
from openpyxl import load_workbook

from worker.export.collect import ExportedAsset, ExportedMetric
from worker.export.write import write_workbook


def _rows(sheet):
    """Sheet contents as a list of dicts keyed by the header row."""
    values = list(sheet.values)
    header = values[0]
    return [dict(zip(header, row)) for row in values[1:]]


def test_write_workbook_creates_all_five_tabs(tmp_path):
    path = write_workbook(_bundle([]), tmp_path, missing_asset_ids=set())
    book = load_workbook(path)

    assert path.name == "SocialScheduler-Export.xlsx"
    assert book.sheetnames == ["Posts", "Sends", "Metrics", "Assets", "Channels"]


def test_write_workbook_writes_headers_even_for_an_empty_database(tmp_path):
    book = load_workbook(write_workbook(_bundle([]), tmp_path, missing_asset_ids=set()))

    assert next(book["Posts"].values)[0] == "post_id"
    assert book["Posts"].max_row == 1


def test_posts_tab_joins_multi_value_fields_with_commas(tmp_path):
    post = _post(42, [
        _image(1, "0042_test-post_1.jpg", "assets/a.jpg"),
        _image(2, "0042_test-post_2.jpg", "assets/b.jpg"),
    ])
    post.tags = ["mobility", "balance"]
    post.target_channels = ["Test IG"]
    post.times_posted = 3
    post.total_reach = 900

    book = load_workbook(write_workbook(_bundle([post]), tmp_path, missing_asset_ids=set()))
    row = _rows(book["Posts"])[0]

    assert row["tags"] == "mobility, balance"
    assert row["image_files"] == "0042_test-post_1.jpg, 0042_test-post_2.jpg"
    assert row["times_posted"] == 3
    assert row["total_reach"] == 900


def test_channels_tab_has_no_token_column(tmp_path):
    bundle = _bundle([])
    bundle.channels = [_channel()]

    book = load_workbook(write_workbook(bundle, tmp_path, missing_asset_ids=set()))
    header = next(book["Channels"].values)

    assert "access_token" not in header
    assert "token_expires_at" not in header
    assert "account_name" in header


def test_assets_tab_flags_files_that_were_missing_from_disk(tmp_path):
    bundle = _bundle([_post(42, [_image(1, "0042_test-post_1.jpg", "assets/gone.jpg")])])
    bundle.assets = [ExportedAsset(
        asset_id=1, content_hash="h", media_kind="image", original_filename="gone.jpg",
        storage_path="assets/gone.jpg", publish_path=None, conform_mode="none",
        needs_review=False, mime_type="image/jpeg", width=1080, height=1080, byte_size=None,
    )]

    book = load_workbook(write_workbook(bundle, tmp_path, missing_asset_ids={1}))
    row = _rows(book["Assets"])[0]

    assert row["exported_filename"] == "MISSING"
    assert row["used_by_posts"] == "42"


def test_assets_tab_lists_every_post_that_uses_a_shared_asset(tmp_path):
    bundle = _bundle([
        _post(42, [_image(1, "0042_test-post_1.jpg", "assets/s.jpg")]),
        _post(51, [_image(1, "0051_test-post_1.jpg", "assets/s.jpg")]),
    ])
    bundle.assets = [ExportedAsset(
        asset_id=1, content_hash="h", media_kind="image", original_filename="s.jpg",
        storage_path="assets/s.jpg", publish_path=None, conform_mode="none",
        needs_review=False, mime_type="image/jpeg", width=1080, height=1080, byte_size=10,
    )]

    row = _rows(load_workbook(
        write_workbook(bundle, tmp_path, missing_asset_ids=set())
    )["Assets"])[0]

    assert row["used_by_posts"] == "42, 51"
    assert row["exported_filename"] == "0042_test-post_1.jpg, 0051_test-post_1.jpg"


def test_metrics_tab_omits_raw_json_but_keeps_every_snapshot(tmp_path):
    bundle = _bundle([])
    bundle.metrics = [
        ExportedMetric(
            publication_id=7, post_id=42, fetched_at=f"2026-07-0{n}T00:00:00+00:00",
            reach=n * 100, impressions=None, likes=n, comments=None, saves=None,
            shares=None, video_views=None, raw_json='{"big":"payload"}',
        )
        for n in (1, 5)
    ]

    sheet = load_workbook(write_workbook(bundle, tmp_path, missing_asset_ids=set()))["Metrics"]

    assert "raw_json" not in next(sheet.values)
    assert len(_rows(sheet)) == 2
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest worker/tests/test_export_write.py -v`
Expected: FAIL — `ImportError: cannot import name 'write_workbook'`

- [ ] **Step 3: Write the implementation**

Add to the imports at the top of `worker/export/write.py`:

```python
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter
```

Append to `worker/export/write.py`:

```python
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
    "scheduled_at_utc", "published_at_local", "published_at_utc", "status", "is_held",
    "is_dry_run", "attempt_count", "last_error", "remote_post_id",
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
            s.scheduled_at_local, s.scheduled_at_utc, s.published_at_local,
            s.published_at_utc, s.status, s.is_held, s.is_dry_run, s.attempt_count,
            s.last_error, s.remote_post_id,
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
            # AS SHIPPED (review fix): one entry PER POST, using "-" where that post's
            # copy was not conformed, so this column stays index-aligned with
            # used_by_posts. Appending only real filenames silently paired a post with
            # another post's file. An asset conformed nowhere renders as an empty cell
            # rather than "-, -, -". See worker/export/write.py.
            published.setdefault(image.asset_id, []).append(
                image.published_filename or "-"
            )

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest worker/tests/test_export_write.py -v`
Expected: PASS — 17 passed

- [ ] **Step 5: Commit**

```bash
git add worker/export/write.py worker/tests/test_export_write.py
git commit -m "feat(export): write the five-tab xlsx workbook"
```

---

### Task 7: Write README.txt

**Files:**
- Modify: `worker/export/write.py`
- Modify: `worker/tests/test_export_write.py`

**Interfaces:**
- Consumes: `ExportBundle`, `CopyResult`.
- Produces: `write_readme(bundle: ExportBundle, out_dir: Path, copy_result: CopyResult) -> Path`

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_export_write.py`:

```python
from worker.export.write import CopyResult, write_readme


def test_readme_summarizes_the_contents(tmp_path):
    bundle = _bundle([_post(42, [])])
    bundle.channels = [_channel()]

    text = write_readme(bundle, tmp_path, CopyResult(copied=3)).read_text()

    assert "1 post" in text
    assert "3 image file" in text
    assert "SocialScheduler-Export.xlsx" in text


def test_readme_reports_missing_files_prominently(tmp_path):
    result = CopyResult(copied=1, missing_asset_ids={2, 3},
                        problems=["asset 2: file not found at /x/gone.jpg"])

    text = write_readme(_bundle([]), tmp_path, result).read_text()

    assert "2 image file(s) could not be found" in text
    assert "gone.jpg" in text


def test_readme_says_so_when_nothing_was_missing(tmp_path):
    text = write_readme(_bundle([]), tmp_path, CopyResult(copied=1)).read_text()

    assert "could not be found" not in text
    assert "No problems" in text


def test_readme_never_mentions_tokens(tmp_path):
    bundle = _bundle([])
    bundle.channels = [_channel()]

    text = write_readme(bundle, tmp_path, CopyResult()).read_text()

    assert "access_token" not in text
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest worker/tests/test_export_write.py -v`
Expected: FAIL — `ImportError: cannot import name 'write_readme'`

- [ ] **Step 3: Write the implementation**

Append to `worker/export/write.py`:

```python
def write_readme(bundle: ExportBundle, out_dir: Path, copy_result: CopyResult) -> Path:
    """Plain-English orientation, for someone opening this folder years from now
    with no idea what produced it."""
    out_dir.mkdir(parents=True, exist_ok=True)

    lines = [
        "SocialScheduler — Content Export",
        "=" * 40,
        "",
        f"Created: {bundle.generated_at}",
        "",
        "WHAT'S IN HERE",
        "",
        "  SocialScheduler-Export.xlsx   Open this one. Five tabs:",
        "                                Posts, Sends, Metrics, Assets, Channels.",
        "                                Start on 'Posts' — it has everything you",
        "                                normally want, including how often each",
        "                                post has gone out and how it performed.",
        "",
        "  export.json                   The same data in a form software can read",
        "                                back in. You don't need to open this.",
        "",
        f"  {IMAGES_DIR}/                        Your original uploaded images.",
        "",
        f"  {PUBLISHED_DIR}/              The cropped/padded versions that were",
        "                                actually sent to Instagram, where those",
        "                                differ from the original.",
        "",
        "Image filenames are 'postID_caption_position', so you can match any image",
        "back to its row in the Posts tab.",
        "",
        "WHAT IT CONTAINS",
        "",
        f"  {len(bundle.posts)} post(s)",
        f"  {len(bundle.sends)} scheduled or completed send(s)",
        f"  {len(bundle.metrics)} metric snapshot(s)",
        f"  {len(bundle.assets)} asset(s) on record",
        f"  {len(bundle.channels)} channel(s)",
        f"  {copy_result.copied} image file(s) copied",
        "",
        "A NOTE ON SECURITY",
        "",
        "  Access credentials are deliberately NOT included in this export. If you",
        "  ever restore from it, you'll reconnect the accounts fresh. That's normal",
        "  — it means this folder is safe to store in Google Drive or Dropbox.",
        "",
    ]

    if copy_result.missing_asset_ids:
        lines += [
            "PROBLEMS",
            "",
            f"  {len(copy_result.missing_asset_ids)} image file(s) could not be found on",
            "  disk. Their rows are marked MISSING in the Assets tab. Everything else",
            "  exported normally.",
            "",
        ]
        lines += [f"    - {p}" for p in copy_result.problems]
        lines.append("")
    else:
        lines += ["PROBLEMS", "", "  No problems. Everything exported.", ""]

    path = out_dir / "README.txt"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest worker/tests/test_export_write.py -v`
Expected: PASS — 21 passed

- [ ] **Step 5: Commit**

```bash
git add worker/export/write.py worker/tests/test_export_write.py
git commit -m "feat(export): write plain-English README.txt"
```

---

### Task 8: The entry point

**Files:**
- Create: `worker/export/__main__.py`
- Create: `worker/tests/test_export_main.py`

**Interfaces:**
- Consumes: everything from Tasks 3–7, plus `worker.config.Config`.
- Produces:
  - `open_readonly(database_path: Path) -> sqlite3.Connection`
  - `run_export(config, out_root: Path, now: datetime) -> tuple[Path, CopyResult]`
  - `main(argv: list[str] | None = None) -> int`

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_export_main.py`:

```python
"""End-to-end and safety tests for the export entry point."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone

import pytest
from openpyxl import load_workbook

from worker.export.__main__ import open_readonly, run_export

NOW = datetime(2026, 7, 24, 19, 30, tzinfo=timezone.utc)


def _seed_assets(config, conn):
    """Give every asset row a real file on disk, so copying succeeds."""
    config.asset_storage_dir.mkdir(parents=True, exist_ok=True)
    for row in conn.execute("SELECT id, storage_path FROM assets"):
        path = config.asset_storage_dir / row["storage_path"].split("/")[-1]
        path.write_bytes(f"bytes-{row['id']}".encode())
        conn.execute(
            "UPDATE assets SET storage_path = ? WHERE id = ?", (path.name, row["id"])
        )
    conn.commit()


def test_open_readonly_rejects_writes(db_path):
    conn = open_readonly(db_path)

    with pytest.raises(sqlite3.OperationalError):
        conn.execute("INSERT INTO tags (name) VALUES ('nope')")

    conn.close()


def test_export_leaves_the_database_byte_identical(config, conn, make_publication, tmp_path):
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    before = hashlib.sha256(config.database_path.read_bytes()).hexdigest()

    run_export(config, out_root=tmp_path / "out", now=NOW)

    assert hashlib.sha256(config.database_path.read_bytes()).hexdigest() == before


def test_export_writes_no_token_into_any_file(config, conn, make_publication, tmp_path):
    make_publication(with_token=True)
    _seed_assets(config, conn)
    conn.close()

    out_dir, _ = run_export(config, out_root=tmp_path / "out", now=NOW)

    for path in out_dir.rglob("*"):
        if path.is_file():
            blob = path.read_bytes()
            assert b"tok-123" not in blob, f"token leaked into {path.name}"
            assert b"access_token" not in blob, f"token column leaked into {path.name}"


def test_export_creates_the_expected_folder_layout(config, conn, make_publication, tmp_path):
    make_publication()
    _seed_assets(config, conn)
    conn.close()

    out_dir, result = run_export(config, out_root=tmp_path / "out", now=NOW)

    assert out_dir.name == "2026-07-24-1930"
    assert (out_dir / "README.txt").is_file()
    assert (out_dir / "SocialScheduler-Export.xlsx").is_file()
    assert (out_dir / "export.json").is_file()
    assert result.copied == 1
    assert (out_dir / "images").is_dir()


def test_export_never_overwrites_a_previous_run(config, conn, make_publication, tmp_path):
    make_publication()
    _seed_assets(config, conn)
    conn.close()
    out_root = tmp_path / "out"

    first, _ = run_export(config, out_root=out_root, now=NOW)
    (first / "sentinel.txt").write_text("do not clobber me")
    second, _ = run_export(config, out_root=out_root, now=NOW)

    assert second != first
    assert (first / "sentinel.txt").read_text() == "do not clobber me"


def test_export_of_an_empty_database_still_produces_a_valid_workbook(config, tmp_path):
    out_dir, result = run_export(config, out_root=tmp_path / "out", now=NOW)

    book = load_workbook(out_dir / "SocialScheduler-Export.xlsx")

    assert book.sheetnames == ["Posts", "Sends", "Metrics", "Assets", "Channels"]
    assert result.copied == 0
    assert json.loads((out_dir / "export.json").read_text())["posts"] == []


def test_export_completes_when_an_asset_file_is_missing(config, conn, make_publication, tmp_path):
    make_publication()  # asset rows exist, but no files were written to disk
    conn.close()

    out_dir, result = run_export(config, out_root=tmp_path / "out", now=NOW)

    assert result.missing_asset_ids
    assert "could not be found" in (out_dir / "README.txt").read_text()
    assert (out_dir / "SocialScheduler-Export.xlsx").is_file()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest worker/tests/test_export_main.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'worker.export.__main__'`

- [ ] **Step 3: Write the implementation**

Create `worker/export/__main__.py`:

```python
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

    print(f"Exported to: {out_dir}")
    print(f"  {copy_result.copied} image file(s) copied")
    if copy_result.missing_asset_ids:
        # Visible, never silent — but not a failure: a partial backup still helps.
        print(
            f"  {len(copy_result.missing_asset_ids)} image file(s) were missing from disk"
            " (see README.txt)"
        )
    print(str(out_dir))  # last line: the wrapper reads this to open Finder
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `.venv/bin/pytest worker/tests/test_export_main.py -v`
Expected: PASS — 7 passed

- [ ] **Step 5: Run the whole suite to confirm nothing regressed**

Run: `.venv/bin/pytest worker/tests -q`
Expected: PASS — all existing tests plus the 56 new ones (28 collect, 21 write, 7 main)

- [ ] **Step 6: Commit**

```bash
git add worker/export/__main__.py worker/tests/test_export_main.py
git commit -m "feat(export): read-only entry point, dated output folder, exit codes"
```

---

### Task 9: Double-click launcher, docs, and verification against the real database

**Files:**
- Create: `Export-Mac.command`
- Modify: `docs/tasks.md`
- Modify: `readme.md`

**Interfaces:**
- Consumes: `python -m worker.export` from Task 8.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the launcher**

Create `Export-Mac.command`:

```bash
#!/bin/bash
# ============================================================
#  SocialScheduler — Export (macOS)
#  Double-click to save a copy of all your posts, images, and
#  stats into a dated folder you can drag into Google Drive.
#  This only READS your data. Nothing is changed or posted.
# ============================================================

cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  SocialScheduler — Export"
echo "=========================================="
echo

pause_and_exit() {
  echo
  echo "$1"
  echo "Press any key to close this window..."
  read -r -n 1
  exit 1
}

# The export runs in the same Python environment as the worker.
if [ ! -d ".venv" ]; then
  pause_and_exit "The Python environment is missing. Double-click 'Update-Mac' first, then try again."
fi

echo "Gathering your posts, images, and stats..."
echo

# The module prints the output folder as its last line so we can reveal it in Finder.
# pipefail makes the pipeline report Python's failure rather than tail's success.
# (PIPESTATUS would NOT work here — command substitution runs in a subshell, so it
# would describe the assignment, not the pipeline inside it.)
set -o pipefail
OUTPUT="$(.venv/bin/python -m worker.export | tee /dev/tty | tail -n 1)"
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  pause_and_exit "The export didn't finish (see the message above). Your data is untouched."
fi

echo
if [ -d "$OUTPUT" ]; then
  open "$OUTPUT"
  echo "✅ Done. The folder is open in Finder — drag it into Google Drive to back it up."
else
  echo "✅ Done."
fi
echo "Press any key to close this window..."
read -r -n 1
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x Export-Mac.command
```

- [ ] **Step 3: Run it for real against the live database**

```bash
.venv/bin/python -m worker.export
```

Expected: prints `Exported to: /Users/<you>/Documents/SocialScheduler Exports/<stamp>`, an image count, and the folder path. Exit code 0.

- [ ] **Step 4: Verify the workbook against the database directly**

This is the verification the spec requires — compare counts rather than assert success. Substitute the real export path:

```bash
EXPORT_DIR="$HOME/Documents/SocialScheduler Exports/$(ls -1 "$HOME/Documents/SocialScheduler Exports" | tail -n 1)"
echo "--- database ---"
sqlite3 data/socialscheduler.db "SELECT 'posts', COUNT(*) FROM posts UNION ALL SELECT 'publications', COUNT(*) FROM publications UNION ALL SELECT 'post_metrics', COUNT(*) FROM post_metrics UNION ALL SELECT 'assets', COUNT(*) FROM assets UNION ALL SELECT 'channels', COUNT(*) FROM channels;"
echo "--- workbook ---"
.venv/bin/python -c "
from openpyxl import load_workbook
import sys
b = load_workbook(sys.argv[1] + '/SocialScheduler-Export.xlsx')
for name in b.sheetnames:
    print(name, b[name].max_row - 1)
" "$EXPORT_DIR"
```

Expected: `Posts` matches `posts`, `Sends` matches `publications`, `Metrics` matches `post_metrics`, `Assets` matches `assets`, `Channels` matches `channels`. Report the two lists side by side rather than claiming they match.

- [ ] **Step 5: Verify no token reached the export**

```bash
grep -ric "access_token" "$EXPORT_DIR" || echo "clean: no access_token anywhere"
```

Expected: `clean: no access_token anywhere`

- [ ] **Step 6: Confirm the database was untouched**

```bash
git status --porcelain data/ ; ls -l data/socialscheduler.db
```

Expected: no output from `git status` (the DB is gitignored), and the modification time unchanged from before the run.

- [ ] **Step 7: Update the docs**

In `readme.md`, add to whatever section lists the double-click scripts:

```markdown
- **Export-Mac.command** — saves every post, image, and stat into a dated folder
  in `~/Documents/SocialScheduler Exports/`, ready to drag into Google Drive.
  Read-only: it never changes or posts anything.
```

In `docs/tasks.md`, add a completed section following the file's existing format:

```markdown
## Export & Backup — shipped

- [x] `worker/export/` — read-only collect → write, `python -m worker.export`
- [x] Five-tab `.xlsx` (Posts, Sends, Metrics, Assets, Channels) + `export.json`
- [x] Originals and IG-conformed image copies, named `postID_caption_position`
- [x] `Export-Mac.command` double-click launcher
- [x] Secrets excluded by allow-list; verified by test and by grep over a real export
- [ ] Future: re-import from `export.json`; `--since` / `--channel` filters;
      `Export-Windows.bat`
```

- [ ] **Step 8: Commit**

```bash
git add Export-Mac.command readme.md docs/tasks.md
git commit -m "feat(export): double-click Export-Mac launcher + docs"
```

---

## Done when

- `.venv/bin/pytest worker/tests -q` passes in full.
- A real export folder exists, opened in Finder, containing all five files/folders.
- Workbook row counts have been compared against `sqlite3` counts and the comparison shown.
- `grep -ric access_token` over a real export returns nothing.
- The live database is unmodified after a run.
