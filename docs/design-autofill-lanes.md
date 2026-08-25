# Design — Auto-fill lanes (a cadence per surface, not per channel)

**Status:** drafted 2026-08-25, awaiting owner review
**Depends on:** auto-fill (`worker/autofill.py`), channel groups (migration `0013`), the story
surface (`0014`, `0015`), the widened surface set (`0027`), BPP recycling (`0020`–`0022`), and
the Instagram Stories publish path (`worker/publisher.py`) — all shipped.
**Feeds:** control — the owner can run a feed rotation and a Story rotation on their own
schedules, from one Library, without either one starving the other.

---

## 1. Purpose

The owner wants Stories on their own auto-fill cadence, running alongside the feed cadence
rather than instead of it — "feed posts Tue/Thu at 6pm, Stories every day at noon."

Auto-fill cannot express that today. It has exactly **one cadence per unit**, where a unit is
a channel group or an ungrouped channel, and that cadence is hardwired to the feed:

- `worker/autofill.py:210-211` requires the candidate to have a `post_targets` row with
  `pt.surface = 'feed'`. A post aimed only at a Story is deliberately excluded — a scope cut
  recorded in `docs/design-instagram-stories.md` §4, not an oversight.
- `worker/autofill.py:839-842` inserts publications without a `surface` column, taking the
  `DEFAULT 'feed'` from migration `0014`.
- The settings themselves (`autofill_enabled`, `cadence_config`, `min_queue_depth`,
  `target_queue_depth`, `reuse_min_age_days`) are **columns on `channels` and
  `channel_groups`** — one set, one cadence, per unit.

The destination model is already right: `post_targets.surface` and `publications.surface` both
accept `('feed','story','reel')` after `0027`. What is missing is that auto-fill **config** is
one-per-unit where it needs to be one-per-(unit, surface).

**The unit of auto-fill becomes a lane: an owner plus a surface.**

## 2. The decisions this rests on

Four questions were settled before design, and every section below follows from them:

1. **The Story lane recycles only posts the owner tagged for Stories** — a `post_targets` row
   with `surface = 'story'`. The exact mirror of how the feed lane works. Nothing lands on a
   Story because auto-fill inferred it could.
2. **Feed and Story share one cooldown per post per channel.** Posting a photo to the feed
   keeps it out of the Story rotation for the cooldown window and vice versa. This is what
   `worker/autofill.py:193-196` already does — it matches on `post_id` + `channel_id` and
   never looks at surface — so it is kept by *not* changing it.
3. **Feed and Story lanes only.** The mechanism is generic over surface so a Reel lane is a
   config row rather than a rewrite, but nothing exposes one yet: a Reel lane can only pick
   video posts and would sit empty until the video Library is deep enough to recycle from.
4. **Lanes exist on channel groups, not only on solo channels.** This install runs auto-fill
   through the group path (`_autofill_units`, `worker/autofill.py:451-468`); a channel-only
   feature would not give the owner a Story cadence on their actual setup.

## 3. Data model

### 3.1 The new table

```sql
CREATE TABLE autofill_lanes (
  id                 INTEGER PRIMARY KEY,
  channel_id         INTEGER REFERENCES channels(id)       ON DELETE CASCADE,
  group_id           INTEGER REFERENCES channel_groups(id) ON DELETE CASCADE,
  surface            TEXT    NOT NULL CHECK (surface IN ('feed','story','reel')),
  enabled            INTEGER NOT NULL DEFAULT 0,
  cadence_config     TEXT,
  min_queue_depth    INTEGER NOT NULL DEFAULT 0,
  target_queue_depth INTEGER NOT NULL DEFAULT 0,
  reuse_min_age_days INTEGER NOT NULL DEFAULT 180,
  -- Exactly one owner. A lane belongs to a group OR a channel, never both, never neither.
  CHECK ((channel_id IS NULL) <> (group_id IS NULL))
);

CREATE UNIQUE INDEX idx_autofill_lanes_channel
    ON autofill_lanes (channel_id, surface) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX idx_autofill_lanes_group
    ON autofill_lanes (group_id, surface)   WHERE group_id IS NOT NULL;
```

