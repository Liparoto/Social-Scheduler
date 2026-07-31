# Channel Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a named set of channels auto-fill as one unit — one cadence, one selection decision, one slot, one publication per member — so an Instagram and a Threads channel representing the same account always post the same content at the same moment.

**Architecture:** A new `channel_groups` table carries the same auto-fill fields a channel already has, plus a nullable `channels.group_id`. `run_autofill` stops iterating channels and iterates *units*: each auto-fill-enabled group is one unit (its active members), each auto-fill-enabled ungrouped channel is one unit of itself. A solo unit runs today's code path unchanged. A group unit intersects eligibility across members — platform *capabilities* let a member sit out a slot, but *rules* (cooldown, blackout, targeting, already-queued) block the whole group.

**Tech Stack:** Python 3.11 + pytest (worker, in `worker/.venv`), plain `.sql` migrations, Next.js App Router + TypeScript + `better-sqlite3` (dashboard), SQLite in WAL mode.

**Spec:** `docs/superpowers/specs/2026-07-30-channel-groups-design.md`

## Global Constraints

- Schema changes go in `/migrations` as plain `.sql` files ONLY. Never define schema inline in TypeScript or Python.
- The Python worker runs in `worker/.venv`. Activate it before running any `pytest` or `pip` command. Never use the system Python.
- The dashboard and the worker never call each other. The SQLite file is the only contract.
- The migration must be **purely additive**. Every existing channel gets `group_id = NULL` and must behave exactly as it does today.
- Never log access tokens, full API responses containing PII, or credentials.
- `requires_approval` stays a **channel** property, never a group property.
- Group ranking uses the **maximum** performance across members, never the sum.
- Caption length is treated as a **capability** (member sits out), not a rule (blocks group).
- Existing worker tests must keep passing at every commit. Baseline before starting:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests -q
```

---

## Task 1: Migration 0013 — `channel_groups` table and `channels.group_id`

**Files:**
- Create: `migrations/0013_channel_groups.sql`
- Test: `worker/tests/test_migration_0013.py`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: table `channel_groups` with columns `id, name, timezone, autofill_enabled, cadence_config, min_queue_depth, target_queue_depth, reuse_min_age_days, is_active, created_at, updated_at`; column `channels.group_id INTEGER NULL REFERENCES channel_groups(id) ON DELETE SET NULL`.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_migration_0013.py`:

```python
"""Migration 0013: channel_groups table + channels.group_id, purely additive."""

from __future__ import annotations

import sqlite3

import pytest


def cols(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def test_channel_groups_table_exists_with_autofill_fields(conn):
    assert cols(conn, "channel_groups") == {
        "id", "name", "timezone", "autofill_enabled", "cadence_config",
        "min_queue_depth", "target_queue_depth", "reuse_min_age_days",
        "is_active", "created_at", "updated_at",
    }


def test_channels_gains_nullable_group_id(conn):
    assert "group_id" in cols(conn, "channels")
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram','Solo')"
    ).lastrowid
    conn.commit()
    row = conn.execute("SELECT group_id FROM channels WHERE id=?", (cid,)).fetchone()
    assert row["group_id"] is None, "existing/new channels must default to ungrouped"


def test_group_name_is_unique(conn):
    conn.execute("INSERT INTO channel_groups (name) VALUES ('Personal')")
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO channel_groups (name) VALUES ('Personal')")


def test_deleting_a_group_ungroups_its_channels_without_touching_publications(conn):
    gid = conn.execute("INSERT INTO channel_groups (name) VALUES ('Personal')").lastrowid
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, group_id) VALUES ('instagram','IG',?)",
        (gid,),
    ).lastrowid
    pid = conn.execute("INSERT INTO posts (caption, post_type) VALUES ('x','single')").lastrowid
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)",
        (pid, cid, "2026-08-01T18:00:00+00:00"),
    )
    conn.commit()

    conn.execute("DELETE FROM channel_groups WHERE id=?", (gid,))
    conn.commit()

    assert conn.execute("SELECT group_id FROM channels WHERE id=?", (cid,)).fetchone()[0] is None
    assert conn.execute("SELECT COUNT(*) FROM channels WHERE id=?", (cid,)).fetchone()[0] == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM publications WHERE channel_id=?", (cid,)
    ).fetchone()[0] == 1, "deleting a group must never cascade into publications"


def test_group_defaults_match_channel_defaults(conn):
    gid = conn.execute("INSERT INTO channel_groups (name) VALUES ('Defaults')").lastrowid
    conn.commit()
    g = conn.execute("SELECT * FROM channel_groups WHERE id=?", (gid,)).fetchone()
    assert g["timezone"] == "UTC"
    assert g["autofill_enabled"] == 0
    assert g["cadence_config"] is None
    assert g["min_queue_depth"] == 0
    assert g["target_queue_depth"] == 0
    assert g["reuse_min_age_days"] == 180
    assert g["is_active"] == 1
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests/test_migration_0013.py -q
```

Expected: FAIL — `sqlite3.OperationalError: no such table: channel_groups`.

The `conn` fixture in `worker/tests/conftest.py` builds a temp DB by running every file in `migrations/` in filename order, so the test picks up the new migration automatically once it exists. No fixture changes are needed.

- [ ] **Step 3: Write the migration**

Create `migrations/0013_channel_groups.sql`:

```sql
-- 0013_channel_groups.sql
-- Coordinated auto-fill: a channel_group is a named set of channels that auto-fills as
-- ONE unit — one cadence, one selection decision, one slot, one publication per member.
-- Without it, auto-fill runs per channel in isolation (worker/autofill.py), so an
-- Instagram channel and a Threads channel representing the same account pick different
-- content on different days.
--
-- The group deliberately repeats the auto-fill field NAMES that already exist on
-- channels (cadence_config, min_queue_depth, target_queue_depth, reuse_min_age_days,
-- timezone, autofill_enabled, is_active). That is not redundancy: it lets
-- parse_weekly_cadence(), weekly_date_slots() and band_times() accept a group row with
-- no modification, so the slot-generation code stays single-source.
--
-- channels.group_id is nullable and defaults to NULL, so every existing channel stays
-- ungrouped and behaves exactly as it does today. While group_id IS NOT NULL a channel's
-- OWN autofill_enabled/cadence_config/queue-depth/reuse columns go unread; clearing
-- group_id makes them authoritative again. Nothing is dropped.
--
-- ON DELETE SET NULL (not CASCADE) is deliberate and is the opposite of what channels'
-- own children use. A group is a scheduling convenience, not an owner of content:
-- deleting one must return its channels to solo operation, never destroy channels or
-- the publications hanging off them.
--
-- Purely additive: no CHECK constraint is involved on channels, so SQLite's
-- ALTER TABLE ... ADD COLUMN is enough and none of the table-rebuild cascade-delete risk
-- that 0008/0009 carried applies here. Same shape as 0010_channel_colour.sql and
-- 0012_channel_avatar.sql.

CREATE TABLE IF NOT EXISTS channel_groups (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  timezone            TEXT NOT NULL DEFAULT 'UTC',
  autofill_enabled    INTEGER NOT NULL DEFAULT 0,
  cadence_config      TEXT,
  min_queue_depth     INTEGER NOT NULL DEFAULT 0,
  target_queue_depth  INTEGER NOT NULL DEFAULT 0,
  reuse_min_age_days  INTEGER NOT NULL DEFAULT 180,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT
);

ALTER TABLE channels ADD COLUMN group_id INTEGER
  REFERENCES channel_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_id);
```

Note for the implementer: SQLite permits `ALTER TABLE ... ADD COLUMN` with a `REFERENCES` clause only when the new column's default is NULL. That is the case here (no `DEFAULT` given), so this is valid.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests/test_migration_0013.py -q
```

Expected: 5 passed.

- [ ] **Step 5: Run the full worker suite to prove nothing regressed**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests -q
```

Expected: all previously passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add migrations/0013_channel_groups.sql worker/tests/test_migration_0013.py
git commit -m "feat(db): add channel_groups table and channels.group_id

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Split capability from rules in `worker/autofill.py`

Today `eligible_candidates` applies capability gates (media type, caption length) and rule gates (cooldown, one-time, periods, targeting, already-queued) together and returns only posts that pass both, so a caller cannot tell *which* gate rejected a post. Groups need that distinction. This task adds a capability-only query and makes the reuse/timezone policy injectable, without changing any existing behaviour.

**Files:**
- Modify: `worker/autofill.py` (extract `_TYPE_CAPABILITY_SQL`; add `capable_post_ids`; add keyword-only overrides to `eligible_candidates`)
- Test: `worker/tests/test_autofill_groups.py` (new file)

**Interfaces:**
- Consumes: `migrations/0013_channel_groups.sql` from Task 1 (not directly, but the test DB includes it).
- Produces:
  - `_TYPE_CAPABILITY_SQL: str` — a SQL boolean fragment referencing `p.post_type`, `:supports_text`, `:supports_video`.
  - `capable_post_ids(conn, channel) -> set[int]` — post ids this channel's platform can physically accept (media type + caption length), ignoring all rules.
  - `eligible_candidates(conn, channel, now, limit, *, reuse_default=None, timezone_name=None) -> list` — unchanged behaviour when the new keywords are omitted; `limit=None` means unlimited.

