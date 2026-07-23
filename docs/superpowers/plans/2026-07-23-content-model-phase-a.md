# Content Model — Phase A (data + logic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give posts a content model — recycling kind, in-season periods, per-account targeting, caption variants, and status — and wire the automation (auto-fill + publish) to honor it, all headless-testable before any UI.

**Architecture:** One additive SQL migration adds columns + four tables. A small pure-Python module does period date math. Auto-fill selection gains eligibility gates (status/targets/cooldown in SQL, period windows in Python). The publisher gains caption-variant selection and one-time auto-retirement. No new dependencies.

**Tech Stack:** Python 3.11 (stdlib only in the worker except `requests`), SQLite via `sqlite3`, pytest. Schema in `/migrations/*.sql` applied by `migrate.py`.

## Global Constraints

- Schema lives ONLY in `/migrations` as numbered `.sql`; never define schema inline. (Migration is additive — do not edit `0001_init.sql`.)
- Worker code is stdlib-only (no new packages); `requests` is the sole existing runtime dep.
- SQLite connections run with `PRAGMA foreign_keys = ON` (conftest and `db.connect` already do this).
- Timestamps are ISO-8601 UTC text. Period windows are evaluated in the **channel's** timezone.
- Eligibility gates govern **automation only** (auto-fill). Manual publishing is never hard-blocked.
- Failures stay visible; one publication never affects another (unchanged invariant).
- Run tests with: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/ -q`

---

## File Structure

- **Create** `migrations/0002_content_model.sql` — columns on `posts` + tables `periods`, `post_periods`, `post_targets`, `caption_variants`; backfill.
- **Create** `worker/periods.py` — `Period`, `period_from_row`, `period_contains`, `local_date`, `in_season`. Pure functions.
- **Create** `worker/tests/test_migration_0002.py` — applies 0001→0002 over seeded data, asserts backfill.
- **Create** `worker/tests/test_periods.py` — period math.
- **Modify** `worker/tests/conftest.py` — apply ALL migrations (not just 0001) when building the test DB.
- **Modify** `worker/autofill.py` — eligibility gates; `select_candidates` new signature; add `eligible_candidates`, `_post_periods`.
- **Modify** `worker/tests/test_autofill.py` — seed `content_status='ready'` + targets; call the new selection API; add period/cooldown/one-time/target tests.
- **Modify** `worker/publisher.py` — caption-variant selection (`_select_caption`) and one-time retirement (`_maybe_retire_one_time`).
- **Modify** `worker/tests/test_publisher.py` — add caption-rotation and retirement tests.

---

## Task 1: Migration 0002 + migration-aware test DB

**Files:**
- Create: `migrations/0002_content_model.sql`
- Modify: `worker/tests/conftest.py:15-28` (the `db_path` fixture)
- Test: `worker/tests/test_migration_0002.py`

**Interfaces:**
- Produces: `posts.content_kind` ('one_time'|'evergreen', default 'evergreen'), `posts.content_status` ('draft'|'ready'|'retired', default 'draft'), `posts.cooldown_days` (nullable int); tables `periods(id,name,recurs_yearly,start_month,start_day,end_month,end_day,start_date,end_date,created_at)`, `post_periods(post_id,period_id,mode)`, `post_targets(post_id,channel_id)`, `caption_variants(id,post_id,platform,body,sort_order)`.

- [ ] **Step 1: Write the migration file**

Create `migrations/0002_content_model.sql`:

```sql
-- 0002_content_model.sql — content model: recycling kind, in-season periods,
-- per-account targeting, caption variants, and content status.
-- Additive + backfill so existing installs keep working. See docs/design-content-model.md.

-- posts: new axes. content_status is SEPARATE from the coarse posts.status (overview hint):
-- content_status governs automation eligibility.
ALTER TABLE posts ADD COLUMN content_kind   TEXT NOT NULL DEFAULT 'evergreen'
    CHECK (content_kind IN ('one_time', 'evergreen'));
ALTER TABLE posts ADD COLUMN content_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (content_status IN ('draft', 'ready', 'retired'));
ALTER TABLE posts ADD COLUMN cooldown_days  INTEGER;   -- NULL = use channel.reuse_min_age_days

