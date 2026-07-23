# Design — Sub-project ② Tagging taxonomy

**Status:** approved 2026-07-23, ready for implementation planning
**Depends on:** ① Content model (periods, targeting, caption variants, autofill gates) — shipped
**Feeds:** ③ Bulk import (consumes tags), ④ Library overview (filters on tags)

---

## 1. Purpose

Give each piece of content structured, filterable labels, and let one of those label
kinds — **time of day** — actively steer *when* the worker auto-posts it. Everything else a
tag does is organizational: filtering the Library and fueling bulk import (③).

This is an internal, single-install tool. Favor legibility over cleverness: a person looking
at a post should be able to see, plainly, why it was scheduled for the time it was.

---

## 2. The taxonomy

Two tag **kinds**, both stored in the existing `tags` / `post_tags` tables (present in
`0001_init.sql` but never used — effectively empty in every install):

| Kind | Values | Role | Read by worker? |
|---|---|---|---|
| `time_of_day` | **fixed**: `morning`, `afternoon`, `evening` | Sets the clock time of an auto-scheduled post | **Yes** |
| `topic` | **free-form** (e.g. travel, tips, promo, events) | Library filtering + bulk-import fuel | No |

### Why platform is *not* a tag
"Which platforms can this go to" is already answered by **targeting** (`post_targets`): a post
targets specific accounts, and every account has a known platform. A separate platform tag
would restate that fact in a second place where it can *disagree* with the targets, forcing the
worker to arbitrate. Instead, platform eligibility stays derived from targets, and the Library
offers a **computed** platform filter (join `post_targets` → `channels.platform`) — no tag to
maintain, no way to contradict reality. When X (or any new network) arrives, it's a new
*channel type*; "for all platforms" simply means targeting an account of that type.

### Multi-valued
A post may carry any number of `topic` tags and any number of `time_of_day` tags (e.g. both
`morning` and `evening` if it suits either slot).

---

## 3. How `time_of_day` steers scheduling

### Current engine (unchanged parts)
Each channel auto-fills on a **weekly cadence** stored in `channels.cadence_config`, e.g.
`{"days":["tue","thu","sat"],"time":"18:00"}`. When a channel's queue drops below
`min_queue_depth`, `autofill.run_once` picks up to `target_queue_depth − ahead` eligible
candidates and assigns each to the next future cadence day. **One auto-post per active day.**

### The one change: the tag defines the *time*, the cadence defines the *days*
- The cadence still supplies **which days** a channel posts and preserves post frequency
  (one auto-post per active day — no increase in volume).
- A post's `time_of_day` tag supplies **the clock time** it lands at on its assigned day,
  interpreted in the **channel's own timezone**:
  - `morning` → **09:00**
  - `afternoon` → **13:00**
  - `evening` → **18:00**
  - These are **worker config defaults** (env-overridable); a per-channel override is a
    deliberately-deferred later enhancement.
- Because the tag **defines** the slot time rather than being matched against a pre-fixed
  slot, there is **no "no morning slot is free" failure mode** — the day's single slot simply
  takes the assigned post's band time.
- **Multiple `time_of_day` tags** on one post → the scheduler picks **deterministically: the
  earliest band** present (morning < afternoon < evening).
- **Untagged (no `time_of_day`)** → the post is eligible for any day and lands at the
  **channel default band time = afternoon (13:00)**. *(Open decision — see §7.)*

### Worked example
Channel "Advantage PT", tz `America/New_York`, cadence `{"days":["mon","wed"],"time":...}`
(the old single `time` is now ignored for band-tagged posts — see §4 migration note).
Eligible queue, in priority order: `[A: evening]`, `[B: morning]`, `[C: untagged]`.
Autofill needs 3, next cadence days are Mon, Wed, next Mon:
- A → Mon **18:00** ET
- B → Wed **09:00** ET
- C → next Mon **13:00** ET (default band)

Each post's time is legibly explained by its own tag.

---

## 4. Schema — migration `0003_tag_taxonomy.sql` (additive only)

```sql
-- Add the taxonomy dimension to the existing flat tags table.
ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'topic';

-- Seed the three fixed time-of-day tags (idempotent via INSERT OR IGNORE on unique name).
INSERT OR IGNORE INTO tags (name, kind) VALUES
  ('morning',   'time_of_day'),
  ('afternoon', 'time_of_day'),
  ('evening',   'time_of_day');
```

