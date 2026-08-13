# Calendar view — week and month

Date: 2026-08-12
Status: approved (placement + full interactivity confirmed by the owner)

## Why

The Overview table answers "what is this one send doing?" It cannot answer "does next
week look thin?" or "did we post twice on Tuesday and nothing on Thursday?" Those are
shape questions, and a table is the wrong instrument for them.

## Placement

Its own page at `/calendar`, new nav entry directly under Overview. The Overview table is
untouched: the table is for acting on a send, the calendar is for seeing the shape of the
schedule. A Week / Month toggle lives inside the page.

## What a send's date means

The same rule the queue now uses (`lib/send-time`): a posted send is placed by
`published_at`, everything else by `scheduled_at`. A post that slipped to the next morning
appears on the morning it actually went out, because that is where someone looking for it
would expect it.

**Placed by its CHANNEL's local date**, using `splitInTz`. The queue already shows every
time in channel-local terms, and this install genuinely mixes zones (a Pacific default
with `America/New_York` channels — deliberate, see the owner's notes). The alternative —
one grid timezone for everything — would show a 12:30 PM Eastern send sitting in the 9:30
AM row, contradicting every other screen. The cost is that two sends in the same cell can
show different clock times; each is correct for its own account, and the channel chip says
whose it is.

"Today" is highlighted using the install's default timezone, since the grid itself needs
one answer.

## Views

**Month** — 6 rows × 7 columns, Sunday-start, always six rows so the grid does not resize
as you page through. Days outside the month are dimmed but still real (they show their
sends). Each cell: the day number, then a compact chip per send — thumbnail, channel
colour, time, status tint. Beyond three chips a cell shows "+N more".

**Week** — seven day columns, each listing its sends full-width with more room: thumbnail,
caption snippet, channel chip, time, status badge. No hour grid; sends here run one or two
a day, so an hour-by-hour ruler would be almost entirely empty space.

Both views share one header: `‹ ›` to page, "Today" to return, the range as a title, and
the counts for the visible range.

## Interactions

All three, as requested:

1. **Click a send** → opens that post (`/library/<post_id>`), where its sends, caption and
   assets already live. The calendar does not duplicate the editor.
2. **Click an empty day** → `/compose?date=YYYY-MM-DD`. The compose page already threads a
   `defaultDate` prop; this only makes it read the query string before falling back to
   tomorrow. Filling a gap you just spotted becomes one click.
3. **Drag a send to another day** → reschedules it, keeping its time of day and changing
   only the date.

### Dragging, specifically

Native HTML5 drag-and-drop. No library: the project's rule is to avoid dependencies that
do not earn themselves, and a drag that only needs "which day did this land on" does not
justify a drag framework.

- **Only what can move is draggable.** The existing reschedule API accepts
  `scheduled` and `pending_approval` only, so those are the only draggable chips. A posted
  or in-flight send is not draggable at all, rather than draggable-then-rejected: the
  cursor should tell the truth before the drop, not after.
- **Reuses `POST /api/publications/<id>/reschedule`** with `{date, time}` — the same
  endpoint the queue's Reschedule control uses. It already resolves the channel's timezone
  and re-guards the status server-side, so the drag inherits every existing protection
  instead of inventing a parallel path.
- **Time of day is preserved.** A drop changes the day only; the send keeps its channel-
  local clock time. Moving a post to Friday should not silently move it to midnight.
- Dropping a send on the day it already occupies is a no-op — no request.

## Data

One new query, `getPublicationsInRange(startIso, endIso)`, returning the same shape the
Overview already uses so the chip can reuse the queue's status and channel components.
The range is widened by a day at each end before querying, because a channel-local date
can fall outside the UTC range that produced it.

## Non-goals

- No hour-of-day grid. Volume does not warrant it.
- No creating a send by dragging from the library onto a day. Compose covers it.
- No drag between *times*, only between days.
- No new schema. Every field involved exists.

## Testing

`lib/calendar` is pure date math and gets unit tests: month grids (including a month that
needs six rows and one that does not), week ranges, paging across a year boundary, and
bucketing sends by channel-local date rather than UTC date.

Route test for the compose `?date=` prefill, including a malformed value falling back to
tomorrow rather than rendering a broken input.

Browser pass against a copy of the live database: both views render the real schedule,
a drag moves a send and the row's `scheduled_at` changes while its time of day does not,
and a posted send refuses to drag.