-- Reusable library of named windows. recurs_yearly=1 -> month/day columns (wrap-around
-- allowed: start after end means the window spans the New Year). recurs_yearly=0 -> ISO dates.
CREATE TABLE periods (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    recurs_yearly INTEGER NOT NULL DEFAULT 1,
    start_month   INTEGER, start_day INTEGER,
    end_month     INTEGER, end_day   INTEGER,
    start_date    TEXT, end_date TEXT,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A post links to a period as 'green' (in-season) or 'blackout' (excluded). Blackout wins.
CREATE TABLE post_periods (
    post_id   INTEGER NOT NULL REFERENCES posts(id)   ON DELETE CASCADE,
    period_id INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    mode      TEXT NOT NULL CHECK (mode IN ('green', 'blackout')),
    PRIMARY KEY (post_id, period_id, mode)
);

-- Explicit accounts a post is for. "All" is expanded to current channels at set-time (snapshot).
CREATE TABLE post_targets (
    post_id    INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, channel_id)
);
CREATE INDEX idx_post_targets_channel ON post_targets (channel_id);

-- 1..N captions per post. platform NULL = generic (rotated for variety); else platform-specific.
CREATE TABLE caption_variants (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    platform   TEXT,
    body       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_caption_variants_post ON caption_variants (post_id);

-- Backfill existing installs so nothing disappears:
--  * existing content stays eligible (ready), evergreen by default (column default);
--  * targets inferred from the channels each post already published/queued to;
--  * the single existing caption becomes one generic variant.
UPDATE posts SET content_status = 'ready';
INSERT INTO post_targets (post_id, channel_id)
    SELECT DISTINCT post_id, channel_id FROM publications;
INSERT INTO caption_variants (post_id, platform, body, sort_order)
    SELECT id, NULL, caption, 0 FROM posts WHERE caption IS NOT NULL AND TRIM(caption) <> '';
```

- [ ] **Step 2: Make the test DB apply ALL migrations**

In `worker/tests/conftest.py`, replace the `INIT_SQL` constant and `db_path` fixture (lines 15-28) with:

```python
REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations"


@pytest.fixture
def db_path(tmp_path) -> Path:
    """A fresh DB built from ALL migrations in order (mirrors migrate.py — no drift)."""
    p = tmp_path / "test.db"
    conn = sqlite3.connect(str(p))
    conn.execute("PRAGMA foreign_keys = ON;")
    for sql_file in sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda f: f.name):
        conn.executescript(sql_file.read_text())
    conn.commit()
    conn.close()
    return p
```

(Delete the now-unused `INIT_SQL = REPO_ROOT / "migrations" / "0001_init.sql"` line.)

- [ ] **Step 3: Write the backfill test**

Create `worker/tests/test_migration_0002.py`:

```python
"""0002 applies additively and backfills existing installs correctly."""
from __future__ import annotations

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG = REPO_ROOT / "migrations"


def _apply(conn, name):
    conn.executescript((MIG / name).read_text())
    conn.commit()


def test_0002_backfills_existing_data(tmp_path):
    p = tmp_path / "m.db"
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    _apply(conn, "0001_init.sql")

    # Seed a pre-migration install: a channel, a captioned post, a publication.
    conn.execute("INSERT INTO channels (platform, account_name) VALUES ('instagram','C')")
    conn.execute("INSERT INTO posts (caption, post_type) VALUES ('hello', 'single')")
    conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at) "
                 "VALUES (1, 1, '2026-01-01T00:00:00+00:00')")
    conn.commit()

    _apply(conn, "0002_content_model.sql")

    post = conn.execute("SELECT content_kind, content_status, cooldown_days "
                        "FROM posts WHERE id=1").fetchone()
    assert post["content_kind"] == "evergreen"
    assert post["content_status"] == "ready"   # existing content stays eligible
    assert post["cooldown_days"] is None

    tgt = conn.execute("SELECT channel_id FROM post_targets WHERE post_id=1").fetchall()
    assert [r["channel_id"] for r in tgt] == [1]   # inferred from the publication

    cap = conn.execute("SELECT platform, body FROM caption_variants WHERE post_id=1").fetchall()
    assert len(cap) == 1 and cap[0]["platform"] is None and cap[0]["body"] == "hello"


def test_0002_new_post_defaults_to_draft(tmp_path):
    p = tmp_path / "m2.db"
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    _apply(conn, "0001_init.sql")
    _apply(conn, "0002_content_model.sql")
    # A post created AFTER the migration defaults to draft (nothing auto-posts by accident).
    conn.execute("INSERT INTO posts (caption, post_type) VALUES ('new', 'single')")
    conn.commit()
    row = conn.execute("SELECT content_status, content_kind FROM posts WHERE id=1").fetchone()
    assert row["content_status"] == "draft"
    assert row["content_kind"] == "evergreen"
```

- [ ] **Step 4: Run the tests**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/test_migration_0002.py -q`
Expected: 2 passed. (If `ALTER TABLE ... CHECK` errors on the SQLite build, split into `ADD COLUMN` without CHECK — but current macOS SQLite supports it.)

