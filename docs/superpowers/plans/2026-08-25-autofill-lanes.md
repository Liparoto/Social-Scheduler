# Auto-fill Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one channel group run a feed rotation and an Instagram Story rotation on independent auto-fill cadences, from one Library.

**Architecture:** Auto-fill config moves off `channels` / `channel_groups` into a new `autofill_lanes` table keyed by (owner, surface). The worker's unit of work becomes a *lane* — an owner plus a surface — so `run_autofill` tops up a group's feed lane and story lane separately, each with its own cadence, queue depth and candidate pool. The story lane recycles only posts explicitly targeted at `surface = 'story'` and fans one slot out into one publication per slide.

**Tech Stack:** SQLite (WAL, one file per install), Python 3 worker (`.venv`, pytest), Next.js 16 App Router + TypeScript dashboard (`better-sqlite3`, `node:test`).

**Spec:** `docs/design-autofill-lanes.md` — read it before Task 1. Every task below cites the section it implements.

## Global Constraints

- **Branch:** all work lands on `feat/autofill-lanes`. Do not commit to `main`.
- **Never run `migrate.py` against the live DB.** `--status` is read-only and safe; **every other argument, `--help` included, applies pending migrations** (`migrate.py:86` is a literal `"--status" in sys.argv` test, not an argument parser). To exercise a migration, copy the DB with `sqlite3 .backup` and point `DATABASE_PATH` at the copy.
- **One working tree, one live app.** The moment `migrations/0028_autofill_lanes.sql` exists on disk, the owner's running dashboard will 500 on post pages until the migration is applied. Apply it to the live DB (or stop the dashboard) immediately after Task 1 lands.
- **Never renumber a migration.** `schema_migrations` is keyed by filename; renumbering an applied file re-runs it and fails on a duplicate column. `0028` is the next free number — verify with `python3 migrate.py --status` before creating it.
- **Python must stay Windows-safe.** No Unix-only stdlib imports at module scope in `worker/`. There is no Python linter in this repo.
- **Dashboard lint is at 0 errors — keep it there.** Run `npm run lint` in `dashboard/` before each dashboard commit.
- **Test commands** (from the repo root):
  - Python: `.venv/bin/pytest worker/tests/<file> -v`
  - Dashboard: `cd dashboard && npm test`
- **Timestamps:** two writers spell UTC differently. Compare instants with `_INSTANT` (`strftime('%s', scheduled_at)`, `worker/autofill.py:58`), never raw text.
- **Surfaces in scope:** `'feed'` and `'story'` only. `'reel'` is legal in the schema and the code must be generic over it, but nothing exposes a reel lane.

---

## Phase A — Schema

### Task 1: Migration 0028 — `autofill_lanes` table and feed backfill

Implements spec §3.

**Files:**
- Create: `migrations/0028_autofill_lanes.sql`
- Create: `worker/tests/test_migration_0028.py`

**Interfaces:**
- Consumes: nothing.
- Produces: table `autofill_lanes(id, channel_id, group_id, surface, enabled, cadence_config, min_queue_depth, target_queue_depth, reuse_min_age_days)`, with unique indexes `idx_autofill_lanes_channel` and `idx_autofill_lanes_group`. Every task in Phase B reads it.

- [ ] **Step 1: Confirm 0028 is the next free number**

Run: `python3 migrate.py --status`

Expected: `0027_video_surface.sql` applied, nothing pending. If anything numbered 0028 already exists, STOP and ask — do not renumber.

- [ ] **Step 2: Write the failing test**

Create `worker/tests/test_migration_0028.py`:

```python
"""Migration 0028: auto-fill config moves from columns on channels/channel_groups to
one row per (owner, surface) in autofill_lanes.

See docs/design-autofill-lanes.md §3. These tests pin the three things that make the
move safe: the ownership constraint actually bites, cascade delete cleans up lanes,
and the backfill reproduces every existing unit's settings exactly as a feed lane.
"""

from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


@pytest.fixture
def pre_0028(tmp_path):
    """A DB migrated to 0027 only, so rows can be seeded BEFORE 0028's backfill runs.

    The shared `conn` fixture replays every migration including 0028, which leaves no
    window to insert the pre-existing rows the backfill is supposed to find. This
    fixture stops one migration short on purpose.
    """
    path = tmp_path / "pre.db"
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    for sql_file in sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name):
        if sql_file.name.startswith("0028"):
            break
        conn.executescript(sql_file.read_text())
    conn.commit()
    return conn


def apply_0028(conn):
    conn.executescript((MIGRATIONS_DIR / "0028_autofill_lanes.sql").read_text())
    conn.commit()


def test_table_and_columns_exist(conn):
    assert cols(conn, "autofill_lanes") == {
        "id", "channel_id", "group_id", "surface", "enabled",
        "cadence_config", "min_queue_depth", "target_queue_depth",
        "reuse_min_age_days",
    }


def test_a_lane_must_have_exactly_one_owner(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    gid = conn.execute(
        "INSERT INTO channel_groups (name) VALUES ('G')"
    ).lastrowid
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO autofill_lanes (channel_id, group_id, surface) VALUES (?,?,'feed')",
            (cid, gid),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO autofill_lanes (surface) VALUES ('feed')")


def test_one_lane_per_owner_per_surface(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    conn.execute(
        "INSERT INTO autofill_lanes (channel_id, surface) VALUES (?,'feed')", (cid,)
    )
    conn.execute(
        "INSERT INTO autofill_lanes (channel_id, surface) VALUES (?,'story')", (cid,)
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO autofill_lanes (channel_id, surface) VALUES (?,'feed')", (cid,)
        )


def test_deleting_the_owner_takes_its_lanes(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')"
    ).lastrowid
    conn.execute(
        "INSERT INTO autofill_lanes (channel_id, surface) VALUES (?,'story')", (cid,)
    )
    conn.commit()
    conn.execute("DELETE FROM channels WHERE id = ?", (cid,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM autofill_lanes").fetchone()[0] == 0


def test_backfill_reproduces_a_group_as_a_feed_lane(pre_0028):
    conn = pre_0028
    gid = conn.execute(
        """INSERT INTO channel_groups
             (name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days)
           VALUES ('Personal','America/New_York',1,'{"days":["mon"],"time":"18:00"}',3,7,90)"""
    ).lastrowid
    conn.commit()
    apply_0028(conn)

    lane = conn.execute(
        "SELECT * FROM autofill_lanes WHERE group_id = ?", (gid,)
    ).fetchone()
    assert lane["surface"] == "feed"
    assert lane["enabled"] == 1
    assert lane["cadence_config"] == '{"days":["mon"],"time":"18:00"}'
    assert lane["min_queue_depth"] == 3
    assert lane["target_queue_depth"] == 7
    assert lane["reuse_min_age_days"] == 90
    assert lane["channel_id"] is None


def test_backfill_covers_ungrouped_channels_and_skips_grouped_ones(pre_0028):
    conn = pre_0028
    gid = conn.execute("INSERT INTO channel_groups (name) VALUES ('G')").lastrowid
    solo = conn.execute(
        """INSERT INTO channels (platform, account_name, autofill_enabled, target_queue_depth)
           VALUES ('instagram','Solo',1,5)"""
    ).lastrowid
    member = conn.execute(
        """INSERT INTO channels (platform, account_name, group_id, autofill_enabled)
           VALUES ('instagram','Member',?,1)""",
        (gid,),
    ).lastrowid
    conn.commit()
    apply_0028(conn)

    assert conn.execute(
        "SELECT target_queue_depth FROM autofill_lanes WHERE channel_id = ?", (solo,)
    ).fetchone()[0] == 5
    assert conn.execute(
        "SELECT COUNT(*) FROM autofill_lanes WHERE channel_id = ?", (member,)
    ).fetchone()[0] == 0, "a grouped channel fills through its group, so it gets no lane"


def test_backfill_creates_no_story_lanes(pre_0028):
    conn = pre_0028
    conn.execute(
        "INSERT INTO channels (platform, account_name, autofill_enabled) VALUES ('instagram','IG',1)"
    )
    conn.commit()
    apply_0028(conn)
    assert conn.execute(
        "SELECT COUNT(*) FROM autofill_lanes WHERE surface != 'feed'"
    ).fetchone()[0] == 0, "a story lane is opt-in; the migration must not invent one"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `.venv/bin/pytest worker/tests/test_migration_0028.py -v`

Expected: every test FAILS — `sqlite3.OperationalError: no such table: autofill_lanes`, and the `pre_0028` tests fail on the missing migration file.

- [ ] **Step 4: Write the migration**

Create `migrations/0028_autofill_lanes.sql`:

```sql
-- 0028_autofill_lanes.sql
-- Auto-fill has had exactly ONE cadence per unit (a channel group, or an ungrouped
-- channel), and that cadence was hardwired to the feed: worker/autofill.py required a
-- post_targets row with surface='feed', and its publication insert took the 'feed'
-- default from 0014. The owner wants Stories on their own cadence, running ALONGSIDE
-- the feed cadence rather than instead of it.
--
-- The destination model was already right — post_targets.surface and
-- publications.surface both accept ('feed','story','reel') after 0027. What was wrong is
-- that auto-fill CONFIG was one-per-unit where it needs to be one-per-(unit, surface).
-- So the config moves out of columns and into rows. See docs/design-autofill-lanes.md.
--
-- TWO NULLABLE OWNER COLUMNS, not an owner_type/owner_id pair: SQLite cannot foreign-key
-- a polymorphic column, and a lane that outlives its deleted channel is a row the worker
-- keeps trying to fill forever. Two real foreign keys let ON DELETE CASCADE do the
-- cleanup. The cost is two partial unique indexes instead of one composite — cheaper
-- than an orphan.
--
-- Additive only: no table is rebuilt. The superseded columns on channels and
-- channel_groups (autofill_enabled, cadence_config, min_queue_depth,
-- target_queue_depth, reuse_min_age_days) are LEFT IN PLACE and go unread, exactly as
-- 0020 left bpp_every_n_slots. Rebuilding channels to delete five columns would be a
-- third full rebuild of a table with foreign-key children, for zero behaviour change.
--
-- This also retires 0013's mirroring rule (0013_channel_groups.sql:8-12), which required
-- every auto-fill setting to exist under identical names on BOTH tables. That rule was
-- already broken once — bpp_strong_pct/bpp_broad_pct exist only on channels (0022). One
-- lane table with one set of columns removes the obligation instead of adding a third
-- copy of it.
--
-- timezone is deliberately NOT on the lane: two surfaces on one account cannot be in
-- different timezones, and duplicating it only invites them to disagree. The bpp_* dials
-- stay on the owner too — BPP recycling is feed-only.

