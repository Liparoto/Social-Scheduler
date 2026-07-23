# Design — Content Model (how content behaves, targets, and stays in-season)

_Date: 2026-07-23 · Status: proposed, awaiting review_

Sub-project ① of the content-management work (the others: ② tagging taxonomy, ③ bulk
import, ④ library overview). This one is the foundation the rest build on.

## Goal

Turn a "post" from a one-shot thing into managed **content** that knows: how it recycles,
when it's in-season, which accounts it's for, and what it can say — so automation can make
good choices without the owner hand-picking every time.

Constraints unchanged (`CLAUDE.md`): local-only, SQLite is the contract, schema lives in
`/migrations`, every install independent, favor legibility over polish.

## Decisions (settled in brainstorming)

1. **Recycling kind** — each post is `one_time` or `evergreen`.
   - `one_time`: posts **once per targeted account**, then the post **auto-retires**.
   - `evergreen`: recycles indefinitely, subject to a **cooldown** per account.
2. **Green periods** come from a **reusable period library**: named windows, each either
   **recurring yearly** (by month/day, wrap-around allowed like Dec 15–Jan 5) or **one-off**
   (specific dates). A post links to periods as **green** (in-season) or **blackout**
   (excluded). **Blackout wins** ties.
3. **Account targeting** is an explicit set of accounts per post. **"All" is a snapshot** —
   it expands to the accounts that exist at that moment; a newly added account receives
   nothing until deliberately targeted. A **bulk re-target** tool folds a new account into
   many posts at once.
4. **Captions**: a post has **1..N caption variants** (one is fine). A variant with no
   platform is **generic** and rotated for variety on reuse; a variant tagged to a platform
   is used for that platform. 
5. **Content status**: `draft` → `ready` → `retired`. New content defaults to **`draft`**
   (nothing auto-posts by accident). `one_time` content auto-retires once posted to all its
   targets.
6. **Cooldown**: `posts.cooldown_days` overrides the account's existing `reuse_min_age_days`
   when set; otherwise the account default applies.

## Schema (additive — migration `0002_content_model.sql`)

New columns on `posts`:
- `content_kind   TEXT NOT NULL DEFAULT 'evergreen' CHECK (content_kind IN ('one_time','evergreen'))`
- `content_status TEXT NOT NULL DEFAULT 'draft'     CHECK (content_status IN ('draft','ready','retired'))`
  _(a separate axis from the existing coarse `posts.status`: `content_status` governs
  automation eligibility; the old `status` stays as the overview lifecycle hint.)_