- [ ] **Step 5: Run the FULL suite to catch fixture fallout**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/ -q`
Expected: existing tests still pass (the new columns have defaults; publisher/run tests don't hit eligibility gates). If `test_autofill.py` fails here, that's expected and fixed in Task 3 — note it and continue.

- [ ] **Step 6: Commit**

```bash
git add migrations/0002_content_model.sql worker/tests/conftest.py worker/tests/test_migration_0002.py
git commit -m "feat(schema): 0002 content model — kind, status, periods, targeting, captions"
```

---

## Task 2: Period date math (`worker/periods.py`)

**Files:**
- Create: `worker/periods.py`
- Test: `worker/tests/test_periods.py`

**Interfaces:**
- Produces:
  - `Period` dataclass with fields `id, name, recurs_yearly(bool), start_month, start_day, end_month, end_day, start_date, end_date`.
  - `period_from_row(row) -> Period`
  - `period_contains(period: Period, local: datetime.date) -> bool`
  - `local_date(now_utc: datetime, tz_name: str) -> datetime.date`
  - `in_season(green: list[Period], blackout: list[Period], local: datetime.date) -> bool`
- Consumes: nothing (pure).

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_periods.py`:

```python
"""Period window math: yearly (incl. wrap-around), one-off, timezone-local date."""
from __future__ import annotations

from datetime import date, datetime, timezone

from worker.periods import Period, in_season, local_date, period_contains


def yearly(sm, sd, em, ed):
    return Period(id=1, name="p", recurs_yearly=True, start_month=sm, start_day=sd,
                  end_month=em, end_day=ed, start_date=None, end_date=None)


def oneoff(s, e):
    return Period(id=2, name="o", recurs_yearly=False, start_month=None, start_day=None,
                  end_month=None, end_day=None, start_date=s, end_date=e)


def test_yearly_simple_window():
    summer = yearly(6, 1, 8, 31)
    assert period_contains(summer, date(2026, 7, 15)) is True
    assert period_contains(summer, date(2026, 1, 15)) is False


def test_yearly_wraps_new_year():
    holidays = yearly(12, 15, 1, 5)   # Dec 15 -> Jan 5
    assert period_contains(holidays, date(2026, 12, 20)) is True
    assert period_contains(holidays, date(2026, 1, 3)) is True
    assert period_contains(holidays, date(2026, 7, 4)) is False


def test_oneoff_dates():
    p = oneoff("2026-07-01", "2026-07-07")
    assert period_contains(p, date(2026, 7, 4)) is True
    assert period_contains(p, date(2026, 7, 8)) is False


def test_local_date_uses_channel_timezone():
    # 01:30 UTC is still the previous evening in New York.
    now = datetime(2026, 1, 2, 1, 30, tzinfo=timezone.utc)
    assert local_date(now, "America/New_York") == date(2026, 1, 1)


def test_in_season_rules():
    winter = yearly(12, 1, 2, 28)
    beach_blackout = yearly(12, 1, 12, 31)
    # green with no match -> out of season
    assert in_season([winter], [], date(2026, 7, 1)) is False
    # green match -> in season
    assert in_season([winter], [], date(2026, 1, 15)) is True
    # blackout overrides green
    assert in_season([winter], [beach_blackout], date(2026, 12, 10)) is False
    # no green periods -> always in season (unless blackout)
    assert in_season([], [], date(2026, 7, 1)) is True
    assert in_season([], [beach_blackout], date(2026, 12, 10)) is False
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/test_periods.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'worker.periods'`.

- [ ] **Step 3: Implement the module**

Create `worker/periods.py`:

```python
"""Period window math for content eligibility. Pure + stdlib only.

A period is either yearly (by month/day, wrap-around allowed) or a one-off date range.
Windows are evaluated against a LOCAL date (the channel's timezone) so season boundaries
land on the local calendar day. See docs/design-content-model.md.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo


@dataclass
class Period:
    id: int
    name: str
    recurs_yearly: bool
    start_month: int | None
    start_day: int | None
    end_month: int | None
    end_day: int | None
    start_date: str | None
    end_date: str | None


def period_from_row(row) -> Period:
    return Period(
        id=row["id"], name=row["name"], recurs_yearly=bool(row["recurs_yearly"]),
        start_month=row["start_month"], start_day=row["start_day"],
        end_month=row["end_month"], end_day=row["end_day"],
        start_date=row["start_date"], end_date=row["end_date"],
    )


def _md(month: int, day: int) -> int:
    """A comparable month-day key, e.g. Dec 15 -> 1215."""
    return month * 100 + day


def period_contains(period: Period, local: date) -> bool:
    if period.recurs_yearly:
        start = _md(period.start_month, period.start_day)
        end = _md(period.end_month, period.end_day)
        cur = _md(local.month, local.day)
        if start <= end:
            return start <= cur <= end
        # wrap-around across the New Year (e.g. Dec 15 -> Jan 5)
        return cur >= start or cur <= end
    start = date.fromisoformat(period.start_date)
    end = date.fromisoformat(period.end_date)
    return start <= local <= end


def local_date(now_utc: datetime, tz_name: str) -> date:
    return now_utc.astimezone(ZoneInfo(tz_name)).date()


def in_season(green: list[Period], blackout: list[Period], local: date) -> bool:
    """Blackout wins; then, if any green periods exist, one must contain `local`."""
    if any(period_contains(b, local) for b in blackout):
        return False
    if green and not any(period_contains(g, local) for g in green):
        return False
    return True
```