**Two nullable owner columns rather than an `owner_type` / `owner_id` pair.** SQLite cannot
foreign-key a polymorphic column, and a lane that outlives its deleted channel is a row the
worker would keep trying to fill. Two real foreign keys mean `ON DELETE CASCADE` does the
cleanup the schema should be doing anyway. The cost is two partial unique indexes instead of
one composite; that is cheaper than an orphan.

Defaults match the live column defaults exactly (`migrations/0025_tiktok.sql:46-50` for
`channels`, `migrations/0013_channel_groups.sql:33-37` for `channel_groups`) so a lane created
by hand behaves like a unit created by hand.

**What is deliberately NOT on the lane:**

- `timezone` — a lane inherits its owner's. Two surfaces on one account cannot be in different
  timezones, and duplicating it invites them to disagree.
- The `bpp_*` dials — BPP recycling stays feed-only (§4.5). They stay on the owner.

### 3.2 Migration and backfill

The migration is additive: `CREATE TABLE`, two indexes, and one backfill per owner kind.

```sql
INSERT INTO autofill_lanes
    (group_id, surface, enabled, cadence_config,
     min_queue_depth, target_queue_depth, reuse_min_age_days)
SELECT id, 'feed', autofill_enabled, cadence_config,
       min_queue_depth, target_queue_depth, reuse_min_age_days
  FROM channel_groups;

INSERT INTO autofill_lanes
    (channel_id, surface, enabled, cadence_config,
     min_queue_depth, target_queue_depth, reuse_min_age_days)
SELECT id, 'feed', autofill_enabled, cadence_config,
       min_queue_depth, target_queue_depth, reuse_min_age_days
  FROM channels WHERE group_id IS NULL;
```

Every existing unit gets exactly one feed lane holding its current settings, so the install
keeps filling on the same schedule with the same content the moment the migration lands.

A channel that is *in* a group gets no lane, matching `_autofill_units`
(`worker/autofill.py:463-467`), which never returns a grouped channel as a solo unit. If a
channel later leaves its group, the dashboard creates its feed lane on first save; until then
it simply has no lane and is not auto-filled — the same outcome as today, where a freshly
ungrouped channel has `autofill_enabled = 0` until someone turns it on.

**The old columns stay in place and go unread.** This follows the precedent set by
`migrations/0020_bpp_recycling.sql:36`, which left the superseded `bpp_every_n_slots` in place
rather than rebuilding two tables for zero behaviour change. Rebuilding `channels` here would
mean a third full rebuild of a table with foreign-key children, to delete five columns.

**This also retires a schema rule.** `migrations/0013_channel_groups.sql:8-12` requires every
auto-fill setting to be mirrored onto both `channels` and `channel_groups` under identical
names so one code path can read either. That rule has already been broken once —
`bpp_strong_pct` / `bpp_broad_pct` exist only on `channels`
(`migrations/0022_bpp_thresholds.sql:16,21`), never on `channel_groups`. One lane table with
one set of columns removes the mirroring obligation instead of adding a third copy of it.

## 4. Worker

### 4.1 The lane replaces the unit

`AutofillUnit` (`worker/autofill.py:438-448`) becomes `AutofillLane`, gaining a `surface`. Its
`settings` stops being the channel/group row and becomes **the lane row merged with the
owner's `timezone` and `bpp_*` dials**, which stay stored on the owner (§3.1). The loader
selects the lane joined to its owner, so `settings` still answers every key the file reads
today — `cadence_config` (`:745`), `min_queue_depth` (`:759,779,855`), `target_queue_depth`
(`:761,856`), `timezone` (`:791,795`) — and every read site is left untouched.

The merge is not cosmetic. `_setting` (`worker/autofill.py:471-483`) swallows a missing column
and returns its default, so a `settings` that dropped `bpp_every_days` would not raise — the
BPP step at `worker/autofill.py:802` would read `0`, conclude "off", and silently stop
recycling with nothing logged. Carrying the owner's dials into `settings` is what keeps that
from happening.

`_autofill_units` becomes `_autofill_lanes`, returning one entry per enabled lane whose owner
is active. A group with both lanes on is topped up twice per cycle, independently: separate
queue-depth maths, separate candidate pools, separate slot walks.

