# Tag Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-kind tag taxonomy (`time_of_day`, `topic`) where `time_of_day` tags steer *when* the worker auto-posts a piece of content.

**Architecture:** The existing flat `tags`/`post_tags` tables gain a `kind` column (migration 0003). The Python worker's auto-fill keeps using each channel's weekly cadence for *which days* to post, but derives each post's *clock time* from its `time_of_day` tag (morning/afternoon/evening = fixed config times; anytime/untagged = the channel's own cadence time). The Next.js dashboard gains tag controls in the composer and tag/platform filters in the Library. Worker and dashboard share the SQLite file — no API between them.

**Tech Stack:** Python 3.11 (stdlib + pytest) for the worker; Next.js 16 App Router + TypeScript + better-sqlite3 for the dashboard; plain `.sql` migrations applied by `migrate.py`.

## Global Constraints

- **Schema source of truth is `/migrations/*.sql`.** Never define schema inline in TS/Python. Migrations are **additive only** — never edit an applied migration. New file this plan: `migrations/0003_tag_taxonomy.sql`.
- **`content_status` (draft/ready/retired) is SEPARATE from `posts.status`.** Do not conflate. (Unchanged here, but tag code sits near it.)
- **`time_of_day` values are the fixed set `morning`/`afternoon`/`evening`/`anytime`.** `kind` ∈ `topic`/`time_of_day`. Enforced at the application layer (TS routes + Python worker).
- **Band default times are channel-local and env-overridable:** morning `09:00`, afternoon `13:00`, evening `18:00`. `anytime`/untagged → the channel's own `cadence_config.time`.
- **All Next.js route handlers set `export const runtime = "nodejs"`.**
- **Python worker runs in the repo venv, never system Python.** No new Python deps (stdlib only). No new JS deps.
- **Worker and dashboard communicate only through the shared SQLite DB.** WAL mode, `PRAGMA foreign_keys = ON` per connection.
- **Platform is NOT a tag** — platform eligibility is derived from a post's targets' channel platforms.
- Spec: `docs/design-tag-taxonomy.md`.

---

## Part ②-A — Engine (migration + worker)

### Task 1: Migration 0003 — `kind` column + seed bands

**Files:**
- Create: `migrations/0003_tag_taxonomy.sql`
- Test: `worker/tests/test_migration_0003.py`

**Interfaces:**
- Produces: `tags.kind TEXT NOT NULL DEFAULT 'topic'`; four seeded `time_of_day` tags (`morning`, `afternoon`, `evening`, `anytime`); index `idx_post_tags_tag`.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_migration_0003.py`:

```python
"""0003 adds the tag kind column additively and seeds the four time_of_day bands."""
from __future__ import annotations

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG = REPO_ROOT / "migrations"


def _apply(conn, name):
    conn.executescript((MIG / name).read_text())
    conn.commit()


def _fresh(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "m.db"))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    for name in ("0001_init.sql", "0002_content_model.sql"):
        _apply(conn, name)
    return conn


def test_0003_adds_kind_and_seeds_bands(tmp_path):
    conn = _fresh(tmp_path)
    # A pre-existing (topic-style) tag from before the migration.
    conn.execute("INSERT INTO tags (name) VALUES ('travel')")
    conn.commit()

    _apply(conn, "0003_tag_taxonomy.sql")

    # Existing rows default to topic.
    row = conn.execute("SELECT kind FROM tags WHERE name='travel'").fetchone()
    assert row["kind"] == "topic"

    # The four bands exist with kind time_of_day.
    bands = conn.execute(
        "SELECT name FROM tags WHERE kind='time_of_day' ORDER BY name"
    ).fetchall()
    assert [r["name"] for r in bands] == ["afternoon", "anytime", "evening", "morning"]


def test_0003_is_idempotent_on_reseed(tmp_path):
    conn = _fresh(tmp_path)
    _apply(conn, "0003_tag_taxonomy.sql")
    # Re-running the seed insert must not duplicate (INSERT OR IGNORE on unique name).
    conn.executescript(
        "INSERT OR IGNORE INTO tags (name, kind) VALUES ('morning','time_of_day');"
    )
    conn.commit()
    n = conn.execute("SELECT COUNT(*) AS c FROM tags WHERE name='morning'").fetchone()["c"]
    assert n == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && python -m pytest worker/tests/test_migration_0003.py -v`
Expected: FAIL — `sqlite3.OperationalError: no such file` / migration not found (0003 doesn't exist yet).

- [ ] **Step 3: Write the migration**

Create `migrations/0003_tag_taxonomy.sql`:

```sql
-- 0003_tag_taxonomy.sql
-- Adds a taxonomy dimension to the existing flat `tags` table and seeds the fixed
-- time-of-day bands. Additive and safe on installs that already have (unused) tags:
-- new column defaults to 'topic', so any pre-existing tag stays a topic.

ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'topic';