- [ ] **Step 1: Write the failing test**

Create `worker/tests/test_autofill_groups.py`:

```python
"""Channel groups: capability-vs-rules split, group selection, and group top-up."""

from __future__ import annotations

from datetime import datetime, timezone

from worker.autofill import capable_post_ids, eligible_candidates

NOW = datetime(2026, 7, 22, 18, 0, tzinfo=timezone.utc)


# ---- seed helpers ---------------------------------------------------------------
def make_channel(conn, *, platform="instagram", name="Chan", group_id=None,
                 autofill=0, tz="America/New_York", approval=0,
                 cadence='{"days":["mon","wed","fri"],"time":"18:00"}',
                 min_depth=3, target=5, reuse=180, active=1):
    return conn.execute(
        """INSERT INTO channels
             (platform, account_name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, requires_approval,
              remote_account_id, access_token, group_id, is_active)
           VALUES (?,?,?,?,?,?,?,?,?,'acct1','tok',?,?)""",
        (platform, name, tz, autofill, cadence, min_depth, target, reuse, approval,
         group_id, active),
    ).lastrowid


def make_group(conn, *, name="Personal", autofill=1, tz="America/New_York",
               cadence='{"days":["mon","wed","fri"],"time":"18:00"}',
               min_depth=3, target=5, reuse=180, active=1):
    return conn.execute(
        """INSERT INTO channel_groups
             (name, timezone, autofill_enabled, cadence_config,
              min_queue_depth, target_queue_depth, reuse_min_age_days, is_active)
           VALUES (?,?,?,?,?,?,?,?)""",
        (name, tz, autofill, cadence, min_depth, target, reuse, active),
    ).lastrowid


def make_post(conn, *, post_type="single", caption="x", targets=(),
              created_at="2026-01-01T00:00:00+00:00", content_kind="evergreen",
              media_kind="image"):
    pid = conn.execute(
        "INSERT INTO posts (caption, post_type, status, content_status, content_kind, created_at) "
        "VALUES (?,?,'draft','ready',?,?)",
        (caption, post_type, content_kind, created_at),
    ).lastrowid
    if post_type != "text":
        aid = conn.execute(
            "INSERT INTO assets (content_hash, media_kind, storage_path, public_url) "
            "VALUES (?,?,?,?)",
            (f"h{pid}", media_kind, f"{pid}.bin", "https://a.test/x"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
            (pid, aid),
        )
    for cid in targets:
        conn.execute("INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (pid, cid))
    conn.commit()
    return pid


def ch(conn, channel_id):
    return conn.execute("SELECT * FROM channels WHERE id=?", (channel_id,)).fetchone()


# ---- Task 2: capability vs rules ------------------------------------------------
def test_capable_post_ids_ignores_targeting_and_cooldown(conn):
    """Capability is about the PLATFORM, not the rules. A post nobody targets is still
    'capable' — that is what lets the group logic tell a capability miss apart from a
    rule miss."""
    ig = make_channel(conn, platform="instagram")
    untargeted = make_post(conn, targets=())
    assert untargeted in capable_post_ids(conn, ch(conn, ig))
    assert [r["post_id"] for r in eligible_candidates(conn, ch(conn, ig), NOW, None)] == []


def test_reel_is_capable_for_instagram_but_not_threads(conn):
    ig = make_channel(conn, platform="instagram", name="IG")
    th = make_channel(conn, platform="threads", name="TH")
    reel = make_post(conn, post_type="reel", media_kind="video", targets=(ig, th))
    assert reel in capable_post_ids(conn, ch(conn, ig))
    assert reel not in capable_post_ids(conn, ch(conn, th))


def test_long_caption_is_capable_for_instagram_but_not_threads(conn):
    """Threads caps captions at 500 chars; Instagram at 2200."""
    ig = make_channel(conn, platform="instagram", name="IG")
    th = make_channel(conn, platform="threads", name="TH")
    long_post = make_post(conn, caption="c" * 600, targets=(ig, th))
    assert long_post in capable_post_ids(conn, ch(conn, ig))
    assert long_post not in capable_post_ids(conn, ch(conn, th))


def test_eligible_candidates_accepts_policy_overrides(conn):
    """A group supplies its own reuse_min_age_days and timezone; the member channel's
    values must not be consulted when overrides are passed."""
    ig = make_channel(conn, platform="instagram", reuse=180)
    p = make_post(conn, targets=(ig,))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?,?,'posted',?)",
        (p, ig, "2026-07-01T18:00:00+00:00", "2026-07-01T18:00:00+00:00"),
    )
    conn.commit()

    # 21 days ago. Channel default (180) excludes it; a group override of 7 admits it.
    assert [r["post_id"] for r in eligible_candidates(conn, ch(conn, ig), NOW, None)] == []
    got = eligible_candidates(conn, ch(conn, ig), NOW, None, reuse_default=7)
    assert [r["post_id"] for r in got] == [p]


def test_eligible_candidates_limit_none_means_unlimited(conn):
    ig = make_channel(conn, platform="instagram")
    ids = {make_post(conn, targets=(ig,)) for _ in range(5)}
    got = eligible_candidates(conn, ch(conn, ig), NOW, None)
    assert {r["post_id"] for r in got} == ids
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests/test_autofill_groups.py -q
```

Expected: FAIL — `ImportError: cannot import name 'capable_post_ids' from 'worker.autofill'`.

- [ ] **Step 3: Extract the shared capability SQL fragment**

In `worker/autofill.py`, add this module-level constant just below `ACTIVE_QUEUE_STATUSES` (line 29):

```python
# The media-type capability test, shared by select_candidates (which also applies the
# rules) and capable_post_ids (which applies capability ONLY). Kept in one place so the
# two can never drift: if they did, a group would mistake a capability miss for a rule
# miss and block every member instead of letting one sit the slot out.
# Binds :supports_text and :supports_video; references the `posts p` alias.
_TYPE_CAPABILITY_SQL = """
          (
            (p.post_type IN ('single','carousel')
               AND EXISTS (SELECT 1 FROM post_assets pa WHERE pa.post_id = p.id))
            OR (p.post_type = 'reel' AND :supports_video = 1
               AND EXISTS (SELECT 1 FROM post_assets pa WHERE pa.post_id = p.id))
            OR (p.post_type = 'text' AND :supports_text = 1)
          )
"""


def _platform_capability_params(platform: str | None) -> dict:
    """The :supports_text/:supports_video bindings for a platform. A platform
    PLATFORM_CAPS does not recognize supports neither — the safe direction."""
    caps = PLATFORM_CAPS.get(platform)
    return {
        "supports_text": 1 if caps is not None and caps.supports_text else 0,
        "supports_video": 1 if caps is not None and caps.supports_video else 0,
    }
```

Then in `select_candidates`, replace the inline type test. Change lines 79-86 from:

```python
    platform_row = conn.execute(
        "SELECT platform FROM channels WHERE id = ?", (channel_id,)
    ).fetchone()
    platform = platform_row["platform"] if platform_row else None
    caps = PLATFORM_CAPS.get(platform)
    supports_text = 1 if caps is not None and caps.supports_text else 0
    supports_video = 1 if caps is not None and caps.supports_video else 0
```

to:

```python
    platform_row = conn.execute(
        "SELECT platform FROM channels WHERE id = ?", (channel_id,)
    ).fetchone()
    platform = platform_row["platform"] if platform_row else None
    cap_params = _platform_capability_params(platform)
```

Replace the inline `AND ( ... )` type block in the query (lines 105-111) with `AND {_TYPE_CAPABILITY_SQL}`, and change the parameter dict on line 124 from:

```python
        {"cid": channel_id, "supports_text": supports_text, "supports_video": supports_video},
```

to:

```python
        {"cid": channel_id, **cap_params},
```

- [ ] **Step 4: Add `capable_post_ids`**

Add to `worker/autofill.py`, immediately after `_caption_too_long_for_channel`:

```python
def capable_post_ids(conn, channel) -> set[int]:
    """Post ids this channel's platform can PHYSICALLY accept — media type and caption
    length only. Deliberately ignores every rule (targeting, cooldown, one-time,
    periods, already-queued).

    This exists so channel-group selection can tell the two kinds of rejection apart.
    A capability miss means that member sits the slot out (a Reel still goes to
    Instagram when a Threads member cannot take video); a RULE miss means the group is
    held back so its members never drift apart. Collapsing the two would silently end
    evergreen video recycling for any group containing Threads.
    """
    cap_params = _platform_capability_params(channel["platform"])
    rows = conn.execute(
        f"""
        SELECT p.id AS post_id, p.post_type AS post_type
        FROM posts p
        WHERE p.content_status = 'ready'
          AND {_TYPE_CAPABILITY_SQL}
        """,
        cap_params,
    ).fetchall()
    return {
        r["post_id"]
        for r in rows
        if not _caption_too_long_for_channel(conn, channel, r["post_id"], r["post_type"])
    }
```

- [ ] **Step 5: Make the reuse/timezone policy injectable**