BEGIN;

CREATE TABLE autofill_lanes (
    id                 INTEGER PRIMARY KEY,
    channel_id         INTEGER REFERENCES channels(id)       ON DELETE CASCADE,
    group_id           INTEGER REFERENCES channel_groups(id) ON DELETE CASCADE,
    -- 'reel' is legal here so a Reel lane is later an INSERT rather than a migration.
    -- Nothing creates one yet.
    surface            TEXT    NOT NULL CHECK (surface IN ('feed', 'story', 'reel')),
    enabled            INTEGER NOT NULL DEFAULT 0,
    cadence_config     TEXT,
    -- Defaults match the live column defaults exactly (0025 for channels, 0013 for
    -- channel_groups) so a lane created by hand behaves like a unit created by hand.
    min_queue_depth    INTEGER NOT NULL DEFAULT 0,
    target_queue_depth INTEGER NOT NULL DEFAULT 0,
    reuse_min_age_days INTEGER NOT NULL DEFAULT 180,
    -- Exactly one owner: a group OR a channel, never both, never neither.
    CHECK ((channel_id IS NULL) <> (group_id IS NULL))
);

CREATE UNIQUE INDEX idx_autofill_lanes_channel
    ON autofill_lanes (channel_id, surface) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX idx_autofill_lanes_group
    ON autofill_lanes (group_id, surface)   WHERE group_id IS NOT NULL;

-- Backfill: every existing unit becomes a FEED lane holding its current settings, so the
-- install keeps filling on the same schedule with the same content the moment this lands.
INSERT INTO autofill_lanes
    (group_id, surface, enabled, cadence_config,
     min_queue_depth, target_queue_depth, reuse_min_age_days)
SELECT id, 'feed', autofill_enabled, cadence_config,
       min_queue_depth, target_queue_depth, reuse_min_age_days
  FROM channel_groups;

-- A channel that is IN a group gets no lane, matching _autofill_units, which never
-- returns a grouped channel as a solo unit. A channel that later leaves its group has
-- its feed lane created by the dashboard on first save; until then it is not auto-filled
-- — the same outcome as today, where a freshly ungrouped channel has autofill_enabled=0.
INSERT INTO autofill_lanes
    (channel_id, surface, enabled, cadence_config,
     min_queue_depth, target_queue_depth, reuse_min_age_days)
SELECT id, 'feed', autofill_enabled, cadence_config,
       min_queue_depth, target_queue_depth, reuse_min_age_days
  FROM channels WHERE group_id IS NULL;

COMMIT;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `.venv/bin/pytest worker/tests/test_migration_0028.py -v`

Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full Python suite — the backfill must not disturb anything**

Run: `.venv/bin/pytest worker/tests -q`

Expected: PASS. Nothing reads `autofill_lanes` yet, so any failure here means the migration broke existing schema.

- [ ] **Step 7: Commit**

```bash
git add migrations/0028_autofill_lanes.sql worker/tests/test_migration_0028.py
git commit -m "feat(autofill-lanes): add autofill_lanes table and backfill feed lanes

Auto-fill config moves from columns on channels/channel_groups to one row per
(owner, surface). Backfill gives every existing unit a feed lane holding its
current settings, so behaviour is unchanged until the worker reads lanes."
```

- [ ] **Step 8: Apply the migration to the live DB**

The owner runs one working tree. With this file on disk but unapplied, their dashboard 500s on post pages.

Run: `python3 migrate.py --status` (confirm `0028` shows as pending), then `python3 migrate.py`.

Expected: `0028_autofill_lanes.sql` applied. Then confirm the dashboard loads a post page.

---

## Phase B — Worker

### Task 2: `PlatformCaps.surfaces` — one source of truth for "can this platform take a Story?"

Implements spec §4.4.

**Files:**
- Modify: `worker/clients.py:100-190` (add the field, declare it per platform)
- Modify: `worker/publisher.py:308-323` (read it instead of a hardcoded platform name)
- Test: `worker/tests/test_clients.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `PlatformCaps.surfaces: frozenset[str]`, defaulting to `frozenset({"feed"})`. Instagram declares `frozenset({"feed", "story"})`. Task 5 filters group members with `"story" in PLATFORM_CAPS[platform].surfaces`.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_clients.py`:

```python
def test_every_platform_declares_at_least_the_feed_surface():
    from worker.clients import PLATFORM_CAPS

    for name, caps in PLATFORM_CAPS.items():
        assert "feed" in caps.surfaces, f"{name} must be able to publish to a feed"


def test_instagram_is_the_only_story_capable_platform():
    """Mirrors publisher._validate's story rule. When a second platform gains Stories,
    this test and PLATFORM_CAPS change together — and publisher.py does not have to."""
    from worker.clients import PLATFORM_CAPS

    story_capable = {n for n, c in PLATFORM_CAPS.items() if "story" in c.surfaces}
    assert story_capable == {"instagram"}


def test_video_surfaces_never_claims_a_surface_the_platform_lacks():
    """video_surfaces is about which video destinations exist; surfaces is about which
    destinations exist at all. A video-only surface would be unpublishable."""
    from worker.clients import PLATFORM_CAPS

    for name, caps in PLATFORM_CAPS.items():
        assert caps.video_surfaces <= caps.surfaces, f"{name} has a video-only surface"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest worker/tests/test_clients.py -k surface -v`

Expected: FAIL with `AttributeError: 'PlatformCaps' object has no attribute 'surfaces'`.

- [ ] **Step 3: Add the field**

In `worker/clients.py`, beside `video_surfaces` (currently line 105), add:

```python
    # Which destinations this platform's publish path accepts, for ANY media kind.
    # video_surfaces answers the narrower question "where can a VIDEO go" and is a
    # subset of this. Defaults to feed-only: a platform that has not thought about
    # Stories must not be offered one.
    surfaces: frozenset[str] = frozenset({"feed"})
```

Then give Instagram its story surface in `PLATFORM_CAPS` (the entry at `worker/clients.py:141-144`, which already has `video_surfaces=frozenset({"feed", "story"})`):

```python
        surfaces=frozenset({"feed", "story"}),
```

Leave every other platform to the default. Facebook's `video_surfaces={"feed","reel"}` means it also needs `surfaces=frozenset({"feed", "reel"})` to satisfy the subset test.

- [ ] **Step 4: Make the publisher read it**

In `worker/publisher.py`, replace the hardcoded check at line 312:

```python
        if platform != "instagram":
            raise _NonRetryable(f"{platform} has no Stories surface in this worker")
```

with:

```python
        if "story" not in caps.surfaces:
            raise _NonRetryable(f"{platform} has no Stories surface in this worker")
```

The error message is unchanged on purpose — it is the string the queue shows a failed send.

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/pytest worker/tests/test_clients.py worker/tests/test_stories_publisher.py -v`

Expected: PASS. `test_stories_publisher.py` is the regression guard that the publisher still refuses a Story on a non-Instagram channel.

- [ ] **Step 6: Commit**

```bash
git add worker/clients.py worker/publisher.py worker/tests/test_clients.py
git commit -m "refactor(platforms): express Story support as a capability, not a platform name

publisher._validate hardcoded 'platform != instagram'. Auto-fill's story lane needs
to ask the same question, so it becomes PlatformCaps.surfaces and both read it."
```

---

### Task 3: `AutofillLane` replaces `AutofillUnit`

Implements spec §4.1.

**Files:**
- Modify: `worker/autofill.py:438-468` (dataclass + loader)
- Modify: `worker/autofill.py:861-867` (`run_autofill`)
- Test: `worker/tests/test_autofill_lanes.py` (create)

**Interfaces:**
- Consumes: `autofill_lanes` (Task 1).
- Produces: `AutofillLane(label: str, surface: str, settings: dict, members: list, is_group: bool)` and `_autofill_lanes(conn) -> list[AutofillLane]`. `settings` is a plain `dict` (not a `sqlite3.Row`) carrying the lane's columns **plus** the owner's `timezone`, `bpp_every_days`, `bpp_strong_pct`, `bpp_broad_pct`. Tasks 4-7 consume `lane.surface` and `lane.settings`.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_autofill_lanes.py` with these helpers and the first test:

```python
"""Per-surface auto-fill lanes — docs/design-autofill-lanes.md.

A lane is an owner plus a surface. A group with a feed lane and a story lane is topped
up twice per cycle, independently: separate queue depths, separate candidate pools,
separate slot walks.
"""

from __future__ import annotations

import pytest

from worker.autofill import _autofill_lanes, run_autofill

CADENCE = '{"days":["mon","tue","wed","thu","fri","sat","sun"],"time":"18:00"}'


def make_channel(conn, *, platform="instagram", name="Chan", group_id=None,
                 tz="America/New_York", approval=0, active=1):
    return conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, group_id, requires_approval, is_active,
              remote_account_id, access_token)
           VALUES (?,?,?,?,?,?, 'acct1','tok')""",
        (platform, name, tz, group_id, approval, active),
    ).lastrowid


def make_group(conn, *, name="Personal", tz="America/New_York", active=1):
    return conn.execute(
        "INSERT INTO channel_groups (name, timezone, is_active) VALUES (?,?,?)",
        (name, tz, active),
    ).lastrowid


def make_lane(conn, *, channel_id=None, group_id=None, surface="feed", enabled=1,
              cadence=CADENCE, min_depth=3, target=5, reuse=180):
    return conn.execute(
        """INSERT INTO autofill_lanes
             (channel_id, group_id, surface, enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days)
           VALUES (?,?,?,?,?,?,?,?)""",
        (channel_id, group_id, surface, enabled, cadence, min_depth, target, reuse),
    ).lastrowid


def make_post(conn, *, targets=(), post_type="single", caption="x",
              content_kind="evergreen", media_kind="image",
              created_at="2026-01-01T00:00:00+00:00", slides=1):
    """`targets` is [(channel_id, surface), ...]. `slides` controls how many assets the
    post carries, which is what makes a story fan out."""
    pid = conn.execute(
        """INSERT INTO posts (caption, post_type, content_kind, content_status, created_at)
           VALUES (?,?,?,'ready',?)""",
        (caption, post_type, content_kind, created_at),
    ).lastrowid
    for i in range(slides):
        aid = conn.execute(
            """INSERT INTO assets (content_hash, media_kind, storage_path)
               VALUES (?,?,?)""",
            (f"hash-{pid}-{i}", media_kind, f"/tmp/a{pid}_{i}.jpg"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,?)",
            (pid, aid, i),
        )
    for channel_id, surface in targets:
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,?)",
            (pid, channel_id, surface),
        )
    conn.commit()
    return pid


def test_a_group_with_two_lanes_yields_two_lanes(conn):
    gid = make_group(conn)
    make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed")
    make_lane(conn, group_id=gid, surface="story")
    conn.commit()

    lanes = _autofill_lanes(conn)
    assert {lane.surface for lane in lanes} == {"feed", "story"}
    assert all(lane.is_group for lane in lanes)
    assert all(len(lane.members) == 1 for lane in lanes)


def test_a_disabled_lane_is_not_returned(conn):
    gid = make_group(conn)
    make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed", enabled=1)
    make_lane(conn, group_id=gid, surface="story", enabled=0)
    conn.commit()

    assert [lane.surface for lane in _autofill_lanes(conn)] == ["feed"]


def test_settings_carries_the_owners_timezone_and_bpp_dials(conn):
    """_fill_unit reads settings["timezone"], and _setting(settings, "bpp_every_days")
    swallows a missing column and returns 0 — which would silently mean "BPP off" with
    nothing logged. Both must come through on the merged settings."""
    gid = make_group(conn, tz="America/Los_Angeles")
    conn.execute("UPDATE channel_groups SET bpp_every_days = 14 WHERE id = ?", (gid,))
    make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed")
    conn.commit()

    lane = _autofill_lanes(conn)[0]
    assert lane.settings["timezone"] == "America/Los_Angeles"
    assert lane.settings["bpp_every_days"] == 14
    assert lane.settings["cadence_config"] == CADENCE


def test_a_grouped_channels_own_lane_is_ignored(conn):
    """A channel in a group fills through the group. If someone hand-inserts a lane on
    the member, it must not produce a second, competing unit of work."""
    gid = make_group(conn)
    cid = make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed")
    make_lane(conn, channel_id=cid, surface="feed")
    conn.commit()

    lanes = _autofill_lanes(conn)
    assert len(lanes) == 1
    assert lanes[0].is_group


def test_an_inactive_owner_produces_no_lanes(conn):
    gid = make_group(conn, active=0)
    make_channel(conn, group_id=gid)
    make_lane(conn, group_id=gid, surface="feed")
    conn.commit()

    assert _autofill_lanes(conn) == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -v`

Expected: FAIL with `ImportError: cannot import name '_autofill_lanes' from 'worker.autofill'`.

- [ ] **Step 3: Replace the dataclass and the loader**

In `worker/autofill.py`, replace `AutofillUnit` and `_autofill_units` (lines 438-468) with:

```python
@dataclass
class AutofillLane:
    """One thing auto-fill tops up: an owner (a channel_group with its active members, or
    an ungrouped channel standing alone) PLUS a surface.

    A group with a feed lane and a story lane is two lanes, topped up independently —
    separate queue-depth maths, separate candidate pools, separate slot walks. That
    independence is the whole feature: see docs/design-autofill-lanes.md.

    `settings` is the lane row merged with the owner's `timezone` and `bpp_*` dials, which
    stay stored on the owner. The merge is not cosmetic: `_setting` swallows a missing
    column and returns its default, so a `settings` that dropped `bpp_every_days` would
    not raise — the BPP step would read 0, conclude "off", and silently stop recycling
    with nothing logged.
    """

    label: str
    surface: str
    settings: dict
    members: list
    is_group: bool


# Owner columns that travel with every lane, because the file already reads them off
# `settings` and they describe the ACCOUNT rather than the schedule.
_OWNER_SETTINGS = ("timezone", "bpp_every_days", "bpp_strong_pct", "bpp_broad_pct")


def _lane_settings(lane_row, owner_row) -> dict:
    """The lane's own columns, plus the owner settings listed above.

    Tolerant of an owner that lacks a column: channel_groups never got bpp_strong_pct /
    bpp_broad_pct (0022 added them to channels only), and a clone may be mid-migration.
    A missing dial is simply absent, which `_setting` already handles.
    """
    out = {key: lane_row[key] for key in lane_row.keys()}
    for key in _OWNER_SETTINGS:
        try:
            out[key] = owner_row[key]
        except (IndexError, KeyError):
            pass
    return out


def _autofill_lanes(conn) -> list[AutofillLane]:
    """Every enabled lane whose owner is active. Groups first, then ungrouped channels.

    A channel with group_id set is NEVER also returned as a solo lane — it fills through
    its group — so it cannot be topped up twice in one cycle even if a stray lane row
    exists on it.
    """
    lanes: list[AutofillLane] = []
    for lane_row in conn.execute(
        """SELECT l.*, g.name AS owner_label
             FROM autofill_lanes l
             JOIN channel_groups g ON g.id = l.group_id
            WHERE l.enabled = 1 AND g.is_active = 1
            ORDER BY g.id, l.surface"""
    ).fetchall():
        group = conn.execute(
            "SELECT * FROM channel_groups WHERE id = ?", (lane_row["group_id"],)
        ).fetchone()
        members = conn.execute(
            "SELECT * FROM channels WHERE group_id = ? AND is_active = 1 ORDER BY id",
            (lane_row["group_id"],),
        ).fetchall()
        lanes.append(AutofillLane(
            lane_row["owner_label"], lane_row["surface"],
            _lane_settings(lane_row, group), list(members), True,
        ))
    for lane_row in conn.execute(
        """SELECT l.*, c.account_name AS owner_label
             FROM autofill_lanes l
             JOIN channels c ON c.id = l.channel_id
            WHERE l.enabled = 1 AND c.is_active = 1 AND c.group_id IS NULL
            ORDER BY c.id, l.surface"""
    ).fetchall():
        channel = conn.execute(
            "SELECT * FROM channels WHERE id = ?", (lane_row["channel_id"],)
        ).fetchone()
        lanes.append(AutofillLane(
            lane_row["owner_label"], lane_row["surface"],
            _lane_settings(lane_row, channel), [channel], False,
        ))
    return lanes
```

- [ ] **Step 4: Point `run_autofill` at lanes**

Replace `run_autofill` (`worker/autofill.py:861-867`):

```python
def run_autofill(conn, config: Config, now, logger=None) -> int:
    """Top up every enabled lane. Returns total publications created."""
    now_iso = now.isoformat()
    return sum(
        _fill_unit(conn, lane, config, now, now_iso, logger)
        for lane in _autofill_lanes(conn)
    )
```

Rename `_fill_unit`'s parameter from `unit` to `lane` and its type hint to `AutofillLane`. The body's `unit.label`, `unit.members`, `unit.is_group` references all become `lane.…`; leave the logic alone for now — Tasks 4-7 change it.