-- The fixed time-of-day band vocabulary. INSERT OR IGNORE keeps this idempotent
-- against the existing UNIQUE(name COLLATE NOCASE) constraint.
INSERT OR IGNORE INTO tags (name, kind) VALUES
  ('morning',   'time_of_day'),
  ('afternoon', 'time_of_day'),
  ('evening',   'time_of_day'),
  ('anytime',   'time_of_day');

-- Reverse lookups ("posts carrying tag X", "tags on post Y") stay cheap.
CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest worker/tests/test_migration_0003.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Confirm the full suite still builds the schema**

Run: `python -m pytest worker/tests/ -q`
Expected: all pass (conftest applies 0003 automatically via its glob over `migrations/*.sql`).

- [ ] **Step 6: Commit**

```bash
git add migrations/0003_tag_taxonomy.sql worker/tests/test_migration_0003.py
git commit -m "feat(schema): 0003 tag taxonomy — kind column + seeded time_of_day bands"
```

---

### Task 2: Band-time config + `time_of_day` resolution helper

**Files:**
- Modify: `worker/config.py` (add three band-time fields + env reads)
- Create: `worker/time_of_day.py`
- Test: `worker/tests/test_time_of_day.py`

**Interfaces:**
- Consumes: `Config` (Task uses `config.tod_morning`/`tod_afternoon`/`tod_evening`).
- Produces:
  - `worker.time_of_day.BAND_ORDER = ("morning", "afternoon", "evening")`
  - `worker.time_of_day.VALID_BANDS = ("morning", "afternoon", "evening", "anytime")`
  - `parse_hhmm(value: str) -> tuple[int, int]`
  - `band_times(config) -> dict[str, tuple[int, int]]` (keys: the three specific bands)
  - `post_bands(conn, post_id: int) -> set[str]` (the post's time_of_day tag names)
  - `resolve_slot_time(bands: set[str], band_times_map: dict[str, tuple[int,int]], cadence_hm: tuple[int,int]) -> tuple[int, int]`

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_time_of_day.py`:

```python
"""Band-time config parsing, per-post band lookup, and slot-time resolution."""
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from worker.time_of_day import (
    BAND_ORDER,
    band_times,
    parse_hhmm,
    post_bands,
    resolve_slot_time,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG = REPO_ROOT / "migrations"


class _Cfg:
    tod_morning = "09:00"
    tod_afternoon = "13:00"
    tod_evening = "18:00"


def test_parse_hhmm_ok_and_bad():
    assert parse_hhmm("09:00") == (9, 0)
    assert parse_hhmm("18:30") == (18, 30)
    with pytest.raises(ValueError):
        parse_hhmm("25:00")


def test_band_times_maps_three_specific_bands():
    bt = band_times(_Cfg())
    assert bt == {"morning": (9, 0), "afternoon": (13, 0), "evening": (18, 0)}


def test_resolve_earliest_specific_band_wins():
    bt = band_times(_Cfg())
    assert resolve_slot_time({"evening", "morning"}, bt, (17, 0)) == (9, 0)
    assert resolve_slot_time({"evening"}, bt, (17, 0)) == (18, 0)


def test_resolve_anytime_and_untagged_use_cadence_time():
    bt = band_times(_Cfg())
    assert resolve_slot_time({"anytime"}, bt, (17, 0)) == (17, 0)
    assert resolve_slot_time(set(), bt, (17, 0)) == (17, 0)
    # anytime alongside a specific band -> the specific band still wins.
    assert resolve_slot_time({"anytime", "afternoon"}, bt, (17, 0)) == (13, 0)


def _db(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "d.db"))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    for name in ("0001_init.sql", "0002_content_model.sql", "0003_tag_taxonomy.sql"):
        conn.executescript((MIG / name).read_text())
    conn.commit()
    return conn


def test_post_bands_returns_only_time_of_day_tags(tmp_path):
    conn = _db(tmp_path)
    conn.execute("INSERT INTO posts (caption, post_type) VALUES ('x','single')")
    conn.execute("INSERT INTO tags (name, kind) VALUES ('travel','topic')")
    # Attach 'travel' (topic) + 'morning' (time_of_day) to post 1.
    conn.execute(
        "INSERT INTO post_tags (post_id, tag_id) "
        "SELECT 1, id FROM tags WHERE name IN ('travel','morning')"
    )
    conn.commit()
    assert post_bands(conn, 1) == {"morning"}


def test_band_order_is_earliest_first():
    assert BAND_ORDER == ("morning", "afternoon", "evening")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest worker/tests/test_time_of_day.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'worker.time_of_day'`.

- [ ] **Step 3: Add band-time config fields to `worker/config.py`**

In the `@dataclass Config` body, after the tunnel fields (around line 89), add:

```python
    # Time-of-day band clock times (channel-local, "HH:MM"). See docs/design-tag-taxonomy.md.
    # anytime/untagged posts use the channel's own cadence time instead of these.
    tod_morning: str = "09:00"
    tod_afternoon: str = "13:00"
    tod_evening: str = "18:00"
```

In `Config.from_env`, inside the `return cls(...)` call (after `tunnel_ready_timeout=...`), add:

```python
            tod_morning=os.environ.get("TOD_MORNING", "09:00"),
            tod_afternoon=os.environ.get("TOD_AFTERNOON", "13:00"),
            tod_evening=os.environ.get("TOD_EVENING", "18:00"),
```

- [ ] **Step 4: Write `worker/time_of_day.py`**

```python
"""Time-of-day bands: resolve a post's time_of_day tag(s) into a clock time.

A post's slot TIME comes from its time_of_day tag; its slot DAY comes from the
channel cadence (see autofill). morning/afternoon/evening map to configured clock
times; `anytime` (and no time_of_day tag at all) fall back to the channel's own
cadence time. When several specific bands are present, the earliest wins.
"""

from __future__ import annotations

# Earliest -> latest. Only the specific bands; `anytime` is intentionally absent
# because it means "no specific time" and defers to the channel cadence time.
BAND_ORDER = ("morning", "afternoon", "evening")
VALID_BANDS = ("morning", "afternoon", "evening", "anytime")


def parse_hhmm(value: str) -> tuple[int, int]:
    """Parse 'HH:MM' -> (hour, minute); raise ValueError if out of range."""
    hh, mm = (int(x) for x in value.split(":"))
    if not (0 <= hh < 24 and 0 <= mm < 60):
        raise ValueError(f"bad time {value!r}")
    return hh, mm


def band_times(config) -> dict[str, tuple[int, int]]:
    """The three specific bands mapped to (hour, minute) from config."""
    return {
        "morning": parse_hhmm(config.tod_morning),
        "afternoon": parse_hhmm(config.tod_afternoon),
        "evening": parse_hhmm(config.tod_evening),
    }


def post_bands(conn, post_id: int) -> set[str]:
    """The set of time_of_day tag names attached to a post (may be empty)."""
    rows = conn.execute(
        """SELECT t.name AS name
             FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = ? AND t.kind = 'time_of_day'""",
        (post_id,),
    ).fetchall()
    return {r["name"] for r in rows}


def resolve_slot_time(
    bands: set[str],
    band_times_map: dict[str, tuple[int, int]],
    cadence_hm: tuple[int, int],
) -> tuple[int, int]:
    """Earliest specific band wins; anytime/none -> the channel cadence time."""
    for b in BAND_ORDER:
        if b in bands:
            return band_times_map[b]
    return cadence_hm
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest worker/tests/test_time_of_day.py -v`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add worker/config.py worker/time_of_day.py worker/tests/test_time_of_day.py
git commit -m "feat(worker): time_of_day band config + slot-time resolution helper"
```

---

### Task 3: `weekly_date_slots` — per-candidate slot times, one post per day

**Files:**
- Modify: `worker/scheduling.py` (add `weekly_date_slots`; leave `weekly_slots` intact)
- Test: `worker/tests/test_scheduling.py` (append cases)

**Interfaces:**
- Produces: `weekly_date_slots(weekdays: set[int], tz_name: str, after: datetime, band_times: list[tuple[int,int]]) -> list[datetime]` — one UTC slot per entry in `band_times`, each on the next matching cadence day (one post per active day), strictly increasing and strictly after `after`.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_scheduling.py`:

```python
from datetime import datetime, timezone

from worker.scheduling import weekly_date_slots
from zoneinfo import ZoneInfo


def _local_hm(dt, tz_name):
    local = dt.astimezone(ZoneInfo(tz_name))
    return (local.hour, local.minute)


def test_weekly_date_slots_uses_per_candidate_times():
    # Mon/Wed/Fri channel in New York; after = Sun 2026-07-19 12:00 UTC.
    after = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)
    weekdays = {0, 2, 4}  # mon, wed, fri
    # Three candidates: evening (18:00), morning (09:00), anytime->cadence (17:00).
    bands = [(18, 0), (9, 0), (17, 0)]
    slots = weekly_date_slots(weekdays, "America/New_York", after, bands)

    assert len(slots) == 3
    # Strictly increasing, one per successive matching day.
    assert slots[0] < slots[1] < slots[2]
    # Each carries its own local clock time.
    assert _local_hm(slots[0], "America/New_York") == (18, 0)  # Mon evening
    assert _local_hm(slots[1], "America/New_York") == (9, 0)   # Wed morning
    assert _local_hm(slots[2], "America/New_York") == (17, 0)  # Fri anytime
    # Distinct calendar days in local tz.
    days = {s.astimezone(ZoneInfo("America/New_York")).date() for s in slots}
    assert len(days) == 3


