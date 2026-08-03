# Library period visibility — design

**Date:** 2026-08-02
**Status:** draft — awaiting owner review. **One open decision blocks part C** (§Open question).
**Related:** pairs naturally with bulk edit (`2026-08-02-library-bulk-edit-design.md`) — the
filter here turns bulk editing into "filter to a season → select all → apply".

## Problem

Three related asks, all about periods being effectively invisible outside the single-post editor.

**(a) You cannot see which periods a post has.** The card renders `green ×2` — a *count*. To
learn the names you must open the post.

**(b) You cannot filter by period.** There is no way to answer "show me everything attached to
Football Season."

**(c) You cannot tell what is actually eligible today.** A `ready` post attached to Football
Season looks identical in August (dormant) and October (live). `content_status='ready'` and
*eligible right now* are orthogonal, and only one of them is visible.

## Root cause of (a)

`listPosts()` in `dashboard/lib/queries.ts` computes only:

```sql
(SELECT COUNT(*) FROM post_periods pp
  WHERE pp.post_id = p.id AND pp.mode = 'green') AS green_period_count
```

The period **names never leave the database**. `library-view.tsx:505` renders what it is given,
and all it is given is `2`. This is a query-layer gap, not a UI gap.

`getPostPeriods()` already returns the real rows, but it is per-post — calling it per card is
N+1 across 139 posts.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Period data in the list | Return period **rows** (`id`, `name`, `mode`) per post | A count cannot be rendered as a name |
| Query shape | `GROUP_CONCAT` **or** one batched second query | Never `getPostPeriods()` per card — N+1 across 139 posts |
| Filter selection | **Multi-select** (`Set<number>`) | The owner asked for one or many. Departs from the existing single-select filters — see below |
| Filter semantics | **OR** within the period filter, **AND** with other filters | Matches how the existing chips compose |
| Filter covers | green **and** blackout | "What is blacked out during X" is as useful as the inverse |
| Season math | **Port to TypeScript**, port its tests with it | The worker has no API surface — the DB is the contract, by design |
| Authority | The **worker** stays authoritative | The badge is a glance aid, never what decides a publish |
| Migration | **None** | |
| New dependencies | **None** | |

### The filter breaks the existing pattern — deliberately

Every current Library filter is single-select: `tagFilter: string | null`,
`statusFilter: "all" | "draft" | ...`. The period filter is the first multi-select one. Model it
on `chans` (`Set<number>`), **not** on the other filters.

## Architecture

### Part A — names reach the card

Widen `listPosts()` to return the rows, update the `PostRow` type, and replace the `green ×N`
render with named chips. Blackout chips must be visually distinct from green — they mean the
opposite thing.

### Part B — the filter

`periodFilter` as a `Set<number>` in `library-view.tsx`, AND-combined with the existing tag /
platform / status / kind / format / search filters, feeding the existing "showing N of M" count.

### Part C — the in-season indicator ⚠️ the risky part

**This is not a UI task.** `worker/periods.py` holds `period_contains` + `in_season`. There is
**no TypeScript equivalent anywhere** in `dashboard/lib/`. A new `dashboard/lib/periods.ts` must
reproduce it exactly.

A wrong port produces the worst outcome available: **the dashboard says "green lit" while the
worker skips the post.** A badge that lies is worse than no badge at all.

Four rules that must survive the port:

1. **Wrap-around years.** Football Season is Aug 25 → Feb 15, i.e. `start > end`. The Python uses
   a `month*100 + day` key and flips to `cur >= start or cur <= end` when the window crosses New
   Year. Naive date comparison silently breaks **every** winter season — Football, Christmas,
   New Year, Basketball.
2. **Blackout wins.** Checked first, short-circuits.
3. **No green periods ⇒ always in season.** The rule is *"if green periods exist, one must
   contain today."* An unattached post is **eligible**. Inverting this mislabels most of the
   library.
4. **One-off periods** use `start_date` / `end_date` ISO strings, not month/day.

**Badge states** — combines `content_status` with the season verdict, since they are orthogonal:

| `content_status` | Season verdict | Badge |
|---|---|---|
| `ready` | in season | **Live** — eligible for auto-fill now |
| `ready` | out of season | **Dormant** — ready, but its season is closed |
| `ready` | blacked out | **Blocked** — a blackout period covers today |
| `draft` / `retired` | any | existing status chip; season is moot |

This is the owner's stated example: a `ready` football post in August should read **Dormant**,
and the same post in October should read **Live**.

## Open question — which timezone does the badge use?  ⚠️ blocks Part C

`in_season` is evaluated against a **local date in the channel's timezone**. A post can target
several channels in different zones, and this install genuinely mixes `America/Los_Angeles` and
`America/New_York` (deliberately — see `docs/tasks.md`). On a boundary day a post can be in
season for one target and not another. **A single Library badge cannot be per-channel.**

**Recommendation:** evaluate against `config.defaultTimezone` (`DEFAULT_TIMEZONE`) and name that
timezone in the tooltip. Rationale: the badge is a glance aid, the worker remains authoritative,
and the disagreement window is one day at a season boundary.

**Alternative considered:** a per-target breakdown. Better information, but it does not fit on a
card — it belongs on the post editor, where there is room.

**Needs owner sign-off before Part C is built.** Flagged rather than picked by accident.

## Out of scope

- Any change to how the worker evaluates seasons. The worker is authoritative and untouched.
- Editing periods from the Library — that is the bulk-edit and quick-edit sub-projects.
- A calendar/timeline view of the season year.
- Saved filter views.

## Risks

| Risk | Mitigation |
|---|---|
| TS/Python season math drift | Port the Python test cases verbatim; cross-check against the real Python before shipping; badge advisory, worker authoritative |
| Wrap-around bug (silent, seasonal) | Explicit boundary test table — Dec 1 in, Aug 1 out, Feb 20 out, both boundary days in |
| Inverting "no periods ⇒ in season" | Named test case; it would mislabel most of the library |
| N+1 across 139 posts | Batch the period query; verify query count does not scale with post count |
| Badge disagrees with worker at a zone boundary | Documented in the tooltip; the open question above decides the rule |