`run_autofill` (`worker/autofill.py:861`) keeps its shape — it iterates whatever the loader
returns and calls `_fill_unit` on each. One lane per iteration instead of one unit.

### 4.2 Surface reaches the queries

`surface` is threaded through as a keyword argument to `select_candidates`
(`worker/autofill.py:159`), `eligible_candidates` (`:302`) and `group_eligible_candidates`
(`:385`). The hardcode at `worker/autofill.py:211` becomes `AND pt.surface = :surface`.

`scheduled_ahead_count` (`:86`) and `latest_future_scheduled` (`:100`) take a surface and add
`AND surface = ?`. Their group counterparts (`:115`, `:140`) do the same.

**Queue depth counts slots, not publication rows.** `group_scheduled_ahead_count` already does
this — `COUNT(DISTINCT strftime('%s', scheduled_at))` at `worker/autofill.py:115-138` — and the
solo `scheduled_ahead_count` counts raw rows. The solo path adopts the same distinct-instant
count. This is a **no-op for the feed lane** (a solo feed slot produces exactly one
publication, so rows and instants are equal) and is **required for the story lane**, where one
slot fans out into one publication per slide (§4.3). Counting rows there would read a
four-slide Story as four posts of queue depth and stall the lane after two picks.

Without the per-surface filter, a healthy Story queue would satisfy the feed lane's
`ahead >= min_queue_depth` check at `worker/autofill.py:759` and the feed would silently stop
filling. That is the single most important line in this design.

### 4.3 Story fan-out, in Python

There is no such thing as a carousel Story: a four-slide post becomes four consecutive
Stories, each an independent publication that retries, fails and reports metrics on its own.
The TypeScript side expresses this in `expandTarget` (`dashboard/lib/story-fanout.ts:85-91`),
whose docstring already claims a Python counterpart in `worker/autofill.py`. **That claim is
currently false** — auto-fill has never created a story send. This design makes it true.

The insert at `worker/autofill.py:839-842` gains `surface` and `asset_id`:

```sql
INSERT INTO publications
     (post_id, channel_id, scheduled_at, status, created_by, is_recycled, surface, asset_id)
   VALUES (?, ?, ?, ?, 'autofill', ?, ?, ?)
```