In `worker/autofill.py`, change the `eligible_candidates` signature and its first three lines (172-177) from:

```python
def eligible_candidates(conn, channel, now, limit: int):
    """Apply cooldown, one-time, period, and caption-length gates to the SQL candidates;
    return <= limit."""
    reuse_default = channel["reuse_min_age_days"]
    today_local = local_date(now, channel["timezone"])
    out = []
```

to:

```python
def eligible_candidates(conn, channel, now, limit: int | None, *,
                        reuse_default=None, timezone_name=None):
    """Apply cooldown, one-time, period, and caption-length gates to the SQL candidates;
    return <= limit (or all of them when limit is None).

    reuse_default/timezone_name override the channel's own values. A grouped channel
    takes both from its group, so the group's cadence and cooldown policy govern every
    member; omit them and the channel's own columns are used exactly as before.
    """
    if reuse_default is None:
        reuse_default = channel["reuse_min_age_days"]
    if timezone_name is None:
        timezone_name = channel["timezone"]
    today_local = local_date(now, timezone_name)
    out = []
```

and change the limit check on lines 195-196 from:

```python
        if len(out) >= limit:
            break
```

to:

```python
        if limit is not None and len(out) >= limit:
            break
```

- [ ] **Step 6: Run the new tests to verify they pass**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests/test_autofill_groups.py -q
```

Expected: 5 passed.

- [ ] **Step 7: Run the full suite — the refactor must be behaviour-preserving**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests -q
```

Expected: all pass, including every existing test in `worker/tests/test_autofill.py`. If any existing auto-fill test fails, the extraction changed behaviour — fix the extraction, do not edit the existing test.

- [ ] **Step 8: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill_groups.py
git commit -m "refactor(autofill): split platform capability from selection rules

Adds capable_post_ids() and makes eligible_candidates() accept reuse/timezone
overrides so a group can impose its own policy on members. Behaviour-preserving.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Group selection — intersection and group-level ranking

The heart of the feature. Given a group and its members, produce a ranked list of `(candidate_row, [member channels that should receive it])`.

**Files:**
- Modify: `worker/autofill.py`
- Test: `worker/tests/test_autofill_groups.py`

**Interfaces:**
- Consumes: `capable_post_ids(conn, channel)`, `eligible_candidates(conn, channel, now, limit, *, reuse_default, timezone_name)` from Task 2.
- Produces:
  - `group_rank(conn, member_ids: list[int], post_ids: set[int]) -> list` — rows with `post_id`, `post_type`, `last_posted`, `perf`, ordered by the group tiering.
  - `group_eligible_candidates(conn, group, members, now, limit) -> list[tuple]` — list of `(row, [channel rows])`, longest-first by group rank, at most `limit` entries.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_autofill_groups.py`:

```python
# ---- Task 3: group selection ----------------------------------------------------
from worker.autofill import group_eligible_candidates  # noqa: E402


def grp(conn, group_id):
    return conn.execute("SELECT * FROM channel_groups WHERE id=?", (group_id,)).fetchone()


def members(conn, group_id):
    return conn.execute(
        "SELECT * FROM channels WHERE group_id=? AND is_active=1 ORDER BY id", (group_id,)
    ).fetchall()


def pair(conn, **kw):
    """A group with an Instagram and a Threads member. Returns (gid, ig_id, th_id)."""
    gid = make_group(conn, **kw)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid)
    th = make_channel(conn, platform="threads", name="TH", group_id=gid)
    return gid, ig, th


def picked(conn, gid, limit=10):
    got = group_eligible_candidates(conn, grp(conn, gid), members(conn, gid), NOW, limit)
    return [(r["post_id"], sorted(m["id"] for m in ms)) for r, ms in got]


def test_image_targeted_at_both_goes_to_both(conn):
    gid, ig, th = pair(conn)
    p = make_post(conn, targets=(ig, th))
    assert picked(conn, gid) == [(p, sorted([ig, th]))]


def test_reel_goes_to_instagram_only_capability_is_an_exception(conn):
    """Threads declares supports_video=False. The Reel must still queue to Instagram —
    this is the rule that keeps evergreen video recycling alive."""
    gid, ig, th = pair(conn)
    reel = make_post(conn, post_type="reel", media_kind="video", targets=(ig, th))
    assert picked(conn, gid) == [(reel, [ig])]


def test_long_caption_goes_to_instagram_only(conn):
    gid, ig, th = pair(conn)
    long_post = make_post(conn, caption="c" * 600, targets=(ig, th))
    assert picked(conn, gid) == [(long_post, [ig])]


def test_cooldown_on_one_member_blocks_the_whole_group(conn):
    """A RULE miss, unlike a capability miss, holds every member back so the accounts
    never drift apart."""
    gid, ig, th = pair(conn, reuse=180)
    p = make_post(conn, targets=(ig, th))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
        "VALUES (?,?,?,'posted',?)",
        (p, th, "2026-07-01T18:00:00+00:00", "2026-07-01T18:00:00+00:00"),
    )
    conn.commit()
    assert picked(conn, gid) == []


def test_post_targeted_at_only_one_member_is_never_selected(conn):
    gid, ig, th = pair(conn)
    only_ig = make_post(conn, targets=(ig,))
    assert picked(conn, gid) == []


def test_already_queued_on_one_member_blocks_the_group(conn):
    gid, ig, th = pair(conn)
    p = make_post(conn, targets=(ig, th))
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status) "
        "VALUES (?,?,?,'scheduled')",
        (p, ig, "2026-08-01T18:00:00+00:00"),
    )
    conn.commit()
    assert picked(conn, gid) == []


def test_blackout_on_the_group_timezone_blocks_the_group(conn):
    gid, ig, th = pair(conn)
    p = make_post(conn, targets=(ig, th))
    # NOTE: the column is recurs_yearly (1/0), not `kind` — see migrations/0002.
    period_id = conn.execute(
        "INSERT INTO periods (name, recurs_yearly, start_month, start_day, end_month, end_day) "
        "VALUES ('Summer',1,7,1,8,31)"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?,'blackout')",
        (p, period_id),
    )
    conn.commit()
    assert picked(conn, gid) == []


