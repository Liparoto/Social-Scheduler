# Channel groups (coordinated auto-fill)

**Date:** 2026-07-30
**Status:** Approved, not yet implemented

## Problem

Auto-fill is scoped to a single channel. `run_autofill` (`worker/autofill.py:200`) selects
every active, auto-fill-enabled channel and tops each one up in isolation:

```python
channels = conn.execute(
    "SELECT * FROM channels WHERE is_active = 1 AND autofill_enabled = 1"
).fetchall()
```

Each iteration reads that channel's own `cadence_config`, its own queue depth, its own
cooldown, and ranks candidates by performance measured on that channel alone. There is no
cross-channel coordination anywhere in the module.

The consequence: enabling auto-fill on an Instagram channel and a Threads channel that
represent the *same* account produces two unrelated streams. They pick different content,
on different days, at different times. There is no way to say "these two accounts are one
voice — post the same thing to both."

The storage layer is not the obstacle. A `publication` is
`(post_id, channel_id, scheduled_at, status, ...)`, so two channels publishing the same
content at the same moment is simply two publication rows sharing a `post_id` and a
`scheduled_at`. The manual paths already fan out this way
(`dashboard/lib/queries.ts:456`). Only the auto-fill *selection loop* treats channels as
islands.

## Scope

- Introduce a **channel group**: a named set of channels that auto-fill as one unit — one
  cadence, one selection decision, one slot, one publication per member.
- Move auto-fill configuration to the group for grouped channels.
- Support several independent groups per install (e.g. a personal group and a business
  group), each with its own cadence.
- Leave ungrouped channels behaving exactly as they do today.

Out of scope: a mirrored presentation in the calendar or queue (two publications at the
same timestamp already read correctly); changing how manual scheduling, publishing,
metrics, or caption variants work; and revisiting Threads' video capability (see
"Follow-up work").

## Key decisions

### Mirroring is same-post, same-moment

A group produces one selection decision per slot and writes every eligible member at an
identical `scheduled_at`. Members do not keep individual cadences. The alternatives —
shared content on independent schedules, or a leader/follower mirror — were rejected: the
first does not deliver coordination, and the second cannot check the follower's rules
*before* choosing content, which is exactly what the eligibility model below requires.

### Rules block the group; capabilities do not

For a post `P` and a member channel `M`, two questions are asked separately.

**`capable(M, P)`** — can the platform physically accept it?

- media type: `single`/`carousel` need assets; `reel` needs
  `PLATFORM_CAPS[platform].supports_video`; `text` needs `supports_text`
  (`worker/clients.py:113`)
- caption length: the resolved caption variant must fit the platform's
  `caption_limit(post_type)`

**`allowed(M, P)`** — do the rules permit it?

- `post_targets` opt-in for this channel
- `posts.content_status = 'ready'`
- evergreen cooldown (`posts.cooldown_days`, falling back to the group's
  `reuse_min_age_days`) measured against `last_posted` on that member
- `content_kind = 'one_time'` not yet posted on that member
- green/blackout periods, evaluated in the group's timezone (blackout wins)
- not already queued on that member

`P` is **group-eligible** when both hold:

1. at least one member is capable **and** allowed, and
2. every member that is **capable** is also **allowed**.

A capability mismatch makes that member sit the slot out. A rule mismatch blocks the whole
group.

This asymmetry is the point. Threads is declared `supports_video=False`
(`worker/clients.py:125`), so under a uniformly strict intersection a group containing
Threads would never auto-fill a Reel — silently ending the evergreen video recycling that
`docs/tasks.md:681` names as a primary goal. Treating capability as an exception keeps
Reels flowing to Instagram while a cooldown or blackout on either member still holds both
back, so the accounts never drift apart on content they could both have taken.

Caption length is classified as a **capability**, not a rule, for the same reason: a post
whose Threads variant exceeds 500 characters queues to Instagram alone rather than
blocking the group.

### Group ranking uses the best member, not the sum

Candidate ordering today is:

```sql
ORDER BY
  CASE WHEN last_posted IS NULL THEN 0 ELSE 1 END ASC,  -- never posted here first
  perf DESC,                                             -- reach + saves on THIS channel
  last_posted ASC,                                       -- stalest
  p.created_at ASC                                       -- oldest
```

`perf` comes from `post_metrics` joined through `publications`, so it is inherently
per-channel. Threads reports neither reach nor saves, so `perf` is always 0 there.

For a group, `perf` is the **maximum** across members and `last_posted` is the most recent
post on **any** member; tier 0 means never posted on any member. Summing was rejected
because adding a metrics-less platform to a group would halve every score and scramble an
ordering that is otherwise driven entirely by Instagram's real numbers.