def test_weekly_date_slots_skips_past_time_on_first_day():
    # after is Monday 20:00 local; a morning (09:00) first candidate can't fit today.
    tz = "America/New_York"
    after = datetime(2026, 7, 20, 12, 0, tzinfo=ZoneInfo(tz)).astimezone(timezone.utc)
    slots = weekly_date_slots({0, 2, 4}, tz, after, [(9, 0)])
    assert len(slots) == 1
    # Must be strictly after `after`; 09:00 Monday already passed -> lands Wednesday.
    assert slots[0] > after
    assert _local_hm(slots[0], tz) == (9, 0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest worker/tests/test_scheduling.py -k weekly_date_slots -v`
Expected: FAIL — `ImportError: cannot import name 'weekly_date_slots'`.

- [ ] **Step 3: Add `weekly_date_slots` to `worker/scheduling.py`**

Append (after `weekly_slots`):

```python
def weekly_date_slots(
    weekdays: set[int],
    tz_name: str,
    after: datetime,
    band_times: list[tuple[int, int]],
) -> list[datetime]:
    """One UTC slot per (hour, minute) in `band_times`, each on the next matching
    cadence day (one post per active day), strictly increasing and strictly after
    `after`. Unlike weekly_slots, each slot's time comes from its own band entry.
    """
    tz = ZoneInfo(tz_name)
    cursor = after.astimezone(tz).date()
    prev = after
    slots: list[datetime] = []
    i = 0
    horizon = len(band_times) * 8 + 366
    for _ in range(horizon):
        if i >= len(band_times):
            break
        if cursor.weekday() in weekdays:
            hh, mm = band_times[i]
            utc_dt = datetime.combine(cursor, dtime(hh, mm), tz).astimezone(UTC)
            if utc_dt > prev:
                slots.append(utc_dt)
                prev = utc_dt
                i += 1
                cursor += timedelta(days=1)  # one auto-post per active day
                continue
        cursor += timedelta(days=1)
    return slots
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest worker/tests/test_scheduling.py -v`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add worker/scheduling.py worker/tests/test_scheduling.py
git commit -m "feat(worker): weekly_date_slots — per-candidate slot times, one post/day"
```

---

### Task 4: Wire auto-fill to derive slot times from `time_of_day` tags

**Files:**
- Modify: `worker/autofill.py` (imports + the slot-building block in `run_autofill`)
- Test: `worker/tests/test_autofill.py` (append a band-scheduling case)

**Interfaces:**
- Consumes: `time_of_day.band_times`, `time_of_day.post_bands`, `time_of_day.resolve_slot_time`, `scheduling.weekly_date_slots`.
- Behavior: unchanged candidate selection/ordering and queue math; only the *time* assigned to each candidate changes.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_autofill.py` (reuses `make_channel`/`make_post`/`target` helpers already in the file):

```python
from zoneinfo import ZoneInfo


def _tag(conn, post_id, band):
    conn.execute(
        "INSERT INTO post_tags (post_id, tag_id) "
        "SELECT ?, id FROM tags WHERE name = ? AND kind='time_of_day'",
        (post_id, band),
    )
    conn.commit()


def test_autofill_uses_time_of_day_for_slot_time(conn, config):
    # Channel posts Mon/Wed/Fri; cadence time 17:00 is the anytime fallback.
    tz = "America/New_York"
    ch = make_channel(conn, min_depth=3, target=3,
                      cadence='{"days":["mon","wed","fri"],"time":"17:00"}', tz=tz)
    # created_at ordering makes selection deterministic (oldest first among never-posted).
    p_even = make_post(conn, ch, created_at="2026-01-01T00:00:00+00:00")
    p_morn = make_post(conn, ch, created_at="2026-01-02T00:00:00+00:00")
    p_any = make_post(conn, ch, created_at="2026-01-03T00:00:00+00:00")
    _tag(conn, p_even, "evening")
    _tag(conn, p_morn, "morning")
    # p_any: no time_of_day tag -> cadence time.

    now = datetime(2026, 7, 19, 12, 0, tzinfo=timezone.utc)  # a Sunday
    made = run_autofill(conn, config, now)
    assert made == 3

    rows = conn.execute(
        "SELECT post_id, scheduled_at FROM publications WHERE channel_id=? "
        "ORDER BY scheduled_at ASC", (ch,)
    ).fetchall()
    times = {r["post_id"]: datetime.fromisoformat(r["scheduled_at"]).astimezone(ZoneInfo(tz))
             for r in rows}
    assert (times[p_even].hour, times[p_even].minute) == (18, 0)
    assert (times[p_morn].hour, times[p_morn].minute) == (9, 0)
    assert (times[p_any].hour, times[p_any].minute) == (17, 0)  # cadence fallback
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest worker/tests/test_autofill.py -k time_of_day -v`
Expected: FAIL — publications land at the single cadence time 17:00 for all three (the assertions on 18:00/09:00 fail).

- [ ] **Step 3: Update imports in `worker/autofill.py`**

Change the two scheduling/time imports near the top (currently line 23-24):

```python
from .periods import in_season, local_date, period_from_row
from .scheduling import parse_iso, parse_weekly_cadence, weekly_date_slots
from .time_of_day import band_times, post_bands, resolve_slot_time
```

(Remove `weekly_slots` from the `.scheduling` import — it is no longer used here.)

- [ ] **Step 4: Replace the slot-building block in `run_autofill`**

Replace the current lines (166-169):

```python
        weekdays, hour, minute = cadence
        last_future = latest_future_scheduled(conn, ch["id"], now_iso)
        after = parse_iso(last_future) if last_future else now
        slots = weekly_slots(weekdays, hour, minute, ch["timezone"], after, len(candidates))
```

with:

```python
        weekdays, hour, minute = cadence
        cadence_hm = (hour, minute)
        bt_map = band_times(config)
        last_future = latest_future_scheduled(conn, ch["id"], now_iso)
        after = parse_iso(last_future) if last_future else now
        # Each candidate's slot TIME comes from its time_of_day tag; the cadence
        # still supplies which DAYS (one auto-post per active day).
        per_candidate_times = [
            resolve_slot_time(post_bands(conn, cand["post_id"]), bt_map, cadence_hm)
            for cand in candidates
        ]
        slots = weekly_date_slots(weekdays, ch["timezone"], after, per_candidate_times)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest worker/tests/test_autofill.py -v`
Expected: PASS (existing + new).

- [ ] **Step 6: Run the full worker suite**

Run: `python -m pytest worker/tests/ -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill.py
git commit -m "feat(worker): auto-fill derives slot time from time_of_day tags"
```

---

## Part ②-B — Dashboard (composer + library)

### Task 5: Tag types + query functions

**Files:**
- Modify: `dashboard/lib/types.ts` (add `TagKind`, `Tag`; extend the `Post` list shape fields consumed by the Library)
- Modify: `dashboard/lib/queries.ts` (add tag CRUD + thread `tag_ids` through create; extend `listPosts`)

**Interfaces:**
- Produces (types):
  - `export type TagKind = "topic" | "time_of_day";`
  - `export interface Tag { id: number; name: string; kind: TagKind; }`
- Produces (queries):
  - `listTags(kind?: TagKind): Tag[]`
  - `createTopicTag(name: string): Tag` (create-or-get, always `kind='topic'`)
  - `getPostTags(postId: number): Tag[]`
  - `setPostTags(postId: number, tagIds: number[]): void` (replace-semantics transaction)
  - `ContentModelInput` gains `tag_ids?: number[]`, written in `insertContentModelRows`
  - `listPosts()` rows gain `time_of_day_tags: string | null`, `topic_tags: string | null`, `target_platforms: string | null` (comma-joined)

- [ ] **Step 1: Add the types**

In `dashboard/lib/types.ts`, after the `Platform` type (line 4), add:

```typescript
export type TagKind = "topic" | "time_of_day";
export interface Tag {
  id: number;
  name: string;
  kind: TagKind;
}
```

- [ ] **Step 2: Add tag query functions**

In `dashboard/lib/queries.ts`, near the other side-table helpers (after `setPostTargets`, ~line 522), add:

```typescript
// ---- Tags (taxonomy: topic + time_of_day) -------------------------------------
export function listTags(kind?: "topic" | "time_of_day"): Tag[] {
  const db = getDb();
  if (kind) {
    return db
      .prepare("SELECT id, name, kind FROM tags WHERE kind = ? ORDER BY name COLLATE NOCASE")
      .all(kind) as Tag[];
  }
  return db
    .prepare("SELECT id, name, kind FROM tags ORDER BY kind, name COLLATE NOCASE")
    .all() as Tag[];
}

/** Create-or-get a free-form topic tag by name (case-insensitive). */
export function createTopicTag(name: string): Tag {
  const db = getDb();
  const clean = name.trim();
  db.prepare("INSERT OR IGNORE INTO tags (name, kind) VALUES (?, 'topic')").run(clean);
  return db
    .prepare("SELECT id, name, kind FROM tags WHERE name = ? COLLATE NOCASE")
    .get(clean) as Tag;
}

export function getPostTags(postId: number): Tag[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT t.id, t.name, t.kind
         FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.post_id = ?
        ORDER BY t.kind, t.name COLLATE NOCASE`
    )
    .all(postId) as Tag[];
}

/** Replace a post's tag set atomically. */
export function setPostTags(postId: number, tagIds: number[]): void {
  const db = getDb();
  const tx = db.transaction((ids: number[]) => {
    db.prepare("DELETE FROM post_tags WHERE post_id = ?").run(postId);
    const insert = db.prepare("INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)");
    for (const id of ids) insert.run(postId, id);
  });
  tx(tagIds);
}
```

Ensure `Tag` is imported at the top of `queries.ts` (add to the existing `import type { ... } from "./types"`).

- [ ] **Step 3: Thread `tag_ids` through post creation**

In `dashboard/lib/queries.ts`, extend the `ContentModelInput` interface (line ~148-155) with:

```typescript
  tag_ids?: number[];
```

In `insertContentModelRows` (after the `caption_variants` block, ~line 172), add:

```typescript
  if (data.tag_ids?.length) {
    const insert = db.prepare("INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)");
    for (const tagId of data.tag_ids) insert.run(postId, tagId);
  }
```

- [ ] **Step 4: Extend `listPosts` with tag + platform columns**

In `listPosts` (the SELECT with `target_count`/`green_period_count`, ~line 320), add these correlated subqueries to the column list:

```sql
         (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id AND t.kind = 'time_of_day') AS time_of_day_tags,
         (SELECT GROUP_CONCAT(t.name) FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
            WHERE pt.post_id = p.id AND t.kind = 'topic') AS topic_tags,
         (SELECT GROUP_CONCAT(DISTINCT c.platform) FROM post_targets pt2
            JOIN channels c ON c.id = pt2.channel_id WHERE pt2.post_id = p.id) AS target_platforms,
```

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/types.ts dashboard/lib/queries.ts
git commit -m "feat(dashboard): tag types + query layer (CRUD, create-path threading, list columns)"
```

---

### Task 6: Tag API routes + validation

**Files:**
- Create: `dashboard/app/api/tags/route.ts` (GET list, POST create-topic)
- Modify: `dashboard/app/api/posts/[id]/content/route.ts` (accept + validate `tag_ids`, call `setPostTags`)
- Modify: `dashboard/app/api/posts/route.ts` and `dashboard/app/api/posts/draft/route.ts` (accept + forward `tag_ids`)

**Interfaces:**
- Consumes: `listTags`, `createTopicTag`, `setPostTags`, `getPostTags` from Task 5.
- `GET /api/tags?kind=topic|time_of_day` → `Tag[]`. `POST /api/tags` `{ name }` → `Tag` (201).
- All three post routes accept optional `tag_ids: number[]`; each id must exist in `tags` (400 on unknown); dedupe before use.

- [ ] **Step 1: Create `dashboard/app/api/tags/route.ts`**

```typescript
import { NextResponse } from "next/server";
import { listTags, createTopicTag } from "@/lib/queries";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const kind = new URL(req.url).searchParams.get("kind");
  if (kind && kind !== "topic" && kind !== "time_of_day") {
    return NextResponse.json({ error: "kind must be topic or time_of_day." }, { status: 400 });
  }
  return NextResponse.json(listTags(kind as "topic" | "time_of_day" | undefined));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }
  return NextResponse.json(createTopicTag(name), { status: 201 });
}
```

- [ ] **Step 2: Add a shared tag-id validator + wire into the content route**

In `dashboard/app/api/posts/[id]/content/route.ts`, add an import and a `tag_ids` block. First extend the imports:

```typescript
import { getPostTags, setPostTags, listTags } from "@/lib/queries";
```

Then, alongside the existing `target_channel_ids` handling (~line 64), add:

```typescript
  if ("tag_ids" in body) {
    if (!Array.isArray(body.tag_ids)) {
      return NextResponse.json({ error: "tag_ids must be an array." }, { status: 400 });
    }
    const validIds = new Set(listTags().map((t) => t.id));
    const tagIds = [...new Set(body.tag_ids.map(Number))] as number[];
    const bad = tagIds.filter((id) => !validIds.has(id));
    if (bad.length > 0) {
      return NextResponse.json({ error: `Unknown tag id(s): ${bad.join(", ")}` }, { status: 400 });
    }
    setPostTags(postId, tagIds);
  }