- [ ] **Step 4: Run to verify pass**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/test_periods.py -q`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add worker/periods.py worker/tests/test_periods.py
git commit -m "feat(worker): period window math (yearly wrap-around, one-off, tz-local)"
```

---

## Task 3: Eligibility gates in auto-fill

**Files:**
- Modify: `worker/autofill.py` (rewrite `select_candidates`; add `_post_periods`, `eligible_candidates`; update `run_autofill`)
- Modify: `worker/tests/test_autofill.py` (seed helpers + call sites + new tests)

**Interfaces:**
- Consumes: `worker.periods.in_season`, `period_from_row`, `local_date`; `worker.scheduling.parse_iso`.
- Produces:
  - `select_candidates(conn, channel_id: int, now) -> list[Row]` — SQL-gated, ordered rows with columns `post_id, content_kind, cooldown_days, last_posted, perf`. (Signature CHANGED: no `reuse_min_age_days`, no `limit`.)
  - `eligible_candidates(conn, channel: Row, now, limit: int) -> list[Row]` — applies cooldown + one-time + period gates in Python, returns up to `limit` rows in order.

- [ ] **Step 1: Rewrite `select_candidates` and add the new functions**

In `worker/autofill.py`, update the imports at the top (add periods + parse_iso is already imported):

```python
from .periods import in_season, local_date, period_from_row
```

Replace the entire `select_candidates` function (lines 55-96) with:

```python
def select_candidates(conn, channel_id: int, now):
    """SQL-gated, ordered candidate posts for a channel. Cooldown/one-time/period gates
    are applied afterward in `eligible_candidates` (Python — clearer for date math).

    Gates here: status ready, targets this channel, has assets, supported type, not already
    queued. Ordered: never-posted first, then performance desc, then stalest, then oldest.
    """
    rows = conn.execute(
        f"""
        SELECT
          p.id AS post_id,
          p.content_kind AS content_kind,
          p.cooldown_days AS cooldown_days,
          (SELECT MAX(pub.published_at) FROM publications pub
             WHERE pub.post_id = p.id AND pub.channel_id = :cid AND pub.status = 'posted'
          ) AS last_posted,
          (SELECT COALESCE(MAX(IFNULL(pm.reach,0) + IFNULL(pm.saves,0)), 0)
             FROM post_metrics pm
             JOIN publications p3 ON p3.id = pm.publication_id
             WHERE p3.post_id = p.id AND p3.channel_id = :cid
          ) AS perf
        FROM posts p
        WHERE p.content_status = 'ready'
          AND p.post_type IN ('single','carousel')
          AND EXISTS (SELECT 1 FROM post_assets  pa WHERE pa.post_id = p.id)
          AND EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = p.id AND pt.channel_id = :cid)
          AND NOT EXISTS (
             SELECT 1 FROM publications q
             WHERE q.post_id = p.id AND q.channel_id = :cid
               AND q.status IN ({",".join("'" + s + "'" for s in ACTIVE_QUEUE_STATUSES)})
          )
        ORDER BY
          CASE WHEN last_posted IS NULL THEN 0 ELSE 1 END ASC,
          perf DESC,
          last_posted ASC,
          p.created_at ASC
        """,
        {"cid": channel_id},
    ).fetchall()
    return rows


def _post_periods(conn, post_id: int):
    """Return (green_periods, blackout_periods) for a post."""
    green, blackout = [], []
    for row in conn.execute(
        """SELECT pp.mode AS mode, pe.*
             FROM post_periods pp JOIN periods pe ON pe.id = pp.period_id
            WHERE pp.post_id = ?""",
        (post_id,),
    ).fetchall():
        (green if row["mode"] == "green" else blackout).append(period_from_row(row))
    return green, blackout


def eligible_candidates(conn, channel, now, limit: int):
    """Apply cooldown, one-time, and period gates to the SQL candidates; return <= limit."""
    reuse_default = channel["reuse_min_age_days"]
    today_local = local_date(now, channel["timezone"])
    out = []
    for r in select_candidates(conn, channel["id"], now):
        last = r["last_posted"]
        if r["content_kind"] == "one_time":
            if last is not None:
                continue  # one-time: only if this channel hasn't posted it
        elif last is not None:
            cooldown = r["cooldown_days"] if r["cooldown_days"] is not None else reuse_default
            if parse_iso(last) > now - timedelta(days=cooldown):
                continue  # still within cooldown
        green, blackout = _post_periods(conn, r["post_id"])
        if not in_season(green, blackout, today_local):
            continue
        out.append(r)
        if len(out) >= limit:
            break
    return out
```