- [ ] **Step 5: Run the new tests**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -v`

Expected: PASS, 5 tests.

- [ ] **Step 6: Update the existing auto-fill suites to create lanes**

`worker/tests/test_autofill.py` and `worker/tests/test_autofill_groups.py` set `autofill_enabled` / `cadence_config` as columns, which the worker no longer reads. Their `make_channel` / `make_group` helpers must also insert a matching feed lane.

In `worker/tests/test_autofill.py`, at the end of `make_channel` (currently line 24-33), before returning the id:

```python
    conn.execute(
        """INSERT INTO autofill_lanes
             (channel_id, surface, enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days)
           VALUES (?, 'feed', ?, ?, ?, ?, 180)""",
        (channel_id, autofill, cadence, min_depth, target),
    )
```

Apply the equivalent to `make_group` in `worker/tests/test_autofill_groups.py` (using `group_id=` and that helper's `reuse` parameter), and to its `make_channel` for the ungrouped case.

- [ ] **Step 7: Run the whole worker suite**

Run: `.venv/bin/pytest worker/tests -q`

Expected: PASS. Every pre-existing auto-fill assertion still holds — which is the real proof the lane loader is a faithful replacement for the unit loader.

- [ ] **Step 8: Commit**

```bash
git add worker/autofill.py worker/tests/
git commit -m "feat(autofill-lanes): the unit of auto-fill becomes a lane (owner + surface)

_autofill_units becomes _autofill_lanes, reading autofill_lanes instead of columns
on channels/channel_groups. settings merges the lane row with the owner's timezone
and bpp_* dials so every existing read site is untouched."
```

---

### Task 4: Queue depth is counted per surface

Implements spec §4.2. **This is the task that keeps a full story queue from starving the feed.**

**Files:**
- Modify: `worker/autofill.py:86-157` (the four queue-depth helpers)
- Modify: `worker/autofill.py:750-760` (their call sites in `_fill_unit`)
- Test: `worker/tests/test_autofill_lanes.py`

**Interfaces:**
- Consumes: `AutofillLane.surface` (Task 3).
- Produces: `scheduled_ahead_count(conn, channel_id, now_iso, surface)`, `latest_future_scheduled(conn, channel_id, now_iso, surface)`, `group_scheduled_ahead_count(conn, member_ids, now_iso, surface)`, `group_latest_future_scheduled(conn, member_ids, now_iso, surface)` — `surface` is a required positional argument on all four, so no call site can forget it.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_autofill_lanes.py`:

```python
def queue(conn, post_id, channel_id, when, *, surface="feed", asset_id=None):
    conn.execute(
        """INSERT INTO publications
             (post_id, channel_id, scheduled_at, status, surface, asset_id)
           VALUES (?,?,?, 'scheduled', ?, ?)""",
        (post_id, channel_id, when, surface, asset_id),
    )
    conn.commit()


def test_a_full_story_queue_does_not_stall_the_feed_lane(conn):
    """The single most important assertion in this feature. scheduled_ahead_count was
    surface-blind, so story sends would satisfy the feed lane's min_queue_depth check
    and the feed would silently stop filling."""
    from worker.autofill import scheduled_ahead_count

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "story")])
    for day in range(10):
        queue(conn, pid, cid, f"2099-01-{day + 1:02d}T18:00:00+00:00", surface="story")

    assert scheduled_ahead_count(conn, cid, "2026-01-01T00:00:00+00:00", "story") == 10
    assert scheduled_ahead_count(conn, cid, "2026-01-01T00:00:00+00:00", "feed") == 0


def test_story_queue_depth_counts_slots_not_slides(conn):
    """One slot fans out into one publication per slide. Counting rows would read a
    four-slide Story as four posts of queue depth and stall the lane after two picks."""
    from worker.autofill import scheduled_ahead_count

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "story")], slides=4)
    for slide in range(4):
        queue(conn, pid, cid, "2099-01-01T18:00:00+00:00", surface="story",
              asset_id=slide + 1)

    assert scheduled_ahead_count(conn, cid, "2026-01-01T00:00:00+00:00", "story") == 1


def test_latest_future_scheduled_is_per_surface(conn):
    """The slot walk starts AFTER the last queued send. A story queued far into the
    future must not push the feed lane's next slot out with it."""
    from worker.autofill import latest_future_scheduled

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "feed"), (cid, "story")])
    queue(conn, pid, cid, "2099-12-31T18:00:00+00:00", surface="story")
    queue(conn, pid, cid, "2026-09-01T18:00:00+00:00", surface="feed")

    now = "2026-01-01T00:00:00+00:00"
    assert latest_future_scheduled(conn, cid, now, "feed").startswith("2026-09-01")
    assert latest_future_scheduled(conn, cid, now, "story").startswith("2099-12-31")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -k "stall or slides or per_surface" -v`

Expected: FAIL with `TypeError: scheduled_ahead_count() takes 3 positional arguments but 4 were given`.

- [ ] **Step 3: Add the surface filter to all four helpers**

In `worker/autofill.py`, replace `scheduled_ahead_count` (line 86) with:

```python
def scheduled_ahead_count(conn, channel_id: int, now_iso: str, surface: str) -> int:
    """How many future SLOTS this channel has queued ON THIS SURFACE — distinct INSTANTS,
    not a row count and not distinct text (see _INSTANT).

    Two things make the surface filter load-bearing. Without it a healthy Story queue
    satisfies the FEED lane's `ahead >= min_queue_depth` check and the feed silently
    stops filling. And counting distinct instants rather than rows is what makes a
    four-slide Story — one slot, four publications — read as one post of queue depth
    instead of four. For a feed lane the two counts are identical, because a solo feed
    slot produces exactly one publication; the change is a no-op there and a correctness
    fix here.
    """
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT COUNT(DISTINCT {_INSTANT}) FROM publications
        WHERE channel_id = ?
          AND surface = ?
          AND status IN ({sq})
          AND scheduled_at > ?
        """,
        (channel_id, surface, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0]
```

Then add `surface: str` as a fourth positional parameter to `latest_future_scheduled` (line 100), and as a fourth to `group_scheduled_ahead_count` (line 115) and `group_latest_future_scheduled` (line 140). Each gains `AND surface = ?` in its WHERE clause, with the parameter bound immediately after the channel id(s). `group_scheduled_ahead_count` already counts `DISTINCT {_INSTANT}` — leave that alone, it was right.

- [ ] **Step 4: Update the call sites**

In `_fill_unit` (`worker/autofill.py:750-760`), pass the lane's surface:

```python
    if lane.is_group:
        ahead = group_scheduled_ahead_count(conn, member_ids, now_iso, lane.surface)
        last_future = group_latest_future_scheduled(conn, member_ids, now_iso, lane.surface)
    else:
        ahead = scheduled_ahead_count(conn, member_ids[0], now_iso, lane.surface)
        last_future = latest_future_scheduled(conn, member_ids[0], now_iso, lane.surface)
```

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -v`

Expected: PASS, 8 tests.

- [ ] **Step 6: Run the whole worker suite**

Run: `.venv/bin/pytest worker/tests -q`

Expected: PASS. If `test_autofill.py` fails on a queue-depth assertion, check that its fixtures queue publications with an explicit `surface` — the default `'feed'` should make them pass untouched.

- [ ] **Step 7: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill_lanes.py
git commit -m "fix(autofill-lanes): count queue depth per surface, in slots not rows

Without the surface filter a full story queue satisfies the feed lane's
min_queue_depth check and the feed silently stops filling. Counting distinct
instants makes a multi-slide Story read as one slot, not N."
```

---

### Task 5: Candidate selection honours the lane's surface

Implements spec §4.2, §4.4 and §4.6.

**Files:**
- Modify: `worker/autofill.py:159-225` (`select_candidates`)
- Modify: `worker/autofill.py:242-273` (`_caption_too_long_for_channel` call site)
- Modify: `worker/autofill.py:302-343` (`eligible_candidates`)
- Modify: `worker/autofill.py:385-436` (`group_eligible_candidates`)
- Modify: `worker/autofill.py:768-775` (their call sites in `_fill_unit`)
- Test: `worker/tests/test_autofill_lanes.py`

**Interfaces:**
- Consumes: `AutofillLane.surface` (Task 3), `PlatformCaps.surfaces` (Task 2).
- Produces: `select_candidates(conn, channel_id, now, surface)`, `eligible_candidates(conn, channel, now, limit, *, surface, reuse_default=None, timezone_name=None, skip_cooldown=False)`, `group_eligible_candidates(conn, group, members, now, limit, *, surface, skip_cooldown=False)`. `surface` is keyword-only on the two `*_candidates` functions with no default, so an omission is a `TypeError` at the call site rather than a silent feed assumption.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_autofill_lanes.py`:

```python
def test_a_story_lane_picks_only_story_targeted_posts(conn):
    from worker.autofill import eligible_candidates

    cid = make_channel(conn)
    feed_only = make_post(conn, targets=[(cid, "feed")], caption="feed only")
    story_ok = make_post(conn, targets=[(cid, "story")], caption="story ok")
    channel = conn.execute("SELECT * FROM channels WHERE id = ?", (cid,)).fetchone()
    now = _now()

    story_ids = {r["post_id"] for r in
                 eligible_candidates(conn, channel, now, None, surface="story")}
    feed_ids = {r["post_id"] for r in
                eligible_candidates(conn, channel, now, None, surface="feed")}

    assert story_ids == {story_ok}
    assert feed_ids == {feed_only}


