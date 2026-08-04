# Design — Instagram Stories (a destination, not a post type)

**Status:** approved 2026-08-03, ready for implementation planning (build not started — owner
asked to hold)
**Depends on:** the publications state machine, `post_targets` (migration `0002`), the shared
channel picker used by the composer / schedule-from-library / quick-edit, the Instagram
publish path (`worker/publisher.py`), image conformance (migration `0006`), and the metrics
job — all shipped.
**Feeds:** flexibility — one photo can be an Instagram Story *and* an ordinary Telegram post,
with the difference visible on screen rather than implied.

---

## 1. Purpose

The owner wants to post Instagram Stories, with two requirements that pull in opposite
directions:

1. **Only certain posts are meant for Stories** — it must be obvious which.
2. **The same photo may also go elsewhere as a normal post** — a Story on Instagram, a
   regular post on Telegram, from one Library entry.

Today `posts.post_type` is a single value per post, and `'story'` is already in its CHECK
constraint (migration `0001`) but no code implements it — `worker/publisher.py` refuses it
outright. That slot is in the wrong place for this feature.

**The insight this design rests on:** `post_type` is never chosen by the owner. The composer
*infers* it from the content — text-only → `text`, one video → `reel`, one image → `single`,
several → `carousel` (`dashboard/components/composer.tsx`). So `post_type` describes **what
the content is**. "Story" describes **where it lands**. Those are different axes, and where a
post lands already lives elsewhere: `post_targets`, with one independent `publication` per
send.

**Therefore: Story is a per-target surface, not a post type.** This is what makes requirement
2 fall out for free — the surface is chosen per channel, so Instagram can be told "Story"
while Telegram is told nothing at all and keeps its caption.

### Decisions taken (owner, 2026-08-03)

| Question | Decision |
|---|---|
| Feed *and* Story on one IG channel? | **Both, independently.** Two separate sends. |
| Multi-photo post → Story? | **Every slide, back to back**, in slide order. |
| Image shaping for Stories? | **Send the original**, let Instagram fit it. |
| Story metrics? | **Fetch, then stop at 24h.** |

---

## 2. Schema — migration `0014_story_surface.sql`

### `post_targets` — rebuild (primary key widens)

```sql
surface TEXT NOT NULL DEFAULT 'feed' CHECK (surface IN ('feed', 'story'))
-- PRIMARY KEY (post_id, channel_id)  ->  (post_id, channel_id, surface)
```

The widened key is what permits one post to target one Instagram channel **twice**, once per
surface. SQLite cannot alter a primary key, so this is a table rebuild following the pattern
migration `0008_platform_foundation.sql` established and documented: `PRAGMA foreign_keys =
OFF` before an explicit `BEGIN`, recreate `idx_post_targets_channel`, `COMMIT`, then `PRAGMA
foreign_keys = ON`. Existing rows backfill to `'feed'`, so current behaviour is unchanged.

### `publications` — additive, no rebuild

```sql
ALTER TABLE publications ADD COLUMN surface  TEXT NOT NULL DEFAULT 'feed'
                                             CHECK (surface IN ('feed', 'story'));
ALTER TABLE publications ADD COLUMN asset_id INTEGER REFERENCES assets(id) ON DELETE RESTRICT;
```

`asset_id` is **NULL for a feed send** (meaning "all of this post's assets, in order") and
**set for a story send** (meaning "this one slide").

Additive on purpose. `publications` carries three indexes and a cascading child
(`post_metrics`), which is exactly the situation `0008`'s header warns about — a rebuild here
would risk far more than the primary-key change on `post_targets` forces. No key changes, so
`ADD COLUMN` is sufficient and safer.

**Verified against SQLite (2026-08-03), not assumed:** `ADD COLUMN` accepts both a
`NOT NULL DEFAULT` + `CHECK` and a `REFERENCES ... ON DELETE RESTRICT` (the latter is legal
because the new column defaults to NULL), and both constraints are genuinely enforced
afterwards. `RESTRICT` only bites when foreign keys are on at runtime — they are, on every
connection (`dashboard/lib/db.ts`, `worker/db.py`).

### `posts.post_type` is deliberately not touched

The unused `'story'` value stays in the CHECK constraint. Removing it means a second table
rebuild for zero behavioural gain. The migration carries a comment recording that `'story'` is
**vestigial** and that the real story surface lives on `post_targets` / `publications`, so a
future reader does not reach for the wrong one. Nothing creates a post with
`post_type = 'story'`, and `publisher._validate` continues to refuse it.

