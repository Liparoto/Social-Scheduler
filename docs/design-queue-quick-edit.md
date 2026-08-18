# Design — Quick edit from the Overview queue

**Date:** 2026-08-17
**Status:** approved, not yet built

## The problem

The Overview queue shows every send that is about to go out, and it already lets you
change *when* it goes out (Reschedule) or *whether* it goes out (Hold, Cancel, Retry).
It does not let you change *what goes out*. Spotting a typo in a caption on the Overview
means navigating to the Library, finding the post again, and editing it there — with the
queue row that prompted the trip no longer on screen.

The last-minute caption fix is the whole point of looking at the queue. It should happen
where you noticed the problem.

## What we're building

An **Edit** button on Overview queue rows that opens the Library's existing
`QuickEditModal` over the queue.

Nothing about the editing itself is new. It is the same dialog, the same fields, the same
`PATCH /api/posts/[id]/content`, the same confirm-on-discard behaviour. The only new work
is getting the dialog the data it needs from a page that doesn't currently carry it.

## Why reuse the quick edit dialog

Three candidates were considered:

- **A new caption-only dialog** — smallest, but you would still leave for a tag or a
  status change, and it would be a second write path to keep correct.
- **The full `/library/[id]` editor in a modal** — the most power, but it is a 600-line
  editor built as a page, with media, targets and scheduling. Media and targets are not
  last-minute changes, and the dirty-state guarantees that page makes are page-shaped.
- **The Library's `QuickEditModal`** — captions (including per-platform variants), tags,
  status, kind, cooldown, period links and carousel order. Exactly the set of things you
  change in the minute before a post goes out, and it is already built, already guarded,
  and already the only non-full-editor write path. **Chosen.**

## Which rows get the button

Offered on: `scheduled`, `pending_approval`, `failed`, and held rows.

Withheld on:

- **`publishing`** — the worker has already read the caption and is mid-flight to Meta.
  An edit here would save to the DB and change nothing about what is being posted.
- **`posted`** — Instagram's API cannot edit a live caption. A button here would appear
  to fix a live post and would not.

A button that cannot do what it appears to do is worse than no button. The rule is: the
button exists only where pressing it changes what actually publishes.

## How the data reaches the dialog

`QuickEditModal` needs a post's `content_status`, `content_kind`, `cooldown_days`,
`tag_ids`, `periods`, `target_platforms`, `asset_count` and `queued_publication_count`.
A queue row is a **send** — it carries `post_id` and send-shaped data, none of the above.

Two options:

1. **Widen `PUBLICATION_ROW_SELECT`** so every queue row carries its post's content model.
   Rejected: the Overview ships the entire queue, and a post with four sends would ship
   its tags and period links four times, to serve a dialog that opens one post at a time.
2. **Fetch on open.** The dialog *already* fetches from `GET /api/posts/[id]/content` —
   captions are kept out of the Library list query for exactly this reason. Extend that
   same route to also return the content-model fields, and put a thin loader in front of
   the modal that fetches once and mounts it with real data. **Chosen.**

`periods`, `timeOfDayTags` and `topicTags` are small, stable lists. The Overview page
reads them server-side with `listPeriods()` / `listTags()` and passes them down, exactly
as `/library` already does.

## The caption belongs to the post, not the send

This is the one genuinely new hazard. A queue row is one channel's send, but the caption
is a property of the post. Editing from a row headed to Instagram also changes the copy
going to Facebook and to every other queued send of that post.

The dialog will carry a line stating how many queued sends the change affects, alongside
the reorder notice that already does this for slide order. The information already exists
(`queued_publication_count`); it just needs saying where the edit is happening.

## After a save

`onSaved` closes the dialog and calls `router.refresh()`, so the queue row re-renders with
the new caption rather than showing stale text next to a save that just succeeded.

## Accepted trade-off: story groups

A four-slide story is four queue rows sharing one post, so it shows four Edit buttons that
all open the same dialog. Each row genuinely *is* its own send, and the alternative —
hoisting Edit onto `StoryGroupHeader` for grouped rows while keeping it per-row otherwise —
means two placements and two sets of visibility rules for one button. The repetition is
accepted.

## Out of scope

- Editing media, targets or the schedule from this dialog. Reschedule already exists on
  the row; media and targets live in the full editor.
- Any change to how `PATCH /api/posts/[id]/content` validates or writes.