def test_group_ranking_prefers_never_posted_then_best_member_not_the_sum(conn):
    """perf is the MAX across members, never the sum: Threads reports no reach/saves,
    so summing would halve every score and scramble Instagram's real ordering."""
    gid, ig, th = pair(conn)
    weak = make_post(conn, targets=(ig, th), created_at="2026-01-01T00:00:00+00:00")
    strong = make_post(conn, targets=(ig, th), created_at="2026-01-02T00:00:00+00:00")
    for pid, reach in ((weak, 10), (strong, 900)):
        pub = conn.execute(
            "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at) "
            "VALUES (?,?,?,'posted',?)",
            (pid, ig, "2026-01-10T18:00:00+00:00", "2026-01-10T18:00:00+00:00"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_metrics (publication_id, reach, saves) VALUES (?,?,0)",
            (pub, reach),
        )
    fresh = make_post(conn, targets=(ig, th), created_at="2026-01-03T00:00:00+00:00")
    conn.commit()

    order = [pid for pid, _ in picked(conn, gid)]
    assert order[0] == fresh, "never-posted-on-any-member ranks first"
    assert order[1:] == [strong, weak], "then best member's performance, descending"


def test_group_selection_respects_limit(conn):
    gid, ig, th = pair(conn)
    for _ in range(5):
        make_post(conn, targets=(ig, th))
    assert len(picked(conn, gid, limit=2)) == 2


def test_group_with_no_active_members_selects_nothing(conn):
    gid = make_group(conn)
    assert group_eligible_candidates(conn, grp(conn, gid), [], NOW, 5) == []
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests/test_autofill_groups.py -q
```

Expected: FAIL — `ImportError: cannot import name 'group_eligible_candidates'`.

- [ ] **Step 3: Implement `group_rank`**

Add to `worker/autofill.py`, after `eligible_candidates`:

```python
def group_rank(conn, member_ids: list[int], post_ids) -> list:
    """Order `post_ids` by the group's tiering: never posted on ANY member first, then
    the BEST member's performance descending, then stalest, then oldest content.

    perf is MAX across members rather than SUM on purpose. Threads reports neither reach
    nor saves, so its contribution is always 0; summing would halve every score the
    moment a Threads member joined a group and scramble an ordering that is driven
    entirely by Instagram's real numbers. MAX means "how well did this do on its best
    member", which is the question the ranking is actually asking.
    """
    post_ids = list(post_ids)
    if not post_ids or not member_ids:
        return []
    mq = ",".join("?" * len(member_ids))
    pq = ",".join("?" * len(post_ids))
    return conn.execute(
        f"""
        SELECT
          p.id AS post_id,
          p.post_type AS post_type,
          (SELECT MAX(pub.published_at) FROM publications pub
             WHERE pub.post_id = p.id AND pub.channel_id IN ({mq})
               AND pub.status = 'posted' AND pub.is_dry_run = 0
          ) AS last_posted,
          (SELECT COALESCE(MAX(IFNULL(pm.reach,0) + IFNULL(pm.saves,0)), 0)
             FROM post_metrics pm
             JOIN publications p3 ON p3.id = pm.publication_id
             WHERE p3.post_id = p.id AND p3.channel_id IN ({mq})
          ) AS perf
        FROM posts p
        WHERE p.id IN ({pq})
        ORDER BY
          CASE WHEN last_posted IS NULL THEN 0 ELSE 1 END ASC,
          perf DESC,
          last_posted ASC,
          p.created_at ASC
        """,
        (*member_ids, *member_ids, *post_ids),
    ).fetchall()
```

- [ ] **Step 4: Implement `group_eligible_candidates`**

Add to `worker/autofill.py`, directly after `group_rank`:

```python
def group_eligible_candidates(conn, group, members, now, limit: int | None):
    """Ranked (candidate_row, [member channels to receive it]) for a channel group.

    A post P is group-eligible when BOTH hold:
      1. at least one member is capable AND allowed, and
      2. every member that is CAPABLE is also ALLOWED.

    "Capable" is the platform question (media type, caption length); "allowed" is the
    rules question (targeting, content_status, cooldown, one-time, periods, already
    queued). The asymmetry is the whole design: a member that physically cannot take
    the content sits the slot out, but a member held back by a RULE stops everyone, so
    the accounts never drift apart on content they could both have had.

    Every member is evaluated under the GROUP's reuse_min_age_days and timezone, not
    its own — the group owns the cadence policy.
    """
    if not members:
        return []

    reuse_default = group["reuse_min_age_days"]
    tz_name = group["timezone"]

    capable: dict[int, set[int]] = {}
    allowed: dict[int, set[int]] = {}
    for m in members:
        capable[m["id"]] = capable_post_ids(conn, m)
        allowed[m["id"]] = {
            r["post_id"]
            for r in eligible_candidates(
                conn, m, now, None, reuse_default=reuse_default, timezone_name=tz_name
            )
        }

    # A post that is capable for a member but NOT allowed for it failed a rule — the
    # capability sets are what make that inference sound.
    recipients: dict[int, list] = {}
    for pid in set().union(*capable.values()):
        capable_members = [m for m in members if pid in capable[m["id"]]]
        if not capable_members:
            continue
        if all(pid in allowed[m["id"]] for m in capable_members):
            recipients[pid] = capable_members

    ranked = group_rank(conn, [m["id"] for m in members], recipients.keys())
    out = [(row, recipients[row["post_id"]]) for row in ranked]
    return out if limit is None else out[:limit]
```

- [ ] **Step 5: Run the new tests to verify they pass**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests/test_autofill_groups.py -q
```

Expected: 15 passed (5 from Task 2 + 10 new).

- [ ] **Step 6: Run the full suite**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests -q
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill_groups.py
git commit -m "feat(autofill): group selection with capability/rule intersection

Rules (cooldown, blackout, targeting, already-queued) block the whole group;
platform capabilities only make that member sit the slot out. Group ranking
uses the best member's performance, never the sum.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: `run_autofill` iterates units instead of channels

**Files:**
- Modify: `worker/autofill.py` (module docstring, `run_autofill`, add `_autofill_units`, `group_scheduled_ahead_count`, `group_latest_future_scheduled`, `_fill_unit`)
- Test: `worker/tests/test_autofill_groups.py`

**Interfaces:**
- Consumes: `group_eligible_candidates` and `eligible_candidates` from Tasks 2-3.
- Produces: `run_autofill(conn, config, now, logger=None) -> int` with unchanged signature — `worker/run.py:65-68` needs no edit.

- [ ] **Step 1: Write the failing test**

Append to `worker/tests/test_autofill_groups.py`:

```python
# ---- Task 4: group top-up -------------------------------------------------------
from worker.autofill import run_autofill  # noqa: E402


def pubs(conn, channel_id):
    return conn.execute(
        "SELECT * FROM publications WHERE channel_id=? ORDER BY scheduled_at", (channel_id,)
    ).fetchall()


def test_group_queues_both_members_at_the_identical_timestamp(conn, config):
    gid, ig, th = pair(conn, min_depth=2, target=2)
    for _ in range(3):
        make_post(conn, targets=(ig, th))

    made = run_autofill(conn, config, NOW)

    ig_rows, th_rows = pubs(conn, ig), pubs(conn, th)
    assert len(ig_rows) == 2 and len(th_rows) == 2
    assert made == 4, "two slots x two members"
    assert [r["scheduled_at"] for r in ig_rows] == [r["scheduled_at"] for r in th_rows]
    assert [r["post_id"] for r in ig_rows] == [r["post_id"] for r in th_rows]
    assert all(r["created_by"] == "autofill" for r in ig_rows + th_rows)


def test_group_queue_depth_counts_slots_not_rows(conn, config):
    """A 2-member group writes 2 rows per slot. Counting rows would report the queue as
    twice as full as it is and stop refilling at half the target."""
    gid, ig, th = pair(conn, min_depth=3, target=3)
    for _ in range(5):
        make_post(conn, targets=(ig, th))

    run_autofill(conn, config, NOW)

    ig_rows = pubs(conn, ig)
    assert len(ig_rows) == 3, "3 slots, not 1 or 2"
    assert len({r["scheduled_at"] for r in ig_rows}) == 3


def test_group_reel_queues_instagram_only_and_does_not_stall_the_slot(conn, config):
    gid, ig, th = pair(conn, min_depth=1, target=1)
    reel = make_post(conn, post_type="reel", media_kind="video", targets=(ig, th))

    run_autofill(conn, config, NOW)

    assert [r["post_id"] for r in pubs(conn, ig)] == [reel]
    assert pubs(conn, th) == []


def test_group_honours_each_members_own_requires_approval(conn, config):
    gid = make_group(conn, min_depth=1, target=1)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid, approval=0)
    th = make_channel(conn, platform="threads", name="TH", group_id=gid, approval=1)
    make_post(conn, targets=(ig, th))

    run_autofill(conn, config, NOW)

    assert pubs(conn, ig)[0]["status"] == "scheduled"
    assert pubs(conn, th)[0]["status"] == "pending_approval"


def test_inactive_member_is_excluded_from_the_group(conn, config):
    gid = make_group(conn, min_depth=1, target=1)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid)
    th = make_channel(conn, platform="threads", name="TH", group_id=gid, active=0)
    p = make_post(conn, targets=(ig,))  # targeted at the ACTIVE member only

    run_autofill(conn, config, NOW)

    assert [r["post_id"] for r in pubs(conn, ig)] == [p]
    assert pubs(conn, th) == []


def test_grouped_channel_is_not_also_filled_as_a_solo_unit(conn, config):
    """A grouped channel's own autofill_enabled must go unread — otherwise it would be
    topped up twice per cycle, once by the group and once by itself."""
    gid = make_group(conn, min_depth=1, target=1)
    ig = make_channel(conn, platform="instagram", name="IG", group_id=gid, autofill=1)
    th = make_channel(conn, platform="threads", name="TH", group_id=gid, autofill=1)
    make_post(conn, targets=(ig, th))

    run_autofill(conn, config, NOW)

    assert len(pubs(conn, ig)) == 1


def test_disabled_group_fills_nothing(conn, config):
    gid, ig, th = pair(conn, autofill=0)
    make_post(conn, targets=(ig, th))
    assert run_autofill(conn, config, NOW) == 0


def test_ungrouped_channel_still_fills_on_its_own_settings(conn, config):
    """Regression guard: solo behaviour must be untouched by the unit refactor."""
    solo = make_channel(conn, platform="instagram", name="Solo", autofill=1,
                        min_depth=2, target=2)
    for _ in range(3):
        make_post(conn, targets=(solo,))

    assert run_autofill(conn, config, NOW) == 2
    assert len(pubs(conn, solo)) == 2
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests/test_autofill_groups.py -q
```

Expected: FAIL — groups are ignored, so `pubs(conn, ig)` comes back empty.

- [ ] **Step 3: Add the group queue-depth helpers**

Add to `worker/autofill.py`, immediately after `latest_future_scheduled` (line 56):

```python
def group_scheduled_ahead_count(conn, member_ids: list[int], now_iso: str) -> int:
    """How many future SLOTS a group has queued — distinct scheduled_at values across
    its members, not a row count.

    A group writes one row per member at a single timestamp, so counting rows would
    report a two-member group as twice as full as it is and stop refilling at half the
    target. Solo channels keep using scheduled_ahead_count (a plain row count) so their
    behaviour is byte-identical to before groups existed.
    """
    if not member_ids:
        return 0
    mq = ",".join("?" * len(member_ids))
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT COUNT(DISTINCT scheduled_at) FROM publications
        WHERE channel_id IN ({mq})
          AND status IN ({sq})
          AND scheduled_at > ?
        """,
        (*member_ids, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0]


def group_latest_future_scheduled(conn, member_ids: list[int], now_iso: str) -> str | None:
    if not member_ids:
        return None
    mq = ",".join("?" * len(member_ids))
    sq = ",".join("?" * len(ACTIVE_QUEUE_STATUSES))
    row = conn.execute(
        f"""
        SELECT MAX(scheduled_at) FROM publications
        WHERE channel_id IN ({mq})
          AND status IN ({sq})
          AND scheduled_at > ?
        """,
        (*member_ids, *ACTIVE_QUEUE_STATUSES, now_iso),
    ).fetchone()
    return row[0]
```

- [ ] **Step 4: Replace `run_autofill` with the unit-based version**

In `worker/autofill.py`, add `from dataclasses import dataclass` to the imports at the top (after `import json`, line 18), then replace the whole of `run_autofill` (lines 200-262) with:

```python
@dataclass
class AutofillUnit:
    """One thing auto-fill tops up. A channel_group with its active members, or a single
    ungrouped channel standing alone. `settings` carries cadence_config, timezone,
    min/target_queue_depth and reuse_min_age_days — the group and the channel share those
    column names precisely so this stays one code path."""

    label: str
    settings: object
    members: list
    is_group: bool


def _autofill_units(conn) -> list[AutofillUnit]:
    """Groups first, then ungrouped channels. A channel with group_id set is NEVER also
    returned as a solo unit, so it can't be topped up twice in one cycle."""
    units: list[AutofillUnit] = []
    for g in conn.execute(
        "SELECT * FROM channel_groups WHERE is_active = 1 AND autofill_enabled = 1"
    ).fetchall():
        members = conn.execute(
            "SELECT * FROM channels WHERE group_id = ? AND is_active = 1 ORDER BY id",
            (g["id"],),
        ).fetchall()
        units.append(AutofillUnit(g["name"], g, list(members), True))
    for ch in conn.execute(
        """SELECT * FROM channels
            WHERE is_active = 1 AND autofill_enabled = 1 AND group_id IS NULL"""
    ).fetchall():
        units.append(AutofillUnit(ch["account_name"], ch, [ch], False))
    return units


def _fill_unit(conn, unit: AutofillUnit, config: Config, now, now_iso: str, logger) -> int:
    """Top up one unit. Returns the number of publications created."""
    if unit.is_group and not unit.members:
        if logger:
            logger.info("[autofill %s] group has no active members — skipping", unit.label)
        return 0

    settings = unit.settings
    cadence = parse_weekly_cadence(settings["cadence_config"])
    if cadence is None:
        if logger:
            logger.info("[autofill %s] no valid cadence — skipping", unit.label)
        return 0

    member_ids = [m["id"] for m in unit.members]
    if unit.is_group:
        ahead = group_scheduled_ahead_count(conn, member_ids, now_iso)
        last_future = group_latest_future_scheduled(conn, member_ids, now_iso)
    else:
        ahead = scheduled_ahead_count(conn, member_ids[0], now_iso)
        last_future = latest_future_scheduled(conn, member_ids[0], now_iso)

    if ahead >= settings["min_queue_depth"]:
        return 0  # queue is healthy
    need = settings["target_queue_depth"] - ahead
    if need <= 0:
        return 0

    if unit.is_group:
        candidates = group_eligible_candidates(conn, settings, unit.members, now, need)
    else:
        ch = unit.members[0]
        candidates = [(r, [ch]) for r in eligible_candidates(conn, ch, now, need)]

    if not candidates:
        if logger:
            logger.info(
                "[autofill %s] queue low (%d/%d) but no eligible content",
                unit.label, ahead, settings["min_queue_depth"],
            )
        return 0

    weekdays, hour, minute = cadence
    cadence_hm = (hour, minute)
    bt_map = band_times(config)
    after = parse_iso(last_future) if last_future else now
    # Each candidate's slot TIME comes from its time_of_day tag; the cadence still
    # supplies which DAYS (one auto-post per active day).
    per_candidate_times = [
        resolve_slot_time(post_bands(conn, row["post_id"]), bt_map, cadence_hm)
        for row, _ in candidates
    ]
    slots = weekly_date_slots(weekdays, settings["timezone"], after, per_candidate_times)

    made = 0
    for (row, recipients), slot in zip(candidates, slots):
        for member in recipients:
            # requires_approval stays a CHANNEL property — it describes the account, not
            # the schedule, so one member of a group may need approval and another not.
            status = "pending_approval" if member["requires_approval"] else "scheduled"
            conn.execute(
                """INSERT INTO publications
                     (post_id, channel_id, scheduled_at, status, created_by)
                   VALUES (?, ?, ?, ?, 'autofill')""",
                (row["post_id"], member["id"], slot.isoformat(), status),
            )
            made += 1
    conn.commit()
    if logger and made:
        logger.info(
            "[autofill %s] queue %d/%d -> added %d publication(s) across %d channel(s) "
            "(target %d)",
            unit.label, ahead, settings["min_queue_depth"], made, len(unit.members),
            settings["target_queue_depth"],
        )
    return made


def run_autofill(conn, config: Config, now, logger=None) -> int:
    """Top up every auto-fill-enabled unit. Returns total publications created."""
    now_iso = now.isoformat()
    return sum(
        _fill_unit(conn, unit, config, now, now_iso, logger)
        for unit in _autofill_units(conn)
    )
```

- [ ] **Step 5: Update the module docstring**

Replace lines 1-14 of `worker/autofill.py` with:

```python
"""Auto-fill: keep each unit's queue topped up.

A UNIT is either a single ungrouped channel or a channel_group with its active members.
A group fills as one thing — one cadence, one selection decision, one slot, one
publication per member — so channels representing the same account never drift apart.

Selection rules (evaluated against the unit's settings):

  1. Never posted to this unit yet.
  2. Not posted within reuse_min_age_days (recyclable by age).
     - content posted MORE recently than that is excluded entirely.
  3. Among the recyclable pool, prefer top performers (reach + saves).

Realized as one ranking: tier gate (0 = never, 1 = recyclable) then performance desc,
then staleness, then age of the content. This captures all three rules coherently and
is testable tier-by-tier.

For a GROUP, performance is the MAX across members and "never posted" means never on any
member. Two kinds of rejection are distinguished: a platform CAPABILITY miss (media type,
caption length) lets that member sit the slot out, while a RULE miss (targeting, cooldown,
one-time, periods, already queued) holds the whole group back. See
group_eligible_candidates.
"""
```

- [ ] **Step 6: Run the new tests to verify they pass**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests/test_autofill_groups.py -q
```

Expected: 23 passed.

- [ ] **Step 7: Run the full suite — solo behaviour must be unchanged**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m pytest worker/tests -q
```

Expected: all pass. `worker/tests/test_autofill.py` exercises the solo path end to end; if any of it fails the refactor changed solo behaviour, which the spec forbids.

- [ ] **Step 8: Commit**

```bash
git add worker/autofill.py worker/tests/test_autofill_groups.py
git commit -m "feat(autofill): fill units (groups or solo channels) instead of channels

run_autofill now iterates AutofillUnits. A group fills as one thing: one cadence,
one selection, one slot, one publication per member, with queue depth counted in
distinct slots rather than rows. Solo channels take the unchanged code path.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Dashboard data layer — types and queries

**Files:**
- Modify: `dashboard/lib/types.ts` (add `ChannelGroup`; add `group_id` to `Channel`)
- Modify: `dashboard/lib/queries.ts` (new `// ---- Channel groups ----` section after the Channels block, which ends near line 196)
- Test: `dashboard/lib/queries.groups.test.ts` (new file)

**Interfaces:**
- Consumes: `migrations/0013_channel_groups.sql` from Task 1; `getDb()`/`nowIso()` from `dashboard/lib/db.ts`.
- Produces:
  - `interface ChannelGroup` — `id, name, timezone, autofill_enabled, cadence_config, min_queue_depth, target_queue_depth, reuse_min_age_days, is_active, created_at, updated_at`
  - `listChannelGroups(): ChannelGroup[]`
  - `getChannelGroup(id: number): ChannelGroup | undefined`
  - `createChannelGroup(input: { name: string; timezone: string }): number`
  - `updateChannelGroup(id: number, fields: Partial<{...}>): void`
  - `deleteChannelGroup(id: number): boolean`
  - `setChannelGroup(channelId: number, groupId: number | null): void`
  - `getGroupMembers(groupId: number): Channel[]`
  - `changeChannelGroupTimezone(groupId, fromTz, toTz, rebase): { moved: number }`

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/queries.groups.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";
import { rebaseWallClock } from "./time.ts";

// See queries.merge.test.ts: node --test gives each FILE its own process, but lib/db.ts
// memoises its connection, so every setup() in this file shares the first temp DB. Hence
// the per-setup prefix to keep fixtures from colliding.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  return { q, db, prefix: `t${++setupSeq}` };
}