```

- [ ] **Step 3: Forward `tag_ids` from the create + draft routes**

In `dashboard/app/api/posts/route.ts` and `dashboard/app/api/posts/draft/route.ts`, where the `ContentModelInput`-style object is built for `createPostWithPublications` / `createDraftPost`, add validation + forwarding. In each route, before the create call, add:

```typescript
  let tagIds: number[] | undefined;
  if ("tag_ids" in body) {
    if (!Array.isArray(body.tag_ids)) {
      return NextResponse.json({ error: "tag_ids must be an array." }, { status: 400 });
    }
    const validIds = new Set(listTags().map((t) => t.id));
    tagIds = [...new Set(body.tag_ids.map(Number))] as number[];
    const bad = tagIds.filter((id) => !validIds.has(id));
    if (bad.length > 0) {
      return NextResponse.json({ error: `Unknown tag id(s): ${bad.join(", ")}` }, { status: 400 });
    }
  }
```

Add `tag_ids: tagIds` to the object passed into the create function, and add `listTags` to each route's `@/lib/queries` import.

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Reason through the validation**

Confirm on paper: omitting `tag_ids` → behaves exactly as today; a `tag_ids` with an unknown id → 400 before any write; duplicate ids → deduped, single row via `INSERT OR IGNORE`; a `time_of_day` id and a `topic` id in the same array → both accepted (both exist in `tags`).

- [ ] **Step 6: Commit**

```bash
git add dashboard/app/api/tags/route.ts dashboard/app/api/posts/[id]/content/route.ts dashboard/app/api/posts/route.ts dashboard/app/api/posts/draft/route.ts
git commit -m "feat(dashboard): tag API routes + tag_ids validation on post create/edit"
```

---

### Task 7: Composer tag controls

**Files:**
- Create: `dashboard/components/tag-editor.tsx`
- Modify: `dashboard/components/composer.tsx` (render `<TagEditor>`, hold state, send `tag_ids` in both submits)
- Modify: `dashboard/app/compose/page.tsx` (fetch `listTags("time_of_day")` + `listTags("topic")`, pass to `<Composer>`)

**Interfaces:**
- Consumes: `Tag` type; `GET/POST /api/tags`.
- `<TagEditor>` props: `timeOfDayTags: Tag[]` (the four seeded bands), `topicTags: Tag[]` (existing topics), `value: number[]` (selected tag ids), `onChange: (ids: number[]) => void`.
- Produces: composer includes `tag_ids: value` in the `/api/posts` and `/api/posts/draft` request bodies.

- [ ] **Step 1: Create `dashboard/components/tag-editor.tsx`**

```typescript
"use client";