For a feed lane, `surface = 'feed'` and `asset_id = NULL`, meaning "all of this post's assets,
in order" — byte-identical behaviour to today. For a story lane, the chosen post expands into
one row per `post_assets` row ordered by `sort_order`, all sharing the slot's `scheduled_at`,
so ascending publication id gives the publish order `worker/db.py`'s `ORDER BY scheduled_at,
id` relies on.

The rule is now written twice, once per language, exactly as
`dashboard/lib/story-fanout.ts:80-83` intends: the two runtimes share a database, not code
(`CLAUDE.md`), so it is duplicated on purpose and tested on both sides.

### 4.4 Story lanes only reach channels that can take a Story

A story lane on a mixed group must fill only its story-capable members. An Instagram + Facebook
group with a story lane creates Instagram sends and nothing for the Facebook Page.

The Python side has no clean way to ask this today. `PlatformCaps` expresses Stories only
through `video_surfaces` (`worker/clients.py:100-105`), which is about video, and
`publisher._validate` decides with a literal `if platform != "instagram"`
(`worker/publisher.py:312`) rather than reading capabilities at all.

**This design adds a `surfaces: frozenset[str]` field to `PlatformCaps`** — the destinations a
platform's publish path accepts for any media kind, defaulting to `frozenset({"feed"})`, with
Instagram declaring `{"feed", "story"}`. `publisher._validate:312` then reads
`if surface not in caps.surfaces`, and the story lane filters members with the same call. One
fact, one place, and the next story-capable platform becomes a capability edit rather than a
grep for hardcoded platform names.

### 4.5 What stays surface-blind, deliberately

Three queries look at `publications` without a surface predicate. All three are left alone,
and this section exists so a future reader knows that was a decision:

- **The cooldown lookup** (`worker/autofill.py:193-196`) — shared cooldown across surfaces is
  decision 2 of §2. Keeping it surface-blind *is* the implementation.
- **The already-queued exclusion** (`worker/autofill.py:214-216`) — a post queued as a Story
  is also held out of the feed lane. This is the same principle as the shared cooldown applied
  to pending work, and prevents the same photo appearing on the feed and in Stories on the
  same day.
- **Performance ranking** (`group_rank`, `worker/autofill.py:344`) — a post's rank blends its
  feed and story history. Story metrics are a different vocabulary from feed metrics and
  normalising them is its own piece of work; mixing them is a known, bounded imprecision in a
  tiebreak, not a correctness bug.

**BPP recycling stays feed-only.** `_apply_bpp`, `_last_bpp_date` (`:515`) and
`_unit_publication_count` (`:657`) are only reached from a feed lane; a story lane skips the
BPP step entirely. Recycling a best-performing post as a Story was not asked for, and the BPP
dials remain on the owner rather than the lane. `worker/bpp.py` needs no change at all — it is
pure functions over dates and dicts (`worker/bpp.py:21`) and has no surface concept to update.

### 4.6 The caption gate must not run on a story lane

`_caption_too_long_for_channel` (`worker/autofill.py:242-273`) exists so an evergreen post
that would fail forever on caption length is never queued. **A Story sends no caption at all** —
`worker/publisher.py:320` suppresses it unconditionally, and `_validate` runs no caption check
on the story branch.

So the gate is skipped for story lanes. Leaving it on would silently exclude every
long-caption post from the Story rotation over a limit that will never be applied to it — the
failure mode being an empty-looking Story queue with no explanation anywhere in the UI.

## 5. Dashboard

### 5.1 One panel, a surface switch

`AutofillConfig` (`dashboard/components/autofill-config.tsx`) is already a single reusable
panel parameterised by `target: { kind: "channel" | "group"; id: number }` (`:21`) and rendered
from both `dashboard/app/channels/page.tsx:255` and
`dashboard/components/channel-groups.tsx:121`. `target` gains a `surface`.

The panel grows a segmented switch at its top — **Feed · Story** — with each side carrying its
own enable toggle, cadence builder and queue depths. Not two stacked panels: this screen's job
is to make the schedule legible at a glance, and a second full-height copy of a 466-line panel
buries the thing the owner came to read.

The Story side is hidden entirely when no story-capable channel is in scope, so it is never
possible to configure a lane that cannot fire.

`props.bandTimes` and `props.bandCounts` are read straight off props at render
(`dashboard/components/autofill-config.tsx:149-152`) rather than copied into state, so they
already refresh correctly on `router.refresh()` and need no rework for a second lane.

### 5.2 Band counts have to learn about surfaces

`getBandCounts` (`dashboard/lib/queries.ts:294-323`) powers the coverage warning that catches
"this band has content and nowhere to put it." Its query hardcodes `AND ptg.surface = 'feed'`
(`:318`), and both call sites — `dashboard/app/channels/page.tsx:265` for channels and `:51`
for groups — can only ever receive the feed number.

It takes a `surface` parameter. Left as-is, the Story lane's coverage warning would count feed
posts the lane cannot use and warn about bands it has no problem with — a warning that lies is
worse than no warning, because this one is the only safety net the strict band rule has.

### 5.3 A group-level story-capability helper

`supportsStory` (`dashboard/lib/platforms.ts:246-248`) answers for one platform string, and
both existing callers (`dashboard/lib/media-limits.ts:235`,
`dashboard/components/channel-surface-picker.tsx:133`) iterate channels themselves. Nothing
answers "does this group have any story-capable member," which is what decides whether the
group panel shows a Story side at all. That helper is added next to `supportsStory`.

### 5.4 Persistence

`PATCH /api/channels/[id]` (`dashboard/app/api/channels/[id]/route.ts:56-71`) and
`PATCH /api/channel-groups/[id]` (`dashboard/app/api/channel-groups/[id]/route.ts:38-47`)
currently fold the six auto-fill fields into a generic column writer —
`updateChannel` (`dashboard/lib/queries.ts:157-192`) and `updateChannelGroup` (`:332-354`).

The auto-fill fields split off into an `upsertAutofillLane(owner, surface, fields)` query
keyed on the lane's unique index, and the routes accept a `surface` in the body. `bpp_*`,
`color_hue`, `is_active` and `group_id` keep flowing through the existing column writers
untouched — those are owner-level settings and are not moving.

`Channel` and `ChannelGroup` in `dashboard/lib/types.ts:63-107` keep their auto-fill fields
declared while the columns exist, but nothing reads them after this lands; a new `AutofillLane`
type describes the lane row.

## 6. What this does not do

- **No Reel lane in the UI.** The table accepts `'reel'` and the worker is generic over
  surface, so it is an INSERT and a switch option when the video Library justifies it.
- **No separate story cooldown.** One cooldown per post per channel, spanning both surfaces.
- **No BPP on the Story lane.**
- **No dropping of the superseded columns on `channels` / `channel_groups`.**
- **No change to how Stories publish.** `worker/publisher.py` gains one capability read
  (§4.4); the publish path itself is untouched, because auto-fill produces exactly the same
  publication rows the composer already produces.

## 7. Testing

**Python** — a new `worker/tests/test_autofill_lanes.py`, following the file-local
`make_channel` / `make_group` / `make_post` helper pattern of
`worker/tests/test_autofill.py:24-117` and `worker/tests/test_autofill_groups.py:12-66`. Those
helpers insert two-column `post_targets` rows and so are implicitly feed-only; the new file
needs a `surface=` variant, for which `worker/tests/conftest.py:543` is the existing precedent.

Cases that must pass:

1. A story lane queues only posts with a `surface = 'story'` target — a feed-only post is never
   picked.
2. A four-slide post picked by a story lane produces four publications at one `scheduled_at`,
   ascending id, each with its own `asset_id`.
3. Story queue depth counts slots: that same four-slide post advances `ahead` by one, not four.
4. **A full story queue does not stall the feed lane.** The regression test for §4.2.
5. A story lane on an Instagram + Facebook group creates Instagram sends only.
6. Shared cooldown holds across surfaces: a post published to the feed is not story-eligible
   inside its cooldown window.
7. A post whose caption exceeds the channel's limit is still story-eligible (§4.6) and still
   feed-ineligible.
8. Feed-lane behaviour is unchanged — the existing `test_autofill.py` and
   `test_autofill_groups.py` suites pass untouched, which is the real proof the backfill is
   faithful.

**Migration** — assert every previously auto-fill-enabled unit ends with exactly one feed lane
whose values equal its old columns, and that a grouped channel gets no lane. Run against a
`sqlite3 .backup` copy: `migrate.py` has no argument parser and applies migrations to
whatever DB it is pointed at, on any invocation.

**Dashboard** — `npm test`. A `lib/` test for `upsertAutofillLane` and for `getBandCounts`
returning different numbers per surface, following the `makeTestDb()` + dynamic-import `setup()`
pattern of `dashboard/lib/queries.groups.test.ts:1-16`. A `test-ui/` test for whatever pure
helpers the surface switch exports, following `dashboard/test-ui/autofill-config-ui.test.ts`.

**Manual, and this is what actually proves it.** `renderToStaticMarkup` cannot exercise a
segmented control, so:

1. Launch the worker with `DRY_RUN=1` on the command line (a launch-time env var outranks
   `.env`), with the story lane enabled.
2. Confirm the queue shows Story sends at the story cadence and feed sends unchanged at the
   feed cadence.
3. Confirm a multi-slide Story appears as N consecutive sends at one time.
4. Click through both lanes of the panel in Safari with a hard reload (Cmd+Option+R), since
   Turbopack reuses one CSS URL and Safari will otherwise serve stale styles.

## 8. Build order

Three phases, each verifiable before the next:

- **A — schema.** The migration and backfill, with its test. Nothing reads the lanes yet; the
  install is provably unchanged.
- **B — worker.** `AutofillLane`, surface threading, story fan-out, the `PlatformCaps.surfaces`
  field, the caption-gate skip. Verified by the Python suite plus a `DRY_RUN=1` pass.
- **C — dashboard.** The surface switch, `getBandCounts(surface)`, the group capability
  helper, `upsertAutofillLane`, and the route changes. Verified by `npm test` plus the Safari
  click-through.

B is where the risk is: it is the only phase that can queue a real send.