Note that cooldown still uses each member's own `last_posted` — only the *ranking*
aggregates.

### Cadence lives on the group only

A grouped channel has one schedule, full stop. Allowing a channel to auto-fill both as a
group member and on an extra solo schedule was considered and rejected: it makes
queue-depth accounting ambiguous (does a solo post satisfy the group's minimum?) and the
Channels page would have to present two competing cadences for one account.

## Data model

New migration `migrations/0013_channel_groups.sql`:

```sql
CREATE TABLE channel_groups (
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
```

The group deliberately carries the same auto-fill field names a channel already has, so
`parse_weekly_cadence`, `weekly_date_slots`, and `band_times` accept a group row without
modification.

Nothing is dropped from `channels`. A grouped channel's own `autofill_enabled`,
`cadence_config`, `min_queue_depth`, `target_queue_depth`, and `reuse_min_age_days` simply
go unread while `group_id` is set, and become authoritative again if it is cleared.

`ON DELETE SET NULL` means deleting a group returns its channels to solo operation rather
than cascading into `publications`. This is the opposite of the `ON DELETE CASCADE` used
by `channels`' own children, and is intentional: a group is a scheduling convenience, not
an owner of content.

**Migration is additive and backwards compatible.** Every existing channel gets
`group_id = NULL` and continues to behave exactly as it does today.

## Auto-fill logic

`run_autofill` iterates **units** instead of channels:

- each active, auto-fill-enabled `channel_group` → one unit, whose members are its
  channels **where `is_active = 1`** (a member's own `autofill_enabled` is not consulted)
- each active, auto-fill-enabled channel where `group_id IS NULL` → one unit of itself

A solo unit runs the existing code path unchanged.

A group with no active members is skipped with a log line. A group with exactly one active
member behaves identically to a solo channel — the eligibility rules degenerate correctly,
so no special case is needed.

For a group unit:

| Concern | Source |
|---|---|
| cadence, timezone, queue depths, `reuse_min_age_days` | the group row |
| queue depth measurement | count of **distinct future `scheduled_at` values** across all members |
| slot start point | the latest future `scheduled_at` across all members, else `now` |
| slot times | unchanged — each candidate's `time_of_day` tag, falling back to the cadence time |
| `requires_approval` | each **member channel** individually |

Distinct slots rather than row count is the honest measure of depth, because a group
writes one row per member at a single timestamp — counting rows would report a two-member
group as twice as full as it is.

`requires_approval` stays per-channel because it describes the account, not the schedule.
A group may contain one member that needs approval and one that does not; each member's
publication gets its own `status` accordingly.

Insertion is one `publications` row per capable-and-allowed member, sharing `post_id` and
`scheduled_at`, with `created_by = 'autofill'` as today.

## Dashboard

- `dashboard/app/api/channel-groups/` — CRUD for groups.
- `PATCH /api/channels/[id]` accepts `group_id` to assign or unassign a channel.
- The Channels page gains a **Groups** section: create, rename, and delete groups, assign
  channels to them, and edit the group's cadence using the existing `AutofillConfig` form
  pointed at a group instead of a channel.
- A grouped channel's own auto-fill form is replaced with a line reading "Auto-filled as
  part of *<group name>*", linking to the group's settings.

Group timezone follows the same rule as `channels.timezone`: it is rejected by the generic
PATCH and changed only through a dedicated `POST /api/channel-groups/[id]/timezone`, which
rebases the group's pending queue — mirroring
`dashboard/app/api/channels/[id]/timezone` (`dashboard/app/api/channels/[id]/route.ts:34`).

## Testing

Worker tests, written TDD alongside the existing suite in `worker/tests/test_autofill.py`:

- a cooldown or blackout on one member blocks the post for the whole group
- a Reel queues to the Instagram member alone when a Threads member is present, and both
  members land on the same `scheduled_at` for an image post
- a caption that fits Instagram but exceeds Threads' 500-character limit queues to
  Instagram alone
- a post targeted at only one member of a group is never selected for the group
- group queue depth counts distinct slots, not publication rows, so a two-member group
  does not stop refilling at half its target
- group ranking prefers the best-performing member rather than the sum
- ungrouped channels produce byte-identical behaviour to the current implementation
- deleting a group clears `group_id` on its members and leaves their publications intact

Live verification: create a group containing the personal Instagram and Threads channels,
set a cadence, run the worker, and confirm the queue shows paired publications at
identical timestamps — with any Reel appearing on Instagram only.

## Follow-up work (not part of this design)

Threads supports video in reality, but `worker/clients.py:125` declares
`supports_video=False`. Confirming this against the current Threads API and updating
`PLATFORM_CAPS` is worthwhile, but independent: if Threads gains video support, the
capability exception simply stops firing for Reels and nothing in this design changes.