import { useState } from "react";
import type { Tag } from "@/lib/types";

const BAND_LABEL: Record<string, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  anytime: "Anytime",
};

const chip = (active: boolean) =>
  `rounded-full border px-3 py-1 text-sm transition-colors ${
    active
      ? "border-brand bg-brand-weak font-medium text-brand-ink"
      : "border-border text-muted hover:text-ink"
  }`;

export function TagEditor({
  timeOfDayTags,
  topicTags,
  value,
  onChange,
}: {
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [topics, setTopics] = useState<Tag[]>(topicTags);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const has = (id: number) => value.includes(id);
  const toggle = (id: number) =>
    onChange(has(id) ? value.filter((x) => x !== id) : [...value, id]);

  // Order the band chips morning -> afternoon -> evening -> anytime.
  const bandOrder = ["morning", "afternoon", "evening", "anytime"];
  const bands = [...timeOfDayTags].sort(
    (a, b) => bandOrder.indexOf(a.name) - bandOrder.indexOf(b.name)
  );

  async function addTopic() {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const tag: Tag = await res.json();
        if (!topics.some((t) => t.id === tag.id)) setTopics((p) => [...p, tag]);
        if (!has(tag.id)) onChange([...value, tag.id]);
        setDraft("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium text-ink-soft">Time of day</p>
        <div className="flex flex-wrap gap-2">
          {bands.map((t) => (
            <button key={t.id} type="button" className={chip(has(t.id))} onClick={() => toggle(t.id)}>
              {BAND_LABEL[t.name] ?? t.name}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-faint">
          Sets when auto-fill posts this. Anytime (or none) uses the channel's default time.
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-ink-soft">Topics</p>
        <div className="flex flex-wrap gap-2">
          {topics.map((t) => (
            <button key={t.id} type="button" className={chip(has(t.id))} onClick={() => toggle(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            className="w-48 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:border-brand"
            placeholder="Add a topic…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTopic();
              }
            }}
          />
          <button
            type="button"
            onClick={addTopic}
            disabled={busy || !draft.trim()}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the editor into `composer.tsx`**

- Add the import: `import { TagEditor } from "./tag-editor";` and `import type { Tag } from "@/lib/types";` (if not already importing `Tag`).
- Extend the composer's props to accept `timeOfDayTags: Tag[]` and `topicTags: Tag[]`.
- Add state: `const [tagIds, setTagIds] = useState<number[]>([]);`
- Render the editor in a new labeled section (match the existing section pattern used for period-attach), e.g. after the periods section:

```tsx
      <section>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Tags</h3>
        <TagEditor
          timeOfDayTags={timeOfDayTags}
          topicTags={topicTags}
          value={tagIds}
          onChange={setTagIds}
        />
      </section>
```

- In BOTH submit payloads (the `/api/posts` schedule body and the `/api/posts/draft` body), add `tag_ids: tagIds`.

- [ ] **Step 3: Provide the tags from the compose page**

In `dashboard/app/compose/page.tsx`, import `listTags`, fetch both kinds, and pass them:

```tsx
import { listTags } from "@/lib/queries";
// ...
  const timeOfDayTags = listTags("time_of_day");
  const topicTags = listTags("topic");
// ...
  <Composer /* existing props */ timeOfDayTags={timeOfDayTags} topicTags={topicTags} />
```

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Browser verification (controller runs this; list it)**

Note for the reviewer to click-test: on `/compose`, the Tags section shows four band chips (Morning/Afternoon/Evening/Anytime) + a topic adder; selecting Morning + adding a topic "travel", then "Save to library", persists — reopening the post (or checking the Library card in Task 8) shows both tags.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/tag-editor.tsx dashboard/components/composer.tsx dashboard/app/compose/page.tsx
git commit -m "feat(dashboard): composer tag controls (time_of_day bands + topics)"
```

---

### Task 8: Library tag chips + tag/platform filters

**Files:**
- Modify: `dashboard/components/library-view.tsx` (extend `PostLite`, render tag chips, add filter bar)
- Modify: `dashboard/app/library/page.tsx` (pass the three new fields through)

**Interfaces:**
- Consumes: `listPosts` rows with `time_of_day_tags`, `topic_tags`, `target_platforms` (comma strings) from Task 5.
- Produces: client-side filters that narrow the rendered post list by a selected tag name and/or a platform (`instagram`/`facebook`), computed from `target_platforms`.

- [ ] **Step 1: Pass the new fields in `library/page.tsx`**

In the `listPosts().map(...)` object (where `content_kind`, `target_count`, etc. are already passed), add:

```tsx
          time_of_day_tags: p.time_of_day_tags,
          topic_tags: p.topic_tags,
          target_platforms: p.target_platforms,
```

- [ ] **Step 2: Extend `PostLite` and render chips + filters in `library-view.tsx`**

Extend the `PostLite` interface with:

```typescript
  time_of_day_tags: string | null;
  topic_tags: string | null;
  target_platforms: string | null;
```

Add filter state near the other `useState` hooks:

```typescript
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
```

Add derived helpers and the filtered list (before the render of the post list):

```typescript
  const splitTags = (s: string | null) => (s ? s.split(",") : []);
  const allTagNames = Array.from(
    new Set(posts.flatMap((p) => [...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)]))
  ).sort();

  const shown = posts.filter((p) => {
    if (tagFilter) {
      const names = [...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)];
      if (!names.includes(tagFilter)) return false;
    }
    if (platformFilter) {
      if (!splitTags(p.target_platforms).includes(platformFilter)) return false;
    }
    return true;
  });
```

Render a filter bar above the post list (match the existing chip/pill visual language), wiring `tagFilter` from `allTagNames` and `platformFilter` from `["instagram","facebook"]`, each toggling back to `null` when re-clicked. Change the post list `.map` to iterate `shown` instead of `posts`. On each post card, render its tag chips using the existing `.data` micro-text style:

```tsx
        {[...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)].map((name) => (
          <span key={name} className="data rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-muted">
            {name}
          </span>
        ))}
```

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Browser verification (controller runs this; list it)**

Note for the reviewer: on `/library`, the post tagged in Task 7 shows `morning` + `travel` chips; clicking the `travel` filter narrows the list to it; clicking an `instagram` platform filter shows only posts whose targets include an IG account (derived, no platform tag). Existing bulk-schedule / bulk re-target still work.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/library-view.tsx dashboard/app/library/page.tsx
git commit -m "feat(dashboard): Library tag chips + tag/platform filters"
```

---

## Self-Review

**Spec coverage** (spec `docs/design-tag-taxonomy.md`):
- §2 taxonomy (`kind`, four bands, topics free-form) → Tasks 1, 5. ✅
- §2 platform-not-a-tag / computed platform filter → Task 5 (`target_platforms`), Task 8 (filter). ✅
- §3 tag defines time / cadence defines days / one-post-per-day → Tasks 2, 3, 4. ✅
- §3 earliest specific band, anytime/untagged → cadence time → Task 2 `resolve_slot_time` + tests. ✅
- §4 migration (ALTER + seed + index) → Task 1. ✅
- §4 band times as env-overridable config → Task 2. ✅
- §5 composer 4-chip + topic adder → Task 7; Library filters + chips → Task 8. ✅
- §5 queries/routes + `runtime="nodejs"` + validation → Tasks 5, 6. ✅
- §7 anytime explicit value → seeded in Task 1, chip in Task 7. ✅

**Placeholder scan:** No TBD/TODO; every code step carries full code. React component tasks (7, 8) give the full new component and exact wiring points; the two "match the existing pattern" references are for visual styling only, not logic — acceptable and unavoidable without inlining unrelated existing markup.

**Type consistency:** `Tag`/`TagKind` defined in Task 5 and consumed in Tasks 6–8. `resolve_slot_time`/`post_bands`/`band_times`/`weekly_date_slots` signatures defined in Tasks 2–3 and consumed verbatim in Task 4. `tag_ids` threaded consistently: `ContentModelInput.tag_ids` (Task 5) ← routes (Task 6) ← composer payload (Task 7).

---

## Out of scope (deferred, per spec §6)
- ③ Bulk import, ④ full Library overview, per-channel band-time overrides, topic rename/merge/delete UI.