- `cooldown_days  INTEGER` (nullable; null = use the account's `reuse_min_age_days`)

New tables:
```
periods
  id INTEGER PK
  name           TEXT NOT NULL UNIQUE
  recurs_yearly  INTEGER NOT NULL DEFAULT 1        -- 1: yearly by month/day; 0: one-off dates
  start_month INTEGER, start_day INTEGER           -- used when recurs_yearly = 1
  end_month   INTEGER, end_day   INTEGER
  start_date  TEXT, end_date TEXT                  -- ISO dates, used when recurs_yearly = 0
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP

post_periods
  post_id   INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE
  period_id INTEGER NOT NULL REFERENCES periods(id)  ON DELETE CASCADE
  mode      TEXT NOT NULL CHECK (mode IN ('green','blackout'))
  PRIMARY KEY (post_id, period_id, mode)

post_targets
  post_id    INTEGER NOT NULL REFERENCES posts(id)    ON DELETE CASCADE
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE
  PRIMARY KEY (post_id, channel_id)

caption_variants
  id INTEGER PK
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE
  platform   TEXT                                   -- NULL = generic (rotated); else 'instagram'/'facebook'/...
  body       TEXT NOT NULL
  sort_order INTEGER NOT NULL DEFAULT 0
```
`tags`/`post_tags` are untouched (sub-project ②). `posts.caption` is kept as a fallback and
mirror; `caption_variants` becomes the source of truth going forward.

### Backfill (so nothing existing disappears)
- Existing posts → `content_kind='evergreen'`, `content_status='ready'`.
- `post_targets` ← the distinct channels each post already has publications for.
- `caption_variants` ← one generic variant per existing post from `posts.caption` (when non-empty).

## Eligibility — "can this post go to account X at time T?"

All gates must pass; then the **existing** performance/recency ranking picks among winners.
```
content_status = 'ready'
AND account X ∈ post_targets
AND (post has no green periods) OR (T ∈ some green period)     -- in-season
AND T ∉ any blackout period                                   -- blackout wins
AND cooldown ok:
      evergreen → last publish to X older than (cooldown_days ?? channel.reuse_min_age_days)
      one_time  → X has no successful publish of this post yet
```
- **Period windows are evaluated in the channel's timezone**, so "Winter" boundaries land on
  the local date. Yearly wrap-around (start month/day after end month/day) means the window
  spans the New Year.
- **Implementation:** status/targets/cooldown are expressible in SQL (extends the current
  `autofill.select_candidates` query); the period date-window math (yearly recurrence +
  wrap-around) is done in Python for clarity, filtering the SQL candidates.
- **Manual compose is not hard-blocked** by these gates — the owner can post anything, anytime.
  The dashboard may *warn* when manually scheduling out-of-season or into a blackout, but the
  gates govern **automation** (auto-fill).

## Behaviors

- **One-time retirement:** after a `one_time` post has a successful publish to *every* channel
  in its `post_targets`, set `content_status='retired'`. Checked in the worker after a
  successful publish.
- **Caption selection at publish:** if a caption variant matches the channel's platform, use it;
  otherwise rotate through the generic variants (least-recently-used by that post's publish
  count) so reuse doesn't read identically. Falls back to `posts.caption` if no variants exist.
- **Bulk re-target (library):** filter + multi-select posts → add/remove a channel target (and,
  later, a period or tag) across all selected in one action. This is how a newly added account
  gets folded into existing "all" content.

## What changes where

- **Schema:** `migrations/0002_content_model.sql` (additive + backfill).
- **Worker:** `autofill.py` selection gains the eligibility gates; `publisher.py` gains caption
  -variant selection and one-time retirement; small period-window helper module
  (`worker/periods.py`) for the recurrence/wrap-around math.
- **Dashboard (Phase B):** compose screen gains kind/status/targeting/periods/captions; a small
  **Periods** manager; the **library** gains bulk actions and shows kind/status/season/targets.

## Build sequence (within this sub-project)

- **Phase A — data + logic (headless-verifiable):** migration + backfill, worker eligibility,
  retirement, caption rotation, period math, and tests. Verify with seeded data before any UI.
- **Phase B — dashboard UI:** compose fields, periods manager, library bulk actions + content
  overview columns.

Splitting this way means the automation engine is proven before we build screens on top of it.

## Testing / verification

- **Period math:** in/out of a yearly window; wrap-around across New Year; one-off dates;
  timezone boundary correctness.
- **Eligibility:** status gate; target membership; green in/out; blackout overrides green;
  evergreen cooldown (per-post override vs channel default); one-time "not yet posted to X".
- **Retirement:** one-time flips to `retired` only after *all* targets have posted, not before.
- **Captions:** platform-specific chosen when present; generic rotation otherwise; fallback to
  `posts.caption`.
- **Targeting:** "all" snapshot expands to current channels; bulk re-target adds a channel to
  many posts; backfill maps existing publications → targets.
- Full worker suite stays green; dashboard `tsc` clean (Phase B).

## Out of scope (deliberately, for later sub-projects)

- Tag **kinds**/taxonomy (platform, time-of-day, theme) — sub-project ②.
- Bulk **import** of an archive + AI caption/tag suggestions — sub-project ③.
- The full **library overview** UX and asset-folder organization — sub-project ④.
- Non-Instagram platforms actually connecting (X/Telegram) — the caption `platform` slot and
  targeting are built to accommodate them, but adapters come later (Phase 6).