- [ ] **Step 2: Point `run_autofill` at `eligible_candidates`**

In `worker/autofill.py`, in `run_autofill`, replace the candidate-selection line (currently line 121):

```python
        candidates = select_candidates(conn, ch["id"], ch["reuse_min_age_days"], now, need)
```

with:

```python
        candidates = eligible_candidates(conn, ch, now, need)
```

- [ ] **Step 3: Update the test seed helpers to produce eligible content**

In `worker/tests/test_autofill.py`, replace `make_post` (lines 29-40) with a version that marks content ready and targets a channel, and add a `target` helper:

```python
def make_post(conn, channel_id=None, created_at="2026-01-01T00:00:00+00:00",
              content_kind="evergreen"):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind, created_at) "
        "VALUES ('x','single','draft','ready',?,?)",
        (content_kind, created_at),
    ).lastrowid
    aid = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path, public_url) VALUES (?,?,?,?)",
        (f"h{pid}", "image", f"{pid}.jpg", "https://a.test/x.jpg"),
    ).lastrowid
    conn.execute("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)", (pid, aid))
    if channel_id is not None:
        conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, channel_id))
    conn.commit()
    return pid


def target(conn, post_id, channel_id):
    conn.execute("INSERT OR IGNORE INTO post_targets (post_id, channel_id) VALUES (?,?)",
                 (post_id, channel_id))
    conn.commit()
```

- [ ] **Step 4: Update the selection-tier tests to the new API and targeting**

In `worker/tests/test_autofill.py`, update the import (lines 7-11) to add `eligible_candidates`:

```python
from worker.autofill import (
    eligible_candidates,
    run_autofill,
    scheduled_ahead_count,
    select_candidates,
)
```

Add a helper right after the imports to fetch a channel row and call the new API concisely:

```python
def picks(conn, channel_id, limit):
    from worker import db
    ch = db.get_channel(conn, channel_id)
    return [r["post_id"] for r in eligible_candidates(conn, ch, NOW, limit)]
```

Now update each tier test to (a) target posts to the channel and (b) use `picks(...)`:

Replace `test_never_posted_chosen_before_recyclable` (lines 76-83) with:

```python
def test_never_posted_chosen_before_recyclable(conn):
    ch = make_channel(conn)
    never = make_post(conn, ch)
    recyc = make_post(conn, ch)
    mark_posted(conn, recyc, ch, (NOW - timedelta(days=200)).isoformat())
    assert picks(conn, ch, 1) == [never]
```

Replace `test_recently_posted_is_excluded` (lines 86-95) with:

```python
def test_recently_posted_is_excluded(conn):
    ch = make_channel(conn)
    recent = make_post(conn, ch)
    old = make_post(conn, ch)
    mark_posted(conn, recent, ch, (NOW - timedelta(days=10)).isoformat())
    mark_posted(conn, old, ch, (NOW - timedelta(days=200)).isoformat())
    got = picks(conn, ch, 10)
    assert recent not in got
    assert old in got
```

Replace `test_top_performer_preferred_among_recyclable` (lines 98-106) with:

```python
def test_top_performer_preferred_among_recyclable(conn):
    ch = make_channel(conn)
    low = make_post(conn, ch)
    high = make_post(conn, ch)
    mark_posted(conn, low, ch, (NOW - timedelta(days=200)).isoformat(), reach=10, saves=1)
    mark_posted(conn, high, ch, (NOW - timedelta(days=200)).isoformat(), reach=500, saves=90)
    assert picks(conn, ch, 1) == [high]
```

Replace `test_performance_is_per_channel` (lines 109-122) with:

```python
def test_performance_is_per_channel(conn):
    a = make_channel(conn)
    b = make_channel(conn)
    plain = make_post(conn, a)
    star_on_b = make_post(conn, a)
    mark_posted(conn, plain, a, (NOW - timedelta(days=200)).isoformat(), reach=5, saves=0)
    mark_posted(conn, star_on_b, a, (NOW - timedelta(days=200)).isoformat(), reach=5, saves=0)
    mark_posted(conn, star_on_b, b, (NOW - timedelta(days=200)).isoformat(), reach=9999, saves=9999)
    assert set(picks(conn, a, 2)) == {plain, star_on_b}
```