test("create, list, get and update a channel group", async () => {
  const { q, prefix } = await setup();
  const id = q.createChannelGroup({ name: `${prefix}-Personal`, timezone: "America/New_York" });

  const got = q.getChannelGroup(id);
  assert.equal(got?.name, `${prefix}-Personal`);
  assert.equal(got?.timezone, "America/New_York");
  assert.equal(got?.autofill_enabled, 0);
  assert.equal(got?.reuse_min_age_days, 180);

  q.updateChannelGroup(id, {
    autofill_enabled: 1,
    cadence_config: JSON.stringify({ days: ["mon", "thu"], time: "18:00" }),
    min_queue_depth: 3,
    target_queue_depth: 5,
  });
  const after = q.getChannelGroup(id);
  assert.equal(after?.autofill_enabled, 1);
  assert.equal(after?.min_queue_depth, 3);
  assert.ok(q.listChannelGroups().some((g) => g.id === id));
});

test("assigning and clearing a channel's group", async () => {
  const { q, prefix } = await setup();
  const gid = q.createChannelGroup({ name: `${prefix}-G`, timezone: "UTC" });
  const cid = q.createChannel({
    platform: "instagram",
    account_name: `${prefix}-ig`,
    timezone: "UTC",
  } as Parameters<typeof q.createChannel>[0]);

  q.setChannelGroup(cid, gid);
  assert.equal(q.getChannel(cid)?.group_id, gid);
  assert.deepEqual(q.getGroupMembers(gid).map((c) => c.id), [cid]);

  q.setChannelGroup(cid, null);
  assert.equal(q.getChannel(cid)?.group_id, null);
  assert.deepEqual(q.getGroupMembers(gid), []);
});