### One ordering fix

`worker/db.py::fetch_due_publications` orders by `scheduled_at ASC` only, so ties break
non-deterministically. Slides of one Story **must** publish in order:

```sql
ORDER BY scheduled_at ASC, id ASC
```

Slides are inserted in `sort_order`, so ascending id is slide order. This also makes existing
queueing deterministic, which it currently is only by accident.

---

## 3. Choosing a surface — the channel picker

Selection today is a `Set<number>` of channel ids (`composer.tsx`). It becomes a set of
**channel + surface** pairs. The picker is shared, so the composer, schedule-from-library, and
the quick-edit dialog all inherit this from one component change. Roughly six `post_targets`
call sites in `dashboard/lib/queries.ts` carry the surface through.

- **Non-Instagram channels are visually unchanged** — one row, one checkbox, no new concept
  introduced where it does not apply.
- **Instagram channels** gain two selectable chips on the row: `Feed` and `Story`. Either,
  both, or neither.

This is what makes the owner's requirement legible: Telegram ticked, Instagram `Story` ticked,
Instagram `Feed` not — one photo, two destinations, the difference readable at a glance.

**Guards on the Story chip** — each states its reason rather than silently disabling:

| Condition | Behaviour |
|---|---|
| Text-only post | Chip hidden — a Story has nothing to show. |
| Video over Instagram's story length cap | Chip disabled, with the reason. Cap to be read from live docs, not assumed. |
| Multi-photo post | Chip **enabled**, with the note *"4 slides → 4 Stories."* |

That last note matters: the fan-out is stated before scheduling, never discovered at publish
time.

---

## 4. Worker — publishing

### Fan-out happens at scheduling time

Ticking `Story` on a 4-slide post inserts **4 publication rows immediately**, one per
`post_assets` row in `sort_order`, each with its `asset_id` set. All four are visible in the
queue before they go out and can be held, rescheduled, or canceled individually.

Publications are created in two places, so the fan-out rule is written twice — in
`dashboard/lib/queries.ts` (owner scheduling) and `worker/autofill.py` (automation) — with
tests on both sides. That duplication is the cost of the shared-DB contract (CLAUDE.md: the
database is the interface, there is no API between them), and is accepted here rather than
introducing one.

**Auto-fill stays feed-only for v1.** It will not queue Stories on its own. This keeps the
duplicated rule to a single code path that matters and is a scope cut, not a limitation of the
model — evergreen story recycling is an extra rule in `select_candidates`, addable later
without redesign.

### Two existing reads of `post_targets` that must become surface-aware

Both were found by inspection while planning; neither is optional, and both are silent-wrong
rather than loud-broken if missed:

1. **`worker/autofill.py:181`** — the candidate query matches `post_targets` on `channel_id`
   alone. Left as-is, a post targeted *only* at an Instagram Story becomes eligible for
   auto-fill to queue as an ordinary **feed** post. Needs `AND pt.surface = 'feed'`, which is
   also what actually implements "auto-fill stays feed-only".
2. **`worker/publisher.py:51`** (`_maybe_retire_one_time`) — decides a one-time post is spent
   once every targeted channel has posted it, comparing channels only. With two surfaces on
   one channel, the post would retire the moment the **feed** send succeeded, retiring content
   whose Story had not gone out. Must compare `(channel_id, surface)` pairs.

### The publish path

`_publish_instagram` gains a `story` branch:

1. Create container: `media_type=STORIES`, a single `image_url` **or** `video_url`, **no
   caption** — Stories have no caption field.
2. **Poll `status_code` until `FINISHED`.** Never skipped, per CLAUDE.md, including for
   images where it is usually immediate.
3. `media_publish`.

`_resolve_url` becomes surface-aware. For a story it prefers the **untouched original**
(`assets.storage_path`) over the feed-conformed derivative (`assets.publish_path`) — the
"let Instagram fit it" decision. An explicit external `public_url` still wins, as today. Feed
sends keep the existing `publish_path`-first precedence and `PlatformCaps.needs_conformed_media`
is unchanged.

**Why the original:** conformance targets the *feed* — 4:5 to 1.91:1, max 1440px wide
(`dashboard/lib/conform.ts`). A Story is 9:16 (0.5625), outside that range, so the conformed
derivative is actively the wrong image for a Story. A true 9:16 upload then lands correctly; a
square or landscape one receives whatever Instagram does to it automatically, which is what
happens posting it by hand.

`_validate` gains story rules: `asset_id` must be set and must belong to the post; exactly one
asset; `media_kind` of `image` or `video`; **no caption-limit check**, since no caption is sent.