def test_a_long_caption_blocks_the_feed_lane_but_not_the_story_lane(conn):
    """A Story sends no caption at all (publisher.py suppresses it unconditionally), so
    gating a story candidate on caption length would silently empty the rotation over a
    limit that is never applied to it."""
    from worker.autofill import eligible_candidates

    cid = make_channel(conn, platform="threads")
    long_caption = "x" * 10_000
    pid = make_post(conn, targets=[(cid, "feed"), (cid, "story")], caption=long_caption)
    channel = conn.execute("SELECT * FROM channels WHERE id = ?", (cid,)).fetchone()
    now = _now()

    feed = {r["post_id"] for r in
            eligible_candidates(conn, channel, now, None, surface="feed")}
    assert pid not in feed, "over the platform's caption limit — would fail forever"

    story = {r["post_id"] for r in
             eligible_candidates(conn, channel, now, None, surface="story")}
    assert pid in story, "a story sends no caption, so the limit does not apply"


def test_a_story_lane_on_a_mixed_group_reaches_only_story_capable_members(conn):
    from worker.autofill import group_eligible_candidates

    gid = make_group(conn)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid)
    fb = make_channel(conn, platform="facebook", name="FB", group_id=gid)
    make_post(conn, targets=[(ig, "story"), (fb, "story")])
    group = conn.execute("SELECT * FROM channel_groups WHERE id = ?", (gid,)).fetchone()
    members = conn.execute(
        "SELECT * FROM channels WHERE group_id = ? ORDER BY id", (gid,)
    ).fetchall()

    out = group_eligible_candidates(conn, group, members, _now(), None, surface="story")
    assert out, "the Instagram member can take a Story"
    _row, recipients = out[0]
    assert [m["id"] for m in recipients] == [ig], "Facebook has no Stories surface"
    assert fb not in [m["id"] for m in recipients]
```

Add this helper near the top of the file, beside `CADENCE`:

```python
from datetime import datetime, timezone as _tz


def _now():
    """A fixed 'now' well after every fixture's created_at, so cooldown and season gates
    behave deterministically."""
    return datetime(2026, 6, 1, 12, 0, tzinfo=_tz.utc)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -k "story_targeted or long_caption or mixed_group" -v`

Expected: FAIL with `TypeError: eligible_candidates() got an unexpected keyword argument 'surface'`.

- [ ] **Step 3: Thread surface into `select_candidates`**

In `worker/autofill.py`, change the signature at line 159 to `def select_candidates(conn, channel_id: int, now, surface: str):`, replace the hardcoded predicate at lines 205-211 with:

```python
          -- Auto-fill queues only posts explicitly targeted at THIS lane's surface.
          -- Matching on channel_id alone would send a Story-only post to the feed
          -- silently. A story lane is the exact mirror: nothing lands on a Story
          -- because auto-fill inferred it could.
          AND EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = p.id AND pt.channel_id = :cid
                        AND pt.surface = :surface)
```

and add `"surface": surface` to the parameter dict at line 223.

Leave the already-queued exclusion (lines 212-216) surface-blind. That is deliberate: a post queued as a Story is also held out of the feed lane, which is the shared cooldown applied to pending work and stops the same photo appearing on the feed and in Stories the same day. Add that as a comment so a later reader does not "fix" it.

- [ ] **Step 4: Thread surface into the two candidate functions**

`eligible_candidates` (line 302) gains keyword-only `surface: str` with no default, passes it to `select_candidates`, and skips the caption gate for non-feed surfaces:

```python
        if surface == "feed" and _caption_too_long_for_channel(
            conn, channel, r["post_id"], r["post_type"]
        ):
            # Over this channel's limit: never queue it here to fail terminally later.
            # Other channels (e.g. Instagram, no caption limit) still get to select it.
            #
            # Feed only. A Story sends NO caption — worker/publisher.py suppresses it
            # unconditionally and _validate runs no caption check on the story branch —
            # so applying the limit here would silently exclude every long-caption post
            # from the Story rotation over a rule that will never be applied to it.
            continue
```

`group_eligible_candidates` (line 385) gains the same keyword-only `surface`, passes it to every `eligible_candidates` call (lines 417-420), and filters members to those whose platform declares the surface:

```python
    # A story lane on a mixed group fills only its story-capable members. An Instagram +
    # Facebook group creates Instagram sends and nothing for the Page.
    members = [
        m for m in members
        if surface in PLATFORM_CAPS[m["platform"]].surfaces
    ]
    if not members:
        return []
```

Place this at the top of the function body, before `capable_post_ids` is called.

- [ ] **Step 5: Update the call sites in `_fill_unit`**

At `worker/autofill.py:768-775`:

```python
    if lane.is_group:
        candidates = group_eligible_candidates(
            conn, settings, lane.members, now, None, surface=lane.surface
        )
    else:
        ch = lane.members[0]
        candidates = [
            (r, [ch]) for r in
            eligible_candidates(conn, ch, now, None, surface=lane.surface)
        ]
```

- [ ] **Step 6: Run the tests**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -v`

Expected: PASS, 11 tests.

- [ ] **Step 7: Run the whole worker suite**

Run: `.venv/bin/pytest worker/tests -q`

Expected: PASS. Existing suites call `eligible_candidates` directly in places; add `surface="feed"` at each such call. The `TypeError` from the missing keyword is intentional — it is how you find them all.

- [ ] **Step 8: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill_lanes.py
git commit -m "feat(autofill-lanes): select candidates for the lane's surface

select_candidates takes a surface instead of hardcoding 'feed'. Story lanes skip
the caption-length gate, because a Story sends no caption, and reach only members
whose platform declares the surface."
```

---

### Task 6: A story slot fans out into one publication per slide

Implements spec §4.3.

**Files:**
- Modify: `worker/autofill.py:829-846` (the publication insert)
- Test: `worker/tests/test_autofill_lanes.py`

**Interfaces:**
- Consumes: `AutofillLane.surface` (Task 3).
- Produces: `_slide_asset_ids(conn, post_id, surface) -> list[int | None]` — the Python counterpart to `dashboard/lib/story-fanout.ts`'s `expandTarget`. Returns `[None]` for a feed lane and one asset id per `post_assets` row for a story lane.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_autofill_lanes.py`:

```python
def test_a_feed_slot_makes_one_publication_covering_every_asset(conn):
    from worker.autofill import _slide_asset_ids

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "feed")], post_type="carousel", slides=3)
    assert _slide_asset_ids(conn, pid, "feed") == [None], \
        "a feed send means ALL assets in order, which is what asset_id NULL encodes"


def test_a_story_slot_makes_one_publication_per_slide_in_order(conn):
    from worker.autofill import _slide_asset_ids

    cid = make_channel(conn)
    pid = make_post(conn, targets=[(cid, "story")], post_type="carousel", slides=4)
    expected = [r["asset_id"] for r in conn.execute(
        "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order", (pid,)
    ).fetchall()]
    assert _slide_asset_ids(conn, pid, "story") == expected
    assert len(expected) == 4


def test_run_autofill_writes_story_sends_with_surface_and_asset_id(conn, config):
    """End to end: a story lane queues a four-slide post as four Stories at ONE instant,
    ordered by ascending id — the order worker/db.py's `ORDER BY scheduled_at, id`
    relies on to send them out in sequence."""
    cid = make_channel(conn)
    make_lane(conn, channel_id=cid, surface="story", min_depth=3, target=3)
    pid = make_post(conn, targets=[(cid, "story")], post_type="carousel", slides=4)
    conn.commit()

    made = run_autofill(conn, config, _now())
    assert made > 0

    rows = conn.execute(
        """SELECT id, surface, asset_id, scheduled_at FROM publications
            WHERE post_id = ? ORDER BY id""",
        (pid,),
    ).fetchall()
    assert len(rows) == 4, "four slides, four independent Stories"
    assert {r["surface"] for r in rows} == {"story"}
    assert [r["asset_id"] for r in rows] == [r["asset_id"] for r in conn.execute(
        "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order", (pid,)
    ).fetchall()]
    assert len({r["scheduled_at"] for r in rows}) == 1, "one slot, one instant"


def test_a_feed_lane_still_writes_exactly_one_row_with_a_null_asset(conn, config):
    """The regression guard: feed behaviour must be byte-identical to before lanes."""
    cid = make_channel(conn)
    make_lane(conn, channel_id=cid, surface="feed", min_depth=3, target=1)
    pid = make_post(conn, targets=[(cid, "feed")], post_type="carousel", slides=3)
    conn.commit()

    run_autofill(conn, config, _now())

    rows = conn.execute(
        "SELECT surface, asset_id FROM publications WHERE post_id = ?", (pid,)
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["surface"] == "feed"
    assert rows[0]["asset_id"] is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -k "slide or story_sends or null_asset" -v`

Expected: FAIL with `ImportError: cannot import name '_slide_asset_ids'`.

- [ ] **Step 3: Add the fan-out helper**

Add to `worker/autofill.py`, above `_fill_unit`:

```python
def _slide_asset_ids(conn, post_id: int, surface: str) -> list:
    """The asset_id values this post's publication rows should carry on `surface`.

    A FEED send is ONE row covering all of the post's assets, which `asset_id IS NULL`
    encodes (migration 0014). A STORY send is one row PER slide, because there is no such
    thing as a carousel Story in the API: a four-slide post becomes four consecutive
    Stories, each an independent publication that retries, fails and reports metrics on
    its own.

    This is the Python counterpart to dashboard/lib/story-fanout.ts's expandTarget, whose
    docstring has always claimed one existed here. It does now. The two runtimes share a
    database, not code (CLAUDE.md), so the rule is deliberately duplicated and tested on
    both sides — change one and you must change the other.
    """
    if surface != "story":
        return [None]
    return [
        r["asset_id"] for r in conn.execute(
            "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order ASC",
            (post_id,),
        ).fetchall()
    ]
```

- [ ] **Step 4: Use it in the insert**

Replace the insert loop at `worker/autofill.py:829-846`:

```python
        for (row, recipients), slot, _hhmm, is_bpp in placed:
            for member in recipients:
                # requires_approval stays a CHANNEL property — it describes the account,
                # not the schedule, so one member of a group may need approval and
                # another not.
                status = "pending_approval" if member["requires_approval"] else "scheduled"
                # One row for a feed send; one row PER SLIDE for a story send. They share
                # the slot's timestamp, so ascending publication id gives the publish
                # order worker/db.py's `ORDER BY scheduled_at, id` relies on.
                for asset_id in _slide_asset_ids(conn, row["post_id"], lane.surface):
                    conn.execute(
                        """INSERT INTO publications
                             (post_id, channel_id, scheduled_at, status, created_by,
                              is_recycled, surface, asset_id)
                           VALUES (?, ?, ?, ?, 'autofill', ?, ?, ?)""",
                        (row["post_id"], member["id"], slot.isoformat(), status,
                         1 if is_bpp else 0, lane.surface, asset_id),
                    )
                    made += 1
```

Note `made` now counts publication rows, not slots. The log line at `worker/autofill.py:849-855` says "added %d publication(s)", which stays accurate.

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -v`

Expected: PASS, 15 tests.

- [ ] **Step 6: Run the whole worker suite**

Run: `.venv/bin/pytest worker/tests -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill_lanes.py
git commit -m "feat(autofill-lanes): fan a story slot out into one publication per slide

The Python counterpart to story-fanout.ts's expandTarget, which has claimed one
existed here since 0014. Feed sends still write one row with a NULL asset_id."
```

---

### Task 7: BPP recycling stays feed-only

Implements spec §4.5.

**Files:**
- Modify: `worker/autofill.py:800-805` (the BPP step in `_fill_unit`)
- Test: `worker/tests/test_autofill_lanes.py`

**Interfaces:**
- Consumes: `AutofillLane.surface` (Task 3).
- Produces: nothing new. `_apply_bpp`, `_last_bpp_date` and `_unit_publication_count` keep their current signatures and are simply never reached from a non-feed lane.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_autofill_lanes.py`:

```python
def test_a_story_lane_never_queues_a_bpp_recycle(conn, config):
    """BPP dials live on the OWNER, so a story lane inherits them through settings. It
    must skip the BPP step anyway: recycling a best-performing post as a Story was never
    asked for, and _last_bpp_date is surface-blind, so a story recycle would also move
    the feed lane's next BPP due date."""
    cid = make_channel(conn)
    conn.execute("UPDATE channels SET bpp_every_days = 1 WHERE id = ?", (cid,))
    make_lane(conn, channel_id=cid, surface="story", min_depth=3, target=3)
    pid = make_post(conn, targets=[(cid, "story")])
    conn.execute("UPDATE posts SET is_bpp = 1 WHERE id = ?", (pid,))
    conn.commit()

    run_autofill(conn, config, _now())

    recycled = conn.execute(
        "SELECT COUNT(*) FROM publications WHERE is_recycled = 1"
    ).fetchone()[0]
    assert recycled == 0, "BPP is a feed-only concept"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py -k bpp -v`

Expected: FAIL — `assert 1 == 0` or similar, because the BPP step runs regardless of surface.

- [ ] **Step 3: Gate the BPP step**

At `worker/autofill.py:802`, change:

```python
    every_days = _setting(settings, "bpp_every_days")
    if every_days > 0 and placed:
```

to:

```python
    # Feed only. Recycling a best-performing post as a Story is not a thing the owner
    # asked for, and _last_bpp_date / _unit_publication_count are both surface-blind — a
    # story recycle would silently move the FEED lane's next BPP due date.
    every_days = _setting(settings, "bpp_every_days") if lane.surface == "feed" else 0
    if every_days > 0 and placed:
```

- [ ] **Step 4: Run the tests**

Run: `.venv/bin/pytest worker/tests/test_autofill_lanes.py worker/tests/test_bpp.py -v`

Expected: PASS.

- [ ] **Step 5: Run the whole worker suite and commit**

Run: `.venv/bin/pytest worker/tests -q`

```bash
git add worker/autofill.py worker/tests/test_autofill_lanes.py
git commit -m "feat(autofill-lanes): keep BPP recycling on the feed lane only"
```

- [ ] **Step 6: Restart the worker if it is running**

A live heartbeat proves the daemon is running, not that it is running current code. If the worker daemon is up, stop and restart it before any manual check.

---

## Phase C — Dashboard

### Task 8: `getBandCounts` takes a surface

Implements spec §5.2.

**Files:**
- Modify: `dashboard/lib/queries.ts:294-323`
- Modify: `dashboard/app/channels/page.tsx:51` and `:265` (call sites)
- Test: `dashboard/lib/queries.lanes.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `getBandCounts(channelIds: number[], surface: Surface): Record<string, number>` — `surface` is a required second argument, so no call site can silently keep the feed number.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/queries.lanes.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  return { q, db, prefix: `t${++setupSeq}` };
}

function seedPost(db: any, channelId: number, surface: string, band: string) {
  const postId = db
    .prepare("INSERT INTO posts (caption, post_type, content_status) VALUES ('x','single','ready')")
    .run().lastInsertRowid as number;
  db.prepare("INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,?)").run(
    postId,
    channelId,
    surface,
  );
  const tagId = (db.prepare("SELECT id FROM tags WHERE name = ? AND kind = 'time_of_day'").get(band) as { id: number }).id;
  db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES (?,?)").run(postId, tagId);
  return postId;
}

test("band counts are per surface, so a story lane is not warned about feed content", async () => {
  const { q, db } = await setup();
  const channelId = db
    .prepare("INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')")
    .run().lastInsertRowid as number;

  seedPost(db, channelId, "feed", "morning");
  seedPost(db, channelId, "feed", "morning");
  seedPost(db, channelId, "story", "evening");

  assert.deepEqual(q.getBandCounts([channelId], "feed"), { morning: 2 });
  assert.deepEqual(q.getBandCounts([channelId], "story"), { evening: 1 });
});

test("no channels means no counts, on any surface", async () => {
  const { q } = await setup();
  assert.deepEqual(q.getBandCounts([], "story"), {});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npm test 2>&1 | grep -A5 "band counts are per surface"`

Expected: FAIL — the story assertion returns `{}` because the query is hardcoded to `'feed'`.

- [ ] **Step 3: Add the parameter**

In `dashboard/lib/queries.ts:304`, change the signature to:

```typescript
export function getBandCounts(
  channelIds: number[],
  surface: Surface,
): Record<string, number> {
```

Change line 318 from `AND ptg.surface = 'feed'` to `AND ptg.surface = ?`, and bind it: `.all(...channelIds, surface)`.

Update the docstring's first line to "Ready posts targeted at `surface`, per time_of_day band, across a set of channels," and add:

```
 *  Surface matters: a warning that lies is worse than no warning. Counting feed posts
 *  for a story lane would flag bands the lane has no problem with, and this warning is
 *  the only safety net the strict band rule has.
```

Import `Surface` from `./types.ts` if it is not already imported.

- [ ] **Step 4: Update the call sites**

`dashboard/app/channels/page.tsx:265` → `bandCounts={getBandCounts([c.id], "feed")}`
`dashboard/app/channels/page.tsx:51` → `band_counts: getBandCounts(getGroupMembers(g.id).map((m) => m.id), "feed")`

Both stay `"feed"` for now; Task 11 makes them per-lane.

- [ ] **Step 5: Run the tests and the linter**

Run: `cd dashboard && npm test && npm run lint`

Expected: tests PASS, lint reports 0 errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/queries.ts dashboard/lib/queries.lanes.test.ts dashboard/app/channels/page.tsx
git commit -m "fix(autofill-lanes): getBandCounts takes a surface

Hardcoded to 'feed', it would warn a story lane about content that lane cannot use."
```

---

### Task 9: A group-level story-capability helper

Implements spec §5.3.

**Files:**
- Modify: `dashboard/lib/platforms.ts` (add beside `supportsStory` at :246)
- Test: `dashboard/lib/queries.lanes.test.ts`

**Interfaces:**
- Consumes: `supportsStory(value: string): boolean` (existing).
- Produces: `anySupportsStory(platforms: string[]): boolean`. Task 11 calls it with a group's member platforms to decide whether the Story side of the panel renders.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/lib/queries.lanes.test.ts`:

```typescript
test("a group offers a story lane when any member can take a Story", async () => {
  const { anySupportsStory } = await import("./platforms.ts");
  assert.equal(anySupportsStory(["facebook", "instagram"]), true);
  assert.equal(anySupportsStory(["facebook", "telegram"]), false);
  assert.equal(anySupportsStory([]), false, "an empty group offers nothing");
  assert.equal(anySupportsStory(["not-a-platform"]), false, "unknown means no");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npm test 2>&1 | grep -A5 "story lane when any member"`

Expected: FAIL — `anySupportsStory is not a function`.

- [ ] **Step 3: Add the helper**

In `dashboard/lib/platforms.ts`, directly below `supportsStory`:

```typescript
/** Does ANY of these platforms have a Stories surface?
 *
 *  A channel group fills as one unit, and a story lane on a mixed group reaches only its
 *  story-capable members — so the group offers a Story lane as soon as one member can
 *  take one. Unknown platforms are false, matching supportsStory's safe default.
 */
export function anySupportsStory(platforms: string[]): boolean {
  return platforms.some(supportsStory);
}
```

- [ ] **Step 4: Run the tests, lint, and commit**

Run: `cd dashboard && npm test && npm run lint`

```bash
git add dashboard/lib/platforms.ts dashboard/lib/queries.lanes.test.ts
git commit -m "feat(autofill-lanes): add anySupportsStory for group-level capability"
```

---

### Task 10: Lane persistence — `upsertAutofillLane` and the API routes

Implements spec §5.4.

**Files:**
- Modify: `dashboard/lib/queries.ts` (add the upsert and a reader)
- Modify: `dashboard/lib/types.ts` (add `AutofillLane`)
- Modify: `dashboard/app/api/channels/[id]/route.ts:56-71`
- Modify: `dashboard/app/api/channel-groups/[id]/route.ts:38-47`
- Test: `dashboard/lib/queries.lanes.test.ts`

**Interfaces:**
- Consumes: `autofill_lanes` (Task 1).
- Produces:
  - `type AutofillLane = { id: number; channel_id: number | null; group_id: number | null; surface: Surface; enabled: number; cadence_config: string | null; min_queue_depth: number; target_queue_depth: number; reuse_min_age_days: number }`
  - `getAutofillLanes(owner: { kind: "channel" | "group"; id: number }): AutofillLane[]`
  - `upsertAutofillLane(owner: { kind: "channel" | "group"; id: number }, surface: Surface, fields: Partial<Pick<AutofillLane, "enabled" | "cadence_config" | "min_queue_depth" | "target_queue_depth" | "reuse_min_age_days">>): void`

  Task 11 renders from `getAutofillLanes` and saves through the routes.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/lib/queries.lanes.test.ts`:

```typescript
test("upsert creates a lane, then updates it in place", async () => {
  const { q, db } = await setup();
  const channelId = db
    .prepare("INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')")
    .run().lastInsertRowid as number;
  const owner = { kind: "channel" as const, id: channelId };

  q.upsertAutofillLane(owner, "story", {
    enabled: 1,
    cadence_config: '{"days":["mon"],"time":"12:00"}',
    min_queue_depth: 2,
    target_queue_depth: 4,
    reuse_min_age_days: 30,
  });
  q.upsertAutofillLane(owner, "story", { target_queue_depth: 9 });

  const lanes = q.getAutofillLanes(owner);
  assert.equal(lanes.length, 1, "upsert must not create a second row for the same surface");
  assert.equal(lanes[0].surface, "story");
  assert.equal(lanes[0].target_queue_depth, 9);
  assert.equal(lanes[0].min_queue_depth, 2, "an omitted field is left alone");
  assert.equal(lanes[0].group_id, null);
});