test("deleting a group ungroups its channels and keeps their publications", async () => {
  const { q, db, prefix } = await setup();
  const gid = q.createChannelGroup({ name: `${prefix}-Doomed`, timezone: "UTC" });
  const cid = q.createChannel({
    platform: "instagram",
    account_name: `${prefix}-ig`,
    timezone: "UTC",
  } as Parameters<typeof q.createChannel>[0]);
  q.setChannelGroup(cid, gid);

  const assetId = Number(
    db
      .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)")
      .run(`${prefix}-hash`, `a/${prefix}.jpg`).lastInsertRowid
  );
  const postId = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [assetId] });
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)"
  ).run(postId, cid, "2026-08-01T18:00:00.000Z");

  assert.equal(q.deleteChannelGroup(gid), true);
  assert.equal(q.getChannelGroup(gid), undefined);
  assert.equal(q.getChannel(cid)?.group_id, null);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE channel_id = ?").get(cid) as { n: number }).n,
    1
  );
  assert.equal(q.deleteChannelGroup(gid), false, "second delete reports not found");
});

test("changing a group's timezone rebases every member's pending sends", async () => {
  const { q, db, prefix } = await setup();
  const gid = q.createChannelGroup({ name: `${prefix}-TZ`, timezone: "America/New_York" });
  const a = q.createChannel({
    platform: "instagram", account_name: `${prefix}-a`, timezone: "America/New_York",
  } as Parameters<typeof q.createChannel>[0]);
  const b = q.createChannel({
    platform: "threads", account_name: `${prefix}-b`, timezone: "America/New_York",
  } as Parameters<typeof q.createChannel>[0]);
  q.setChannelGroup(a, gid);
  q.setChannelGroup(b, gid);

  const assetId = Number(
    db
      .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)")
      .run(`${prefix}-hash`, `a/${prefix}.jpg`).lastInsertRowid
  );
  const postId = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [assetId] });
  // 18:00 America/New_York on 2026-08-01 == 22:00Z
  for (const cid of [a, b]) {
    db.prepare(
      "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?,?,?, 'scheduled')"
    ).run(postId, cid, "2026-08-01T22:00:00.000Z");
  }

  const { moved } = q.changeChannelGroupTimezone(gid, "America/New_York", "America/Los_Angeles", rebaseWallClock);

  assert.equal(moved, 2, "both members' sends move");
  assert.equal(q.getChannelGroup(gid)?.timezone, "America/Los_Angeles");
  const rows = db
    .prepare("SELECT scheduled_at FROM publications WHERE channel_id IN (?,?) ORDER BY id")
    .all(a, b) as { scheduled_at: string }[];
  // 18:00 Los Angeles on 2026-08-01 == 01:00Z the next day.
  assert.equal(rows[0].scheduled_at, "2026-08-02T01:00:00.000Z");
  assert.equal(rows[1].scheduled_at, rows[0].scheduled_at, "members stay in lockstep");
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npm test
```

Expected: FAIL — `q.createChannelGroup is not a function`.

- [ ] **Step 3: Add the types**

In `dashboard/lib/types.ts`, add `group_id: number | null;` to the `Channel` interface (after `is_active: number;`), and add this interface below it:

```ts
/** A named set of channels that auto-fills as ONE unit — one cadence, one selection
 *  decision, one slot, one publication per member. Carries the same auto-fill field
 *  names a Channel does; while a channel's group_id is set, its own copies go unread. */
export interface ChannelGroup {
  id: number;
  name: string;
  timezone: string;
  autofill_enabled: number;
  cadence_config: string | null;
  min_queue_depth: number;
  target_queue_depth: number;
  reuse_min_age_days: number;
  is_active: number;
  created_at: string;
  updated_at: string | null;
}
```

- [ ] **Step 4: Add the queries**

In `dashboard/lib/queries.ts`, import `ChannelGroup` alongside `Channel` in the existing type import, then add this section immediately after the Channels block:

```ts
// ---- Channel groups ---------------------------------------------------------------

export function listChannelGroups(): ChannelGroup[] {
  return getDb()
    .prepare("SELECT * FROM channel_groups ORDER BY name COLLATE NOCASE")
    .all() as ChannelGroup[];
}

export function getChannelGroup(id: number): ChannelGroup | undefined {
  return getDb().prepare("SELECT * FROM channel_groups WHERE id = ?").get(id) as
    | ChannelGroup
    | undefined;
}

export function getGroupMembers(groupId: number): Channel[] {
  return getDb()
    .prepare("SELECT * FROM channels WHERE group_id = ? ORDER BY id")
    .all(groupId) as Channel[];
}

export function createChannelGroup(input: { name: string; timezone: string }): number {
  const info = getDb()
    .prepare("INSERT INTO channel_groups (name, timezone) VALUES (@name, @timezone)")
    .run({ name: input.name, timezone: input.timezone });
  return Number(info.lastInsertRowid);
}

export function updateChannelGroup(
  id: number,
  fields: Partial<{
    name: string;
    // NOTE: `timezone` is deliberately absent, exactly as on updateChannel(). It moves
    // through changeChannelGroupTimezone() below, which also rebases every member's
    // pending queue — routing it through here would silently skip that.
    autofill_enabled: number;
    cadence_config: string | null;
    min_queue_depth: number;
    target_queue_depth: number;
    reuse_min_age_days: number;
    is_active: number;
  }>
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE channel_groups SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: nowIso() });
}

/** Delete a group. Members are returned to solo auto-fill by the migration's
 *  ON DELETE SET NULL — their publications are never touched. */
export function deleteChannelGroup(id: number): boolean {
  const info = getDb().prepare("DELETE FROM channel_groups WHERE id = ?").run(id);
  return info.changes > 0;
}

export function setChannelGroup(channelId: number, groupId: number | null): void {
  getDb()
    .prepare("UPDATE channels SET group_id = @gid, updated_at = @now WHERE id = @id")
    .run({ gid: groupId, now: nowIso(), id: channelId });
}

/**
 * Change a group's timezone, keeping every member's pending sends at the same WALL
 * CLOCK time. Same contract as changeChannelTimezone(), widened to every member: the
 * group owns the cadence, so its members must move together or they stop mirroring.
 * One transaction for the same reason — a crash between the two writes would leave the
 * group on a new zone while its sends held instants computed for the old one.
 */
export function changeChannelGroupTimezone(
  groupId: number,
  fromTz: string,
  toTz: string,
  rebase: (iso: string, fromTz: string, toTz: string) => string
): { moved: number } {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("UPDATE channel_groups SET timezone = @tz, updated_at = @now WHERE id = @id").run({
      tz: toTz,
      now: nowIso(),
      id: groupId,
    });
    if (fromTz === toTz) return { moved: 0 };

    const move = db.prepare(
      "UPDATE publications SET scheduled_at = @at, updated_at = @now WHERE id = @id"
    );
    let moved = 0;
    for (const member of getGroupMembers(groupId)) {
      for (const p of getPendingPublicationsForChannel(member.id)) {
        const next = rebase(p.scheduled_at, fromTz, toTz);
        if (next === p.scheduled_at) continue; // zone changed, this instant didn't
        move.run({ at: next, now: nowIso(), id: p.id });
        moved += 1;
      }
    }
    return { moved };
  });
  return tx();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npm test