Notes / decisions:
- `tags.name` keeps its existing global `UNIQUE COLLATE NOCASE` constraint. Rebuilding the
  table to make uniqueness per-`(kind, name)` is not worth it for a single-install tool where
  the three reserved time-of-day names won't collide with user topics. Documented tradeoff.
- The fixed `time_of_day` value set (`morning`/`afternoon`/`evening`) and the `kind` value set
  (`topic`/`time_of_day`) are enforced at the **application layer** (both TS routes and the
  Python worker), consistent with how the rest of the app validates enums that can't be a
  cheap `ALTER … CHECK`.
- Band default times are **worker config constants** with env overrides
  (e.g. `TOD_MORNING=09:00`, `TOD_AFTERNOON=13:00`, `TOD_EVENING=18:00`). Per-channel override
  columns are **out of scope** here (deferred).
- Index: add `CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag_id);` to make the
  Library's "posts with tag X" filter and reverse lookups cheap.

---

## 5. Build order

Mirrors ①: engine first (schema + worker + tests), then dashboard UI.

### ②-A — engine
- `migrations/0003_tag_taxonomy.sql` (§4).
- Worker: band-time config + a small `time_of_day.py` helper resolving a post's band → local
  clock time; refactor `autofill` so each candidate's assigned slot time comes from its
  `time_of_day` tag (earliest band, or default), while cadence still supplies the days.
  - `scheduling.weekly_slots` currently bakes a single `(hour, minute)` into every slot. Split
    it: generate the next N future cadence **dates**, then combine each with its post's band
    time. Keep the existing signature working (back-compat) or add a date-generating variant —
    planner decides.
- Worker tests: band→time resolution, earliest-of-multiple, untagged default, timezone
  correctness (DST boundary), and an autofill test asserting per-post slot times.

### ②-B — dashboard
- **Composer:** a Tags section —
  - `time_of_day`: a 3-chip multi-select (Morning / Afternoon / Evening).
  - `topic`: a free-form multi-add (create-or-reuse existing topic tags; same visual language
    as the caption-variants adder).
- **Library:** filter by tag (topic + time_of_day) and a **computed platform filter**
  (derived from each post's targets' channel platforms). Show tag chips on post cards.
- **Queries + API:** `getPostTags` / `setPostTags` (replace-semantics transaction like
  `setPostTargets`), a tags list/create endpoint for topics, and validation that
  `time_of_day` values ∈ the fixed set and `kind` ∈ {topic, time_of_day}. All routes
  `export const runtime = "nodejs"`.

---

## 6. Out of scope (explicitly deferred)

- **③ Bulk import** — consumes tags; separate sub-project.
- **④ Library overview (full)** — this adds tag filters to the existing Library; the full
  overhaul is separate.
- **Per-channel band-time overrides** — config constants only for now.
- **Topic tag management UI** (rename/merge/delete taxonomy) — create-on-use is enough for v1;
  revisit if topic sprawl becomes a problem.

---

## 7. Open decisions to confirm at spec review

1. **Untagged default band.** Proposed: untagged posts land at the channel default
   **afternoon (13:00)**. Alternative: skip untagged posts from time-steering entirely and
   keep the channel's legacy single cadence `time`. Recommendation stands (afternoon default)
   for a single, predictable rule.
2. **Legacy `cadence_config.time`.** With band times now driving the clock, the channel's old
   single `time` becomes the *fallback* only for untagged posts if we ever prefer it over a
   fixed afternoon default. Proposed: ignore it and use the afternoon default, to keep one
   rule. Flag if you'd rather the legacy `time` remain the untagged fallback.

---

## 8. Verification

- **②-A:** `pytest` — new band/timezone/autofill tests green; migration applies cleanly on a
  copy of a real DB; dry-run autofill produces the expected per-post slot times.
- **②-B:** `npx tsc --noEmit` clean; browser round-trip — tag a post morning+topic in the
  composer, confirm chips persist and the Library filter narrows to it; confirm the computed
  platform filter reflects targets.
- Cross-check: a `time_of_day`-tagged post, once auto-filled, shows a `scheduled_at` whose
  channel-local time equals its band default.