test("feed and story lanes on one owner are independent rows", async () => {
  const { q, db } = await setup();
  const groupId = db
    .prepare("INSERT INTO channel_groups (name) VALUES ('G')")
    .run().lastInsertRowid as number;
  const owner = { kind: "group" as const, id: groupId };

  q.upsertAutofillLane(owner, "feed", { enabled: 1, target_queue_depth: 5 });
  q.upsertAutofillLane(owner, "story", { enabled: 1, target_queue_depth: 12 });

  const bySurface = Object.fromEntries(
    q.getAutofillLanes(owner).map((l) => [l.surface, l.target_queue_depth]),
  );
  assert.deepEqual(bySurface, { feed: 5, story: 12 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npm test 2>&1 | grep -A5 "upsert creates a lane"`

Expected: FAIL — `q.upsertAutofillLane is not a function`.

- [ ] **Step 3: Add the type**

In `dashboard/lib/types.ts`, below `ChannelGroup`:

```typescript
/** One auto-fill lane: an owner (a channel OR a group, never both) plus a surface.
 *  Replaces the auto-fill columns that used to live on Channel and ChannelGroup — those
 *  columns still exist but nothing reads them. See docs/design-autofill-lanes.md. */
export interface AutofillLane {
  id: number;
  channel_id: number | null;
  group_id: number | null;
  surface: Surface;
  enabled: number;
  cadence_config: string | null;
  min_queue_depth: number;
  target_queue_depth: number;
  reuse_min_age_days: number;
}
```

- [ ] **Step 4: Add the queries**

In `dashboard/lib/queries.ts`, beside the channel-group functions:

```typescript
type LaneOwner = { kind: "channel" | "group"; id: number };

function ownerColumn(owner: LaneOwner): "channel_id" | "group_id" {
  return owner.kind === "group" ? "group_id" : "channel_id";
}

/** Every lane belonging to one owner, feed first. */
export function getAutofillLanes(owner: LaneOwner): AutofillLane[] {
  return getDb()
    .prepare(
      `SELECT * FROM autofill_lanes WHERE ${ownerColumn(owner)} = ? ORDER BY surface`,
    )
    .all(owner.id) as AutofillLane[];
}

/** Create this owner's lane for `surface`, or update the fields given.
 *
 *  An omitted field is left at its current value, which is what lets the form save one
 *  lane without disturbing the other. Keyed on the partial unique index from migration
 *  0028, so a concurrent double-save cannot produce two rows for one surface.
 */
export function upsertAutofillLane(
  owner: LaneOwner,
  surface: Surface,
  fields: Partial<
    Pick<
      AutofillLane,
      "enabled" | "cadence_config" | "min_queue_depth" | "target_queue_depth" | "reuse_min_age_days"
    >
  >,
): void {
  const db = getDb();
  const column = ownerColumn(owner);
  db.prepare(
    `INSERT INTO autofill_lanes (${column}, surface) VALUES (?, ?)
       ON CONFLICT DO NOTHING`,
  ).run(owner.id, surface);

  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(
    `UPDATE autofill_lanes SET ${assignments}
      WHERE ${column} = @ownerId AND surface = @surface`,
  ).run({ ...fields, ownerId: owner.id, surface });
}
```

Import `AutofillLane` and `Surface` from `./types.ts`.

- [ ] **Step 5: Update both API routes**

In `dashboard/app/api/channels/[id]/route.ts`, replace the six auto-fill lines (56-61) with a lane write, leaving `bpp_*` and `color_hue` in the column writer:

```typescript
  // Auto-fill config now lives per (owner, surface) in autofill_lanes, not in columns.
  // The body names its surface; a request without one predates lanes and means feed.
  const surface: Surface = isSurface(body.surface) ? body.surface : "feed";
  const lane: Record<string, unknown> = {};
  if ("autofill_enabled" in body) lane.enabled = body.autofill_enabled ? 1 : 0;
  if ("cadence_config" in body) lane.cadence_config = body.cadence_config || null;
  if ("min_queue_depth" in body) lane.min_queue_depth = Number(body.min_queue_depth) || 0;
  if ("target_queue_depth" in body) lane.target_queue_depth = Number(body.target_queue_depth) || 0;
  if ("reuse_min_age_days" in body) lane.reuse_min_age_days = Number(body.reuse_min_age_days) || 0;
  if (Object.keys(lane).length > 0) {
    upsertAutofillLane({ kind: "channel", id: channelId }, surface, lane);
  }
```

Apply the same change to `dashboard/app/api/channel-groups/[id]/route.ts:38-42`, with `{ kind: "group", id: groupId }`. Import `upsertAutofillLane` from `@/lib/queries` and `isSurface` from `@/lib/story-fanout`.

`isSurface` is currently module-private — `dashboard/lib/story-fanout.ts:7` declares it as a plain `function`, not an `export function`. Add the `export` keyword. Do not write a second surface-validity check in the route: one predicate, one place, or the route and the fan-out can disagree about what a valid surface is.

- [ ] **Step 6: Run the tests, lint, and commit**

Run: `cd dashboard && npm test && npm run lint`

Expected: PASS, 0 lint errors.

```bash
git add dashboard/lib/queries.ts dashboard/lib/types.ts dashboard/lib/queries.lanes.test.ts dashboard/app/api/
git commit -m "feat(autofill-lanes): persist auto-fill settings per (owner, surface)

The six auto-fill fields split off the generic column writer into
upsertAutofillLane. bpp_*, color_hue and is_active stay owner-level."
```

---

### Task 11: The Feed · Story switch in `AutofillConfig`

Implements spec §5.1.

**Files:**
- Modify: `dashboard/components/autofill-config.tsx`
- Modify: `dashboard/app/channels/page.tsx:51,255-266`
- Modify: `dashboard/components/channel-groups.tsx:121-132`
- Test: `dashboard/test-ui/autofill-config-ui.test.ts`

**Interfaces:**
- Consumes: `getAutofillLanes` (Task 10), `anySupportsStory` (Task 9), `getBandCounts(ids, surface)` (Task 8).
- Produces: `AutofillConfig` takes `lanes: LanePanelData[]` in place of the flat auto-fill props, where `LanePanelData = { surface: Surface; enabled: boolean; cadenceConfig: string | null; minQueueDepth: number; targetQueueDepth: number; reuseMinAgeDays: number; bandCounts: Record<string, number> }`. `target`, `bppEveryDays`, `bppPoolSize` and `bandTimes` are unchanged — BPP stays owner-level and renders on the feed lane only.

- [ ] **Step 1: Write the failing test**

Append to `dashboard/test-ui/autofill-config-ui.test.ts`:

```typescript
import { laneFor, DEFAULT_LANE } from "../components/autofill-config.tsx";

test("a surface with no saved lane falls back to a disabled default, not to the feed's settings", () => {
  const lanes = [
    {
      surface: "feed" as const,
      enabled: true,
      cadenceConfig: '{"days":["mon"],"time":"18:00"}',
      minQueueDepth: 3,
      targetQueueDepth: 7,
      reuseMinAgeDays: 90,
      bandCounts: {},
    },
  ];
  const story = laneFor(lanes, "story");
  assert.equal(story.enabled, false, "an unconfigured lane must never start switched on");
  assert.equal(story.cadenceConfig, DEFAULT_LANE.cadenceConfig);
  assert.notEqual(story.targetQueueDepth, 7, "must not inherit the feed's depths");
});

test("laneFor returns the saved lane when there is one", () => {
  const lanes = [
    { surface: "story" as const, enabled: true, cadenceConfig: "{}", minQueueDepth: 1,
      targetQueueDepth: 4, reuseMinAgeDays: 30, bandCounts: { evening: 2 } },
  ];
  assert.equal(laneFor(lanes, "story").targetQueueDepth, 4);
  assert.deepEqual(laneFor(lanes, "story").bandCounts, { evening: 2 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && npm test 2>&1 | grep -A5 "no saved lane"`

Expected: FAIL — `laneFor` is not exported.

- [ ] **Step 3: Add the lane model to the component**

In `dashboard/components/autofill-config.tsx`, replace the flat auto-fill props with a `lanes` array and export the lookup:

```typescript
export interface LanePanelData {
  surface: Surface;
  enabled: boolean;
  cadenceConfig: string | null;
  minQueueDepth: number;
  targetQueueDepth: number;
  reuseMinAgeDays: number;
  /** Ready posts per time_of_day band FOR THIS SURFACE — see getBandCounts. */
  bandCounts: Record<string, number>;
}

/** What an unconfigured lane starts as: off, with the same defaults migration 0028 gives
 *  a hand-created row. Deliberately NOT a copy of the feed lane — a Story cadence that
 *  silently inherited the feed's times would post at the wrong hour the moment it was
 *  switched on. */
export const DEFAULT_LANE = {
  enabled: false,
  cadenceConfig: null as string | null,
  minQueueDepth: 0,
  targetQueueDepth: 0,
  reuseMinAgeDays: 180,
  bandCounts: {} as Record<string, number>,
};

export function laneFor(lanes: LanePanelData[], surface: Surface): LanePanelData {
  return lanes.find((l) => l.surface === surface) ?? { surface, ...DEFAULT_LANE };
}
```

`Props` becomes:

```typescript
interface Props {
  target: { kind: "channel" | "group"; id: number };
  /** One entry per configured lane. A surface with no entry renders as DEFAULT_LANE. */
  lanes: LanePanelData[];
  /** Which surfaces this owner can offer. Always includes "feed"; includes "story" only
   *  when a story-capable channel is in scope, so a lane that cannot fire is never
   *  configurable. */
  surfaces: Surface[];
  bppEveryDays: number;
  bppPoolSize: number;
  bandTimes: { morning: string; afternoon: string; evening: string };
}
```

Add `const [surface, setSurface] = useState<Surface>("feed");` and seed every existing piece of state from `laneFor(props.lanes, surface)`. Because the state is seeded once by `useState`, re-seed on switch with a keyed remount: render the lane body as a child component and give it `key={surface}`. That is simpler and less error-prone than syncing six `useState`s in an effect.

The band-coverage warning at lines 149-152 reads `laneFor(props.lanes, surface).bandCounts` instead of `props.bandCounts`.

The BPP block (lines 394-403 and 406-448) renders only when `surface === "feed"`.

The save handler (lines 130-137) adds `surface` to the PATCH body.

Render the switch above the cadence builder, showing only `props.surfaces`; hide it entirely when `props.surfaces.length === 1` so a Telegram-only channel's panel looks exactly as it does today.

- [ ] **Step 4: Update both call sites**

In `dashboard/app/channels/page.tsx`, for a solo channel:

```tsx
<AutofillConfig
  target={{ kind: "channel", id: c.id }}
  surfaces={supportsStory(c.platform) ? ["feed", "story"] : ["feed"]}
  lanes={getAutofillLanes({ kind: "channel", id: c.id }).map((l) => ({
    surface: l.surface,
    enabled: l.enabled === 1,
    cadenceConfig: l.cadence_config,
    minQueueDepth: l.min_queue_depth,
    targetQueueDepth: l.target_queue_depth,
    reuseMinAgeDays: l.reuse_min_age_days,
    bandCounts: getBandCounts([c.id], l.surface),
  }))}
  bppEveryDays={c.bpp_every_days ?? 0}
  bppPoolSize={getBppPool(c.id).usable}
  bandTimes={config.bandTimes}
/>
```

Do the equivalent at `dashboard/app/channels/page.tsx:51` for groups, using `getGroupMembers(g.id)` for both the member id list and `anySupportsStory(members.map((m) => m.platform))`, and pass the result through to `dashboard/components/channel-groups.tsx:121-132`.

- [ ] **Step 5: Run the tests and lint**

Run: `cd dashboard && npm test && npm run lint`

Expected: PASS, 0 lint errors.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/autofill-config.tsx dashboard/app/channels/page.tsx dashboard/components/channel-groups.tsx dashboard/test-ui/autofill-config-ui.test.ts
git commit -m "feat(autofill-lanes): add a Feed/Story switch to the auto-fill panel

One panel, one lane at a time. The Story side is hidden when no story-capable
channel is in scope, and BPP renders on the feed lane only."
```

---

### Task 12: End-to-end verification

Implements spec §7's manual section. `renderToStaticMarkup` cannot exercise a segmented control and the Python suite cannot prove the two runtimes agree, so this task is the one that actually establishes the feature works.

**Files:** none — this is verification.

**Interfaces:**
- Consumes: everything.
- Produces: a written record of what was observed, appended to `docs/tasks.md`.

- [ ] **Step 1: Confirm the whole suite is green**

Run: `.venv/bin/pytest worker/tests -q && cd dashboard && npm test && npm run lint`

Expected: all PASS, 0 lint errors. Do not proceed on a failure.

- [ ] **Step 2: Point the dashboard at a scratch copy of the live DB**

```bash
sqlite3 data/socialscheduler.db ".backup /tmp/lanes-check.db"
```

Never `cp` a live WAL file — the copy will be torn. Then start the dashboard on port 3940 with `DATABASE_PATH=/tmp/lanes-check.db`, since `process.env` outranks `.env`.

- [ ] **Step 3: Configure a story lane in the browser**

In Safari at `localhost:3940/channels`, on the channel group: switch the auto-fill panel to **Story**, enable it, set a daily cadence at a different time from the feed lane, save. Hard reload with Cmd+Option+R — Turbopack reuses one CSS URL and Safari will otherwise serve stale styles.

Confirm: the Feed side still shows its original cadence untouched, and the Story side persists across the reload.

- [ ] **Step 4: Dry-run the worker against the scratch DB**

```bash
DRY_RUN=1 DATABASE_PATH=/tmp/lanes-check.db .venv/bin/python -m worker.run
```

A launch-time env var outranks `.env`, so this cannot post for real. Watch the log for one `[autofill …]` line per lane.

- [ ] **Step 5: Check what landed in the queue**

Confirm, in the dashboard queue view and in SQL:

```bash
sqlite3 /tmp/lanes-check.db \
  "SELECT surface, COUNT(*) rows, COUNT(DISTINCT scheduled_at) slots
     FROM publications WHERE created_by='autofill' AND scheduled_at > datetime('now')
    GROUP BY surface"
```

Expected: both surfaces present; feed `rows == slots`; story `rows >= slots` if any multi-slide post was picked. Every story row must have a non-null `asset_id`, and every feed row a null one.

- [ ] **Step 6: Confirm the feed lane kept filling**

This is the regression the whole design turns on. With the story queue full, the feed lane must still top up to its target. Compare the feed slot count against the feed lane's `target_queue_depth`.

- [ ] **Step 7: Record the result and clean up**

Append what was observed to the open-work table at the top of `docs/tasks.md` — that table is the source of truth; the checkboxes below it lag reality. Then `rm /tmp/lanes-check.db*`.

- [ ] **Step 8: Report before merging**

Do NOT merge to `main` on your own. Report to the owner: what passed, what was observed in the dry run, and anything skipped. Merging unverified UI to look finished is explicitly not wanted.