```

Expected: all pass, including the 4 new group tests.

- [ ] **Step 6: Typecheck**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add dashboard/lib/types.ts dashboard/lib/queries.ts dashboard/lib/queries.groups.test.ts
git commit -m "feat(dashboard): channel group types and queries

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Dashboard API routes

**Files:**
- Create: `dashboard/app/api/channel-groups/route.ts` (GET list, POST create)
- Create: `dashboard/app/api/channel-groups/[id]/route.ts` (PATCH, DELETE)
- Create: `dashboard/app/api/channel-groups/[id]/timezone/route.ts` (POST preview/apply)
- Modify: `dashboard/app/api/channels/[id]/route.ts` (accept `group_id`)

**Interfaces:**
- Consumes: every query from Task 5.
- Produces: `GET /api/channel-groups` → `{ groups }`; `POST /api/channel-groups` → `201 { id }`; `PATCH|DELETE /api/channel-groups/[id]` → `{ ok: true }`; `POST /api/channel-groups/[id]/timezone` → preview `{ ok, from, to, unchanged, sends }` or applied `{ ok, from, to, moved }`; `PATCH /api/channels/[id]` accepts `group_id: number | null`.

House style to match exactly (from `dashboard/app/api/periods/`): `export const runtime = "nodejs";` at the top of every route; `{ params }: { params: Promise<{ id: string }> }` with `await params`; full-sentence, period-terminated error strings; `201 { id }` on create; `{ ok: true }` on mutate/delete.

- [ ] **Step 1: Create the collection route**

Create `dashboard/app/api/channel-groups/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createChannelGroup, listChannelGroups } from "@/lib/queries";
import { isValidTimezone } from "@/lib/timezones";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({ groups: listChannelGroups() });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const name = (body.name || "").trim();
  if (!name) {
    return NextResponse.json({ error: "Group name is required." }, { status: 400 });
  }
  // Same reasoning as POST /api/channels: an unvalidated zone is a render crash, not a
  // bad value — formatInTz() hands it straight to Intl.DateTimeFormat.
  const timezone = (body.timezone || "UTC").trim();
  if (!isValidTimezone(timezone)) {
    return NextResponse.json(
      { error: `"${timezone}" isn't a timezone name. Use an IANA name like America/New_York.` },
      { status: 400 }
    );
  }
  try {
    const id = createChannelGroup({ name, timezone });
    return NextResponse.json({ id }, { status: 201 });
  } catch (err: any) {
    if (String(err?.code || "").includes("SQLITE_CONSTRAINT")) {
      return NextResponse.json(
        { error: `A group named "${name}" already exists.` },
        { status: 400 }
      );
    }
    throw err;
  }
}
```

- [ ] **Step 2: Create the item route**

Create `dashboard/app/api/channel-groups/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import { deleteChannelGroup, getChannelGroup, updateChannelGroup } from "@/lib/queries";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = Number(id);
  if (!getChannelGroup(groupId)) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  // `timezone` is intentionally NOT accepted here — it goes through
  // POST /api/channel-groups/[id]/timezone, which also rebases every member's queue.
  if ("timezone" in body) {
    return NextResponse.json(
      { error: "Change the timezone via POST /api/channel-groups/[id]/timezone." },
      { status: 400 }
    );
  }
  const fields: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ error: "Group name cannot be empty." }, { status: 400 });
    }
    fields.name = name;
  }
  if ("autofill_enabled" in body) fields.autofill_enabled = body.autofill_enabled ? 1 : 0;
  if ("cadence_config" in body) fields.cadence_config = body.cadence_config || null;
  if ("min_queue_depth" in body) fields.min_queue_depth = Number(body.min_queue_depth) || 0;
  if ("target_queue_depth" in body) fields.target_queue_depth = Number(body.target_queue_depth) || 0;
  if ("reuse_min_age_days" in body) fields.reuse_min_age_days = Number(body.reuse_min_age_days) || 0;
  if ("is_active" in body) fields.is_active = body.is_active ? 1 : 0;

  try {
    updateChannelGroup(groupId, fields);
  } catch (err: any) {
    if (String(err?.code || "").includes("SQLITE_CONSTRAINT")) {
      return NextResponse.json({ error: "Another group already has that name." }, { status: 400 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // Members are returned to solo auto-fill by ON DELETE SET NULL. Nothing is published,
  // unpublished, or unscheduled — a group is a scheduling convenience, not an owner.
  const ok = deleteChannelGroup(Number(id));
  if (!ok) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Create the timezone route**

Create `dashboard/app/api/channel-groups/[id]/timezone/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";
import {
  changeChannelGroupTimezone,
  getChannelGroup,
  getGroupMembers,
  getPendingPublicationsForChannel,
} from "@/lib/queries";
import { rebaseWallClock } from "@/lib/time";
import { isValidTimezone } from "@/lib/timezones";

export const runtime = "nodejs";

/**
 * Change a group's timezone. Mirrors POST /api/channels/[id]/timezone, widened to every
 * member: a group owns the cadence, so its members' pending sends must move together or
 * they stop mirroring.
 *
 *   { timezone, confirm: false }  -> preview: what would move, and to when
 *   { timezone, confirm: true }   -> apply, atomically
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const groupId = Number(id);
  const group = getChannelGroup(groupId);
  if (!group) {
    return NextResponse.json({ error: "Group not found." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const toTz = typeof body.timezone === "string" ? body.timezone.trim() : "";
  if (!toTz) {
    return NextResponse.json({ error: "Pick a timezone." }, { status: 400 });
  }
  if (!isValidTimezone(toTz)) {
    return NextResponse.json(
      { error: `"${toTz}" isn't a timezone name. Use an IANA name like America/New_York.` },
      { status: 400 }
    );
  }

  const fromTz = group.timezone;

  if (!body.confirm) {
    const sends = getGroupMembers(groupId).flatMap((m) =>
      getPendingPublicationsForChannel(m.id).map((p) => ({
        id: p.id,
        post_id: p.post_id,
        channel_id: m.id,
        account_name: m.account_name,
        is_held: p.is_held === 1,
        before: p.scheduled_at,
        after: rebaseWallClock(p.scheduled_at, fromTz, toTz),
      }))
    );
    return NextResponse.json({
      ok: true,
      from: fromTz,
      to: toTz,
      unchanged: fromTz === toTz,
      sends,
    });
  }

  const { moved } = changeChannelGroupTimezone(groupId, fromTz, toTz, rebaseWallClock);
  return NextResponse.json({ ok: true, from: fromTz, to: toTz, moved });
}
```

- [ ] **Step 4: Accept `group_id` on the channel PATCH**

In `dashboard/app/api/channels/[id]/route.ts`, add these imports to the existing import line:

```ts
import { getChannel, getChannelGroup, updateChannel, setChannelGroup } from "@/lib/queries";
```

Then, immediately before `updateChannel(channelId, fields);` at the end of the handler, insert:

```ts
  // group_id goes through setChannelGroup() rather than the generic field writer,
  // because updateChannel()'s Partial<> type deliberately does not list it — assignment
  // is a membership change, not a field edit.
  if ("group_id" in body) {
    const gid = body.group_id === null || body.group_id === "" ? null : Number(body.group_id);
    if (gid !== null && !getChannelGroup(gid)) {
      return NextResponse.json({ error: "Group not found." }, { status: 400 });
    }
    setChannelGroup(channelId, gid);
  }
```

- [ ] **Step 5: Typecheck and lint**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit && npm run lint
```

Expected: both clean.

- [ ] **Step 6: Verify the routes against a running dev server**

Start the dashboard (the project's dev port is 3939):

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npm run dev -- -p 3939
```

In a second terminal, exercise the full lifecycle:

```bash
curl -s -X POST localhost:3939/api/channel-groups -H 'Content-Type: application/json' -d '{"name":"SmokeTest","timezone":"America/New_York"}'
```

Expected: `{"id":1}`. Then confirm the duplicate-name guard, the listing, and cleanup:

```bash
curl -s -X POST localhost:3939/api/channel-groups -H 'Content-Type: application/json' -d '{"name":"SmokeTest","timezone":"UTC"}'
```

Expected: `{"error":"A group named \"SmokeTest\" already exists."}` with status 400.

```bash
curl -s localhost:3939/api/channel-groups
```

Expected: JSON containing the SmokeTest group. Delete it again (substitute the id returned above):

```bash
curl -s -X DELETE localhost:3939/api/channel-groups/1
```

Expected: `{"ok":true}`.

- [ ] **Step 7: Commit**

```bash
git add dashboard/app/api/channel-groups dashboard/app/api/channels/[id]/route.ts
git commit -m "feat(dashboard): channel-groups API routes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Dashboard UI — Groups section on the Channels page

**Files:**
- Modify: `dashboard/components/autofill-config.tsx` (retarget it at a channel OR a group)
- Create: `dashboard/components/channel-groups.tsx` (the Groups section)
- Create: `dashboard/components/channel-group-select.tsx` (per-channel membership picker)
- Modify: `dashboard/app/channels/page.tsx` (render both; hide a grouped channel's own auto-fill form)

**Interfaces:**
- Consumes: the API routes from Task 6; `listChannelGroups`, `getChannels` from `@/lib/queries`.
- Produces: no new exports consumed by later tasks — this is the leaf.

- [ ] **Step 1: Retarget `AutofillConfig` at either a channel or a group**

In `dashboard/components/autofill-config.tsx`, replace the `Props` interface and the first line of `save()`. Change:

```tsx
interface Props {
  channelId: number;
  enabled: boolean;
```

to:

```tsx
interface Props {
  /** Auto-fill config is owned by a GROUP when a channel belongs to one, and by the
   *  channel itself otherwise. Same fields either way — the schema repeats the column
   *  names precisely so this one form can drive both. */
  target: { kind: "channel" | "group"; id: number };
  enabled: boolean;
```

Inside the component, add this line just below `const router = useRouter();`:

```tsx
  const endpoint =
    props.target.kind === "group"
      ? `/api/channel-groups/${props.target.id}`
      : `/api/channels/${props.target.id}`;
  const noun = props.target.kind === "group" ? "group" : "channel";
```

Change the fetch inside `save()` from:

```tsx
    await fetch(`/api/channels/${props.channelId}`, {
```

to:

```tsx
    await fetch(endpoint, {
```

And change the checkbox label text from:

```tsx
            Automatically keep this channel&rsquo;s queue topped up
```

to:

```tsx
            Automatically keep this {noun}&rsquo;s queue topped up
```

- [ ] **Step 2: Create the group membership picker**

Create `dashboard/components/channel-group-select.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  channelId: number;
  groupId: number | null;
  groups: { id: number; name: string }[];
}

export function ChannelGroupSelect({ channelId, groupId, groups }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(groupId === null ? "" : String(groupId));
  const [pending, startT] = useTransition();

  async function change(next: string) {
    setValue(next);
    await fetch(`/api/channels/${channelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: next === "" ? null : Number(next) }),
    });
    startT(() => router.refresh());
  }

  return (
    <label className="mt-4 flex items-center justify-between gap-3 text-xs text-ink-soft">
      <span>Auto-fill group</span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => change(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-brand disabled:opacity-50"
      >
        <option value="">On its own</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
}
```

- [ ] **Step 3: Create the Groups section**

Create `dashboard/components/channel-groups.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AutofillConfig } from "./autofill-config";