Replace `test_already_queued_not_reselected` (lines 125-130) with:

```python
def test_already_queued_not_reselected(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch)
    queue_future(conn, p, ch, "2026-08-01T22:00:00+00:00")
    assert p not in picks(conn, ch, 10)
```

- [ ] **Step 5: Update the full top-up tests to target content**

In `worker/tests/test_autofill.py`, the three `run_autofill` tests make posts without targets. Update them so posts target the channel.

Replace `test_run_autofill_tops_up_to_target` body's post loop (line 136-137):

```python
    for _ in range(10):
        make_post(conn, ch)  # plenty of never-posted, targeted content
```

Replace in `test_run_autofill_skips_when_queue_healthy` (lines 157-161):

```python
    p1, p2 = make_post(conn, ch), make_post(conn, ch)
    queue_future(conn, p1, ch, "2026-08-01T22:00:00+00:00")
    queue_future(conn, p2, ch, "2026-08-03T22:00:00+00:00")  # ahead == 2 == min_depth
    for _ in range(5):
        make_post(conn, ch)
```

Replace in `test_run_autofill_respects_approval` (lines 166-167):

```python
    make_post(conn, ch)
    make_post(conn, ch)
```

- [ ] **Step 6: Add new gate tests (status, targeting, one-time, cooldown override, periods)**

Append to `worker/tests/test_autofill.py`:

```python
# ---- content-model eligibility gates --------------------------------------------
def _add_period(conn, name, sm, sd, em, ed):
    return conn.execute(
        "INSERT INTO periods (name, recurs_yearly, start_month, start_day, end_month, end_day) "
        "VALUES (?,1,?,?,?,?)", (name, sm, sd, em, ed),
    ).lastrowid


def test_draft_status_excluded(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch)
    conn.execute("UPDATE posts SET content_status='draft' WHERE id=?", (p,))
    conn.commit()
    assert p not in picks(conn, ch, 10)


def test_untargeted_post_excluded(conn):
    ch = make_channel(conn)
    p = make_post(conn)  # no channel target
    assert p not in picks(conn, ch, 10)


def test_one_time_only_until_posted_once(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch, content_kind="one_time")
    assert p in picks(conn, ch, 10)                       # eligible before posting
    mark_posted(conn, p, ch, (NOW - timedelta(days=999)).isoformat())
    assert p not in picks(conn, ch, 10)                   # never again, even long after


def test_per_post_cooldown_override(conn):
    ch = make_channel(conn)  # channel reuse default = 180 days
    p = make_post(conn, ch)
    conn.execute("UPDATE posts SET cooldown_days=7 WHERE id=?", (p,))
    conn.commit()
    mark_posted(conn, p, ch, (NOW - timedelta(days=10)).isoformat())  # 10 > 7 -> eligible
    assert p in picks(conn, ch, 10)


def test_green_period_gates_by_season(conn):
    ch = make_channel(conn)  # tz America/New_York
    winter = make_post(conn, ch)
    per = _add_period(conn, "Winter", 12, 1, 2, 28)
    conn.execute("INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?, 'green')",
                 (winter, per))
    conn.commit()
    # NOW is July -> out of the Winter window -> excluded.
    assert winter not in picks(conn, ch, 10)


def test_blackout_overrides_eligibility(conn):
    ch = make_channel(conn)
    p = make_post(conn, ch)
    per = _add_period(conn, "NoSummer", 6, 1, 8, 31)     # NOW (July) is inside
    conn.execute("INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?, 'blackout')",
                 (p, per))
    conn.commit()
    assert p not in picks(conn, ch, 10)
```

