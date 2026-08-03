# Library bulk edit — selected-post context design

**Date:** 2026-08-03
**Status:** approved in conversation; awaiting written-spec review
**Extends:** `2026-08-02-library-bulk-edit-design.md`

## Problem

The bulk-edit modal lists every available tag and period, but it does not show which values are
already attached to the selected posts. Removal therefore requires guessing, and values that are
shared by all selected posts look identical to values used by none of them.

The modal is also narrower than the available screen, making the independent add/remove columns
more cramped than necessary.

## Decisions

- Load fresh, read-only metadata context when the modal opens.
- Count coverage against the exact selected post set.
- Use three consistent states: **all**, **some**, and **none**.
- Widen the modal from `max-w-3xl` to `max-w-6xl`.
- Keep the existing review and atomic write flow unchanged.
- Add no migration and no dependency.

## Context endpoint

Add `POST /api/posts/bulk-edit/context` with this request:

```json
{ "post_ids": [7, 17, 18] }
```

The route validates a non-empty, deduplicated integer list and rejects any unknown post before
querying context. It returns aggregate counts, not one response object per post:

```json
{
  "post_count": 3,
  "tags": [
    { "tag_id": 4, "count": 3 },
    { "tag_id": 9, "count": 1 }
  ],
  "periods": [
    { "period_id": 6, "mode": "green", "count": 3 },
    { "period_id": 8, "mode": "blackout", "count": 1 }
  ],
  "content_statuses": [
    { "value": "ready", "count": 2 },
    { "value": "draft", "count": 1 }
  ],
  "content_kinds": [{ "value": "evergreen", "count": 3 }],
  "cooldowns": [
    { "value": null, "count": 2 },
    { "value": 90, "count": 1 }
  ]
}
```

One grouped query function in `dashboard/lib/queries.ts` performs the reads. Tag coverage is keyed
by tag id. Period coverage is keyed by the exact `(period_id, mode)` link, so green and blackout
for the same named period never get conflated. Scalar counts include `null` cooldown as “channel
default.”

## Modal behavior

The modal shows a small legend and uses the same meaning everywhere:

- **Green — All N:** present on every selected post.
- **Amber — X of N:** present on at least one but not every selected post.
- **Gray — None:** present on no selected post.

### Tags

The Add column shows every available tag with its coverage. Tags already present on all selected
posts are visible but disabled because adding them is a no-op. Partial and absent tags remain
selectable.

The Remove column shows only tags whose count is greater than zero. Tags shared by all selected
posts sort before partial tags. If none are removable, show an explicit empty message instead of
an empty collection.

### Periods

Period coverage follows the same rules, but green and blackout are separate exact links. In the
Add column, an exact mode already present on all selected posts is disabled. In the Remove column,
an exact mode with zero coverage is unavailable and hidden. The period name stays visible when at
least one of its modes is removable.

### Scalar summary

A compact “Current selection” section appears above the editable status, kind, and cooldown
controls. It lists each current value and count, for example `Ready 6/8`, `Draft 2/8`, or
`Channel default 5/8 · 90 days 3/8`. A single value covering all posts reads as common; multiple
values make the mixed state explicit.

### Loading and errors

Opening the modal starts the read. While loading, metadata controls show a loading state and
cannot advance to review. A failed context request shows an error with a Retry action; it never
falls back to misleading zero counts.

After a successful bulk edit the modal closes and the existing Library refresh runs, so no
in-modal context refresh is required.

## Testing

- Query tests prove all/some/none counts, exact green/blackout separation, scalar distributions,
  and deduplicated post ids.
- Route tests prove empty, malformed, and unknown post ids return 400.
- UI-helper tests prove coverage classification, Add disabling, Remove filtering/sorting, and
  scalar labels.
- TypeScript, changed-file lint, production build, dashboard suite, and worker suite remain clean.

## Out of scope

- Per-post drill-down from the modal.
- Undo or a metadata history log.
- Changing the bulk-edit write contract or transaction behavior.
- Persisting context snapshots; the endpoint always reads current local database state.