export interface GroupRow {
  id: number;
  name: string;
  timezone: string;
  autofill_enabled: number;
  cadence_config: string | null;
  min_queue_depth: number;
  target_queue_depth: number;
  reuse_min_age_days: number;
  members: { id: number; account_name: string; platform: string }[];
}

export function ChannelGroups({ groups }: { groups: GroupRow[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [error, setError] = useState<string | null>(null);
  const [pending, startT] = useTransition();

  async function create() {
    setError(null);
    const res = await fetch("/api/channel-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, timezone }),
    });
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error || "Could not create the group.");
      return;
    }
    setName("");
    startT(() => router.refresh());
  }

  async function remove(id: number, label: string) {
    if (
      !window.confirm(
        `Delete the group "${label}"?\n\nIts channels go back to auto-filling on their own. ` +
          `Nothing already scheduled is changed or deleted.`
      )
    ) {
      return;
    }
    await fetch(`/api/channel-groups/${id}`, { method: "DELETE" });
    startT(() => router.refresh());
  }

  const field =
    "rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-brand";

  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-ink">Auto-fill groups</h2>
        <p className="mt-1 text-xs text-muted">
          Channels in a group auto-fill together — the same content, at the same moment, on one
          cadence. A channel that can&rsquo;t take a post (Threads and video, say) sits that slot
          out; anything blocked by a cooldown or blackout holds the whole group back.
        </p>
      </div>

      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.id} className="rounded-card border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-ink">{g.name}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {g.timezone} ·{" "}
                  {g.members.length
                    ? g.members.map((m) => m.account_name).join(" + ")
                    : "no channels yet"}
                </p>
              </div>
              <button
                onClick={() => remove(g.id, g.name)}
                disabled={pending}
                className="text-xs text-muted hover:text-status-failed disabled:opacity-50"
              >
                Delete
              </button>
            </div>
            <AutofillConfig
              target={{ kind: "group", id: g.id }}
              enabled={g.autofill_enabled === 1}
              cadenceConfig={g.cadence_config}
              minQueueDepth={g.min_queue_depth}
              targetQueueDepth={g.target_queue_depth}
              reuseMinAgeDays={g.reuse_min_age_days}
            />
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-soft">
          <span className="mb-1 block">New group</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Personal"
            className={field}
          />
        </label>
        <label className="text-xs text-ink-soft">
          <span className="mb-1 block">Timezone</span>
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/New_York"
            className={field}
          />
        </label>
        <button
          onClick={create}
          disabled={pending || !name.trim()}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
        >
          Create group
        </button>
        {error ? <span className="text-xs text-status-failed">{error}</span> : null}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Wire both into the Channels page**

In `dashboard/app/channels/page.tsx`, add to the imports:

```tsx
import { getChannels, listChannelGroups, getGroupMembers } from "@/lib/queries";
import { ChannelGroups } from "@/components/channel-groups";
import { ChannelGroupSelect } from "@/components/channel-group-select";
```

(replacing the existing `import { getChannels } from "@/lib/queries";` line).

In the component body, replace `const channels = getChannels();` with:

```tsx
  const channels = getChannels();
  const groups = listChannelGroups().map((g) => ({
    id: g.id,
    name: g.name,
    timezone: g.timezone,
    autofill_enabled: g.autofill_enabled,
    cadence_config: g.cadence_config,
    min_queue_depth: g.min_queue_depth,
    target_queue_depth: g.target_queue_depth,
    reuse_min_age_days: g.reuse_min_age_days,
    members: getGroupMembers(g.id).map((m) => ({
      id: m.id,
      account_name: m.account_name,
      platform: m.platform,
    })),
  }));
  const groupNames = new Map(groups.map((g) => [g.id, g.name]));
```

Render `<ChannelGroups groups={groups} />` immediately above the `<div className="grid gap-4 md:grid-cols-2">` that opens the channel cards.

Finally, replace the existing `<AutofillConfig ... />` block inside each channel card with:

```tsx
                <ChannelGroupSelect
                  channelId={c.id}
                  groupId={c.group_id}
                  groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                />

                {c.group_id === null ? (
                  <AutofillConfig
                    target={{ kind: "channel", id: c.id }}
                    enabled={c.autofill_enabled === 1}
                    cadenceConfig={c.cadence_config}
                    minQueueDepth={c.min_queue_depth}
                    targetQueueDepth={c.target_queue_depth}
                    reuseMinAgeDays={c.reuse_min_age_days}
                  />
                ) : (
                  <p className="mt-4 rounded-lg border border-border bg-surface-sunken/50 p-3 text-xs text-muted">
                    Auto-filled as part of{" "}
                    <span className="font-medium text-ink-soft">
                      {groupNames.get(c.group_id)}
                    </span>
                    . Its cadence is set on the group above.
                  </p>
                )}
```

- [ ] **Step 5: Typecheck and lint**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit && npm run lint
```

Expected: both clean.

- [ ] **Step 6: Verify in the browser**

With the dev server running on port 3939, open `http://localhost:3939/channels` and confirm, in order:

1. An "Auto-fill groups" section renders above the channel cards, empty at first.
2. Creating a group named "Personal" with timezone `America/New_York` makes a group card appear.
3. Each channel card has an "Auto-fill group" dropdown reading "On its own".
4. Setting the Instagram and Threads channels to "Personal" makes both cards replace their auto-fill form with "Auto-filled as part of **Personal**", and the group card's subtitle lists both account names.
5. The group card's own auto-fill form saves days/time/depths and the summary line updates after refresh.
6. Deleting the group shows a confirm dialog naming it, and afterwards both channels show their own auto-fill form again.

Take a screenshot of the Channels page with a populated group for the commit record.

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/autofill-config.tsx dashboard/components/channel-groups.tsx dashboard/components/channel-group-select.tsx dashboard/app/channels/page.tsx
git commit -m "feat(dashboard): auto-fill groups UI on the Channels page

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Live verification and docs

**Files:**
- Modify: `docs/tasks.md` (record the phase as done, with what was verified)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code-facing.

- [ ] **Step 1: Confirm the owner's install is safe to test against**

This install publishes for real (`DRY_RUN=0`). Before queueing anything, set the kill switch so no verification post can actually go out:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && grep -n 'KILL_SWITCH\|DRY_RUN' .env
```

If `KILL_SWITCH` is not `1`, ask the owner before continuing. Do not flip it yourself without saying so.

- [ ] **Step 2: Apply the migration to the live DB**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && python3 migrate.py
```

Expected: `0013_channel_groups.sql` reported as applied; re-running is a no-op.

- [ ] **Step 3: Create the real group in the dashboard**

On `http://localhost:3939/channels`, create a group named "Personal" in `America/New_York`, assign the personal Instagram and Threads channels to it, enable auto-fill with two days a week and a small target depth (say refill below 2, fill to 2).

- [ ] **Step 4: Run one worker cycle and read the queue**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && source worker/.venv/bin/activate && python -m worker.run --once
```

Then inspect what it queued:

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler" && python3 inspect_db.py
```

Confirm on the Scheduled page and in the DB output:
- every auto-filled slot has **two** publications at the **identical** `scheduled_at`, one per member, both `created_by = 'autofill'`
- any Reel that was queued appears on **Instagram only**
- running the worker a second time adds nothing (no over-fill)

- [ ] **Step 5: Record the result in `docs/tasks.md`**

Add a `## Phase 7 — Channel groups (coordinated auto-fill)  \`[x] done\`` section following the existing house format: an `### Implementation` list naming the migration, the unit-based `run_autofill`, and the Groups UI, then a `### Verification (all passed)` list stating the exact worker test count, the `tsc`/lint result, and what the live run produced (slot timestamps matched, Reel went to Instagram only, second run added nothing).

- [ ] **Step 6: Commit**

```bash
git add docs/tasks.md
git commit -m "docs: record channel groups phase as verified

Co-Authored-By: Claude <noreply@anthropic.com>"
```