- [ ] **Step 7: Run the auto-fill tests**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/test_autofill.py -q`
Expected: all pass (original tiers + 6 new gate tests).

- [ ] **Step 8: Run the full suite**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/ -q`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill.py
git commit -m "feat(worker): auto-fill honors content model (status, targets, one-time, cooldown, periods)"
```

---

## Task 4: One-time auto-retirement in the publisher

**Files:**
- Modify: `worker/publisher.py` (add `_maybe_retire_one_time`; call after a successful real publish)
- Test: `worker/tests/test_publisher.py`

**Interfaces:**
- Consumes: `post["content_kind"]`, `post_targets`, `publications.status`.
- Produces: `_maybe_retire_one_time(conn, post_id: int, now: datetime) -> bool` — sets `posts.content_status='retired'` iff every targeted channel has a posted publication of this post; returns whether it retired.

- [ ] **Step 1: Write the failing test**

Add to `worker/tests/test_publisher.py`:

```python
def test_one_time_retires_only_after_all_targets_posted(conn, config, make_publication):
    from worker.publisher import _maybe_retire_one_time
    from datetime import datetime, timezone
    now = datetime(2026, 7, 22, tzinfo=timezone.utc)

    # A one-time post targeting two channels.
    pub = make_publication(post_type="single", n_assets=1, now=now)
    post_id, chan_a = pub["post_id"], pub["channel_id"]
    conn.execute("UPDATE posts SET content_kind='one_time' WHERE id=?", (post_id,))
    chan_b = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES ('instagram','B','2','t')").lastrowid
    conn.executemany("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)",
                     [(post_id, chan_a), (post_id, chan_b)])
    conn.commit()

    # Posted to A only -> NOT retired yet.
    conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
                 "VALUES (?,?, '2026-07-01T00:00:00+00:00', 'posted', '2026-07-01T00:00:00+00:00')",
                 (post_id, chan_a))
    conn.commit()
    assert _maybe_retire_one_time(conn, post_id, now) is False
    assert conn.execute("SELECT content_status FROM posts WHERE id=?", (post_id,)).fetchone()[0] != "retired"

    # Now posted to B too -> retire.
    conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
                 "VALUES (?,?, '2026-07-02T00:00:00+00:00', 'posted', '2026-07-02T00:00:00+00:00')",
                 (post_id, chan_b))
    conn.commit()
    assert _maybe_retire_one_time(conn, post_id, now) is True
    assert conn.execute("SELECT content_status FROM posts WHERE id=?", (post_id,)).fetchone()[0] == "retired"
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/test_publisher.py::test_one_time_retires_only_after_all_targets_posted -q`
Expected: FAIL with `ImportError: cannot import name '_maybe_retire_one_time'`.

- [ ] **Step 3: Implement it**

In `worker/publisher.py`, add near the other helpers:

```python
def _maybe_retire_one_time(conn, post_id: int, now: datetime) -> bool:
    """Retire a one-time post once EVERY targeted channel has posted it. Returns True if retired."""
    targets = conn.execute(
        "SELECT channel_id FROM post_targets WHERE post_id = ?", (post_id,)
    ).fetchall()
    if not targets:
        return False
    for t in targets:
        done = conn.execute(
            "SELECT 1 FROM publications WHERE post_id = ? AND channel_id = ? "
            "AND status = 'posted' LIMIT 1",
            (post_id, t["channel_id"]),
        ).fetchone()
        if not done:
            return False
    db.update_post(conn, post_id, content_status="retired", updated_at=_iso(now))
    return True
```

If `db.update_post` does not exist, add this to `worker/db.py`:

```python
def update_post(conn, post_id: int, **fields) -> None:
    cols = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE posts SET {cols} WHERE id = ?", (*fields.values(), post_id))
    conn.commit()
```

- [ ] **Step 4: Call it after a successful real publish**

In `worker/publisher.py`, in `publish_one`, right after the block that marks the publication `posted` (the `db.update_publication(... status="posted", remote_post_id=media_id ...)` call near the end), add:

```python
    if post["content_kind"] == "one_time":
        _maybe_retire_one_time(conn, post["id"], now)
```

- [ ] **Step 5: Run the test**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/test_publisher.py -q`
Expected: all pass (new retirement test + existing publisher tests).

- [ ] **Step 6: Commit**

```bash
git add worker/publisher.py worker/db.py worker/tests/test_publisher.py
git commit -m "feat(worker): one-time posts auto-retire after all targets have posted"
```

---

## Task 5: Caption-variant selection in the publisher

**Files:**
- Modify: `worker/publisher.py` (`_select_caption`; use it in `publish_one`/`_build_plan`)
- Test: `worker/tests/test_publisher.py`

**Interfaces:**
- Consumes: `caption_variants(post_id, platform, body, sort_order)`, `posts.caption`, channel platform, prior posted count.
- Produces: `_select_caption(conn, post_id: int, platform: str, used_count: int) -> str | None` — platform-specific variant if any (rotated by `used_count`); else generic variants rotated; else `posts.caption`.

- [ ] **Step 1: Write the failing test**

Add to `worker/tests/test_publisher.py`:

```python
def test_caption_selection_prefers_platform_then_rotates_generic(conn, config, make_publication):
    from worker.publisher import _select_caption
    pub = make_publication(post_type="single", n_assets=1)
    post_id = pub["post_id"]

    # No variants yet -> falls back to posts.caption ('hello world' from the fixture).
    assert _select_caption(conn, post_id, "instagram", 0) == "hello world"

    # Two generic variants -> rotate by used_count.
    conn.executemany(
        "INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?,?,?,?)",
        [(post_id, None, "gen-A", 0), (post_id, None, "gen-B", 1)],
    )
    conn.commit()
    assert _select_caption(conn, post_id, "instagram", 0) == "gen-A"
    assert _select_caption(conn, post_id, "instagram", 1) == "gen-B"
    assert _select_caption(conn, post_id, "instagram", 2) == "gen-A"  # wraps

    # An instagram-specific variant wins over generic.
    conn.execute("INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?,?,?,?)",
                 (post_id, "instagram", "ig-special", 5))
    conn.commit()
    assert _select_caption(conn, post_id, "instagram", 0) == "ig-special"
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/test_publisher.py::test_caption_selection_prefers_platform_then_rotates_generic -q`
Expected: FAIL with `ImportError: cannot import name '_select_caption'`.

- [ ] **Step 3: Implement it**

In `worker/publisher.py`, add:

```python
def _select_caption(conn, post_id: int, platform: str, used_count: int) -> str | None:
    """Platform-specific caption if present (rotated); else generic rotated; else posts.caption."""
    variants = conn.execute(
        "SELECT platform, body FROM caption_variants WHERE post_id = ? ORDER BY sort_order, id",
        (post_id,),
    ).fetchall()
    if variants:
        specific = [v["body"] for v in variants if v["platform"] == platform]
        if specific:
            return specific[used_count % len(specific)]
        generic = [v["body"] for v in variants if v["platform"] is None]
        if generic:
            return generic[used_count % len(generic)]
    post = db.get_post(conn, post_id)
    return post["caption"] if post else None
```

- [ ] **Step 4: Use it when building the publish plan**

In `worker/publisher.py`, change `_build_plan` to accept an explicit caption. Update its signature and the `caption` line:

```python
def _build_plan(channel, post, assets, asset_base_url: str | None, caption: str | None) -> dict:
```

and inside, replace `"caption": post["caption"],` with `"caption": caption,`.

Then in `publish_one`, where the plan is built (the `plan = _build_plan(channel, post, assets, asset_base_url)` call), compute the caption first and pass it:

```python
        used_count = conn.execute(
            "SELECT COUNT(*) FROM publications WHERE post_id=? AND channel_id=? AND status='posted'",
            (pub["post_id"], pub["channel_id"]),
        ).fetchone()[0]
        caption = _select_caption(conn, post["id"], channel["platform"], used_count)
        plan = _build_plan(channel, post, assets, asset_base_url, caption)
```

- [ ] **Step 5: Run the publisher tests**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/test_publisher.py -q`
Expected: all pass. (Existing tests still get `'hello world'` via the fallback.)

- [ ] **Step 6: Run the full suite**

Run: `PYTHONPATH=. .venv/bin/python -m pytest worker/tests/ -q`
Expected: all green (target: ~55 tests).

- [ ] **Step 7: Commit**

```bash
git add worker/publisher.py worker/tests/test_publisher.py
git commit -m "feat(worker): rotate caption variants at publish (platform-specific > generic > fallback)"
```

---

## Self-Review

**Spec coverage** (each spec section → task):
- Schema (columns + 4 tables + backfill) → Task 1. ✓
- Period library math (yearly wrap-around, one-off, tz) → Task 2. ✓
- Eligibility gates (status, targets, green/blackout, cooldown, one-time) → Task 3. ✓
- One-time retirement → Task 4. ✓
- Caption variants (platform-specific + generic rotation + fallback) → Task 5. ✓
- Dynamic-`all` snapshot / bulk re-target / Periods UI / compose UI → **Phase B (out of scope here)**, tracked in `docs/tasks.md`.
- Manual-not-blocked → structural: gates live in `autofill`, not `publish_one`. ✓

**Placeholder scan:** none — every code step shows full code.

**Type consistency:** `select_candidates(conn, channel_id, now)` and `eligible_candidates(conn, channel, now, limit)` are used consistently; `_maybe_retire_one_time(conn, post_id, now)`, `_select_caption(conn, post_id, platform, used_count)`, and `_build_plan(..., caption)` match their call sites.

**Note for the implementer:** verify `db.get_post` and `db.update_publication` exist (they're used already in `publisher.py`); add `db.update_post` in Task 4 only if missing.

---

## Out of scope (Phase B — next plan)

Dashboard: compose fields (kind/status/targeting/periods/captions), a Periods manager, and the library's bulk re-target + content-overview columns. The snapshot-`all` expansion and bulk re-target are UI-layer operations over `post_targets`, designed in Phase B.