### Publishing quota

No change needed. The worker already reads `content_publishing_limit` at runtime and never
hardcodes it (CLAUDE.md), so whether or not Stories count against the cap, the existing gate
behaves correctly. Worth stating precisely because a 10-slide Story is 10 publishes.

---

## 5. Metrics

- `_fetch_instagram` selects its metric list by `surface`: a story set (reach, replies, taps
  forward, taps back, exits) rather than the feed set. **These metric names are to be verified
  against live Meta docs before implementation** — `reference.md` carries a standing rule that
  the Stories adapter gets the same live verification the image/carousel path got.
- `publications_needing_metrics` **excludes story rows more than 24 hours past
  `published_at`**. The Story no longer exists; refreshing it only produces recurring errors.
  Whatever was captured while it was live is kept.
- **No new `post_metrics` columns.** `reach` maps to the existing column. `replies` already
  maps to `comments` via `COLUMN_MAP` (added for Threads) and is left to do so rather than
  special-cased — a story reply is the nearest thing a story has to a comment, and diverging
  per-surface would make the column mean two things. Taps and exits have no column and stay in
  `raw_json`, which exists for precisely this. Four columns serving one surface does not
  justify a rebuild, and nothing is lost.
- **The 24-hour cutoff belongs in the *automatic* branch only**, alongside the existing
  platform exclusion — not in the outer `WHERE`. `publications_needing_metrics` carries a
  comment explaining why: a manual refresh (`metrics_refresh_requested_at`) must still be able
  to select the row once, or `run_metrics`' `finally` block never clears the flag and the row
  is flagged forever.

---

## 6. Failure, edges, and safety

- **Per-slide independence is the point.** Slide 3 failing retries slide 3 on the existing
  backoff, leaves 1, 2, and 4 posted, and rests in a visible `failed`. The Library shows
  "Story 3 of 4 — failed". Never a silent partial, per CLAUDE.md.
- **`ON DELETE RESTRICT` on `publications.asset_id`** — deleting an asset a scheduled Story
  depends on is refused rather than quietly orphaning the send.
- **Queue grouping.** Sibling story rows group under one heading with a group-level "cancel
  all", so a 10-slide Story is not 10 clicks. The individual rows stay authoritative; the
  grouping is presentation only.
- **Kill switch and dry-run are untouched** and cover Stories automatically, since Stories are
  ordinary publications going through the ordinary worker loop.

---

## 7. Verification

In this order:

1. Migration applied to a **scratch copy** of the DB first — never the live one (`migrate.py`
   has no argument parser; every invocation migrates the real database).
2. **Python tests:** story validation rules, fan-out ordering, one-slide-fails isolation, the
   24-hour metrics cutoff, and the existing `test_platform_dispatch` registry guard.
3. **TypeScript tests:** surface round-trips through `post_targets` and survives edit and
   reschedule.
4. **`DRY_RUN=1` first.** This install publishes for real, so a dry run must confirm the plan
   shows the right number of story sends, with the right assets, and no caption — before
   anything reaches Instagram.
5. **One real Story to the personal account**, then read it back from the API to confirm it is
   genuinely a Story rather than a feed post — the same way the first real Reel was verified
   (`reference.md`, 2026-07-29).
6. Restart the worker afterwards — a live heartbeat proves the daemon is running, not that it
   is running current code.

---

## 8. Out of scope / deferred

- **A 9:16 story canvas** (1080×1920, blurred fill, centred image). Explicitly deferred: post
  real Stories with the original-bytes path first, and build this only if results actually
  look bad. To be logged in `tasks.md` rather than dropped.
- **Auto-fill queuing Stories** (evergreen story recycling) — see §4.
- **Facebook Page Stories.** The `surface` column is written generically so the Facebook
  adapter can adopt it when it lands; only Instagram is implemented here.
- **Story-specific captions or stickers/links.** Stories take no caption; link stickers are a
  separate API surface and not part of this.
- **Removing `'story'` from the `posts.post_type` CHECK** — see §2.

---

## 9. What good looks like

- Ticking `Story` on an Instagram channel while leaving `Feed` unticked, with Telegram ticked,
  sends one photo to two places with different treatment — and the screen said so beforehand.
- A 4-slide post aimed at Stories produces four Stories in slide order, and the composer said
  "4 slides → 4 Stories" before it was scheduled.
- One slide failing costs that slide only, visibly.
- No existing feed post, schedule, or metric changes behaviour after the migration.
