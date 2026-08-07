# A collapsible bulk bar on the Library page

**Date:** 2026-08-07
**Status:** designed

## The problem

The Library page is where content gets reviewed, and the bulk bar is the tallest thing on it.

`library-view.tsx:783` pins a `sticky bottom-4` panel that stacks six things vertically: the
selection count, the cadence inputs (Every / Time / Starting), a channel chip row, the summary
line plus **Bulk schedule**, then three divider-separated sections for targeting, metadata, and
merge. It follows the grid down as you scroll, so the space it costs is permanent, not just at
the bottom of the page.

Reviewing content and bulk-scheduling content are different activities. The bar is essential to
the second and pure overhead during the first — and every one of its actions is disabled while
nothing is selected, which is exactly when someone is reviewing.

## Decisions

**Collapse to a slim row, never to nothing.** A bar that vanishes has no handle to bring it
back. Collapsed, it keeps one header row: a label, the live selection count, and a chevron.

**Remember the choice in `localStorage`, defaulting to expanded.** This is a per-person UI
preference, not publishable content — putting it in SQLite would mean a migration, a schema
change, and a sync concern between two processes to remember whether someone likes a panel
open. Defaulting to expanded means a fresh clone behaves exactly as it does today; the change
only ever happens because someone asked for it.

**Selecting posts while collapsed does NOT auto-expand it.** Selecting is part of reviewing.
Springing the panel open would hand back the space at the precise moment the user is using it.
The count in the collapsed header is what confirms the selection registered.

**Read the stored value through `useSyncExternalStore`, not a mount effect.** Reading
`localStorage` during render is a hydration mismatch waiting to happen — the server cannot know
what this browser last chose. `EmojiHint` already solved the same problem this way on
2026-08-07, and the pattern also stays clear of the lint rule banning synchronous `setState`
inside an effect. The cost is one frame rendered expanded before a collapsed bar settles, which
is the right trade against shipping a hydration bug.

**Keep the bar inline in `library-view.tsx`; do not extract it.** It is roughly 150 lines but
reads a dozen pieces of parent state (`everyDays`, `time`, `startDate`, `selected`, `pending`,
`error`, `notice`) plus four handlers (`schedule`, `retarget`, `setBulkEditOpen`,
`setMergeOpen`). Extracting it would mean a wide props interface and a diff far larger than the
feature justifies. Noted honestly: that file is already 990 lines, and this leaves it that way.
A future task that genuinely needs the bar standalone is the right moment to split it.

## How it works

### `dashboard/lib/use-persisted-toggle.ts` (new)

```
usePersistedToggle(key: string, defaultOn: boolean): [boolean, (next: boolean) => void]
```

A `localStorage`-backed boolean built on `useSyncExternalStore`:

- `getServerSnapshot` returns `defaultOn`, so the server renders the default and hydration
  matches.
- `getSnapshot` reads `localStorage`, cached per key so it returns a stable value across calls
  — an unstable snapshot makes `useSyncExternalStore` re-render forever.
- The setter writes storage, updates the cache, and notifies subscribers, so two components
  sharing a key stay in step.
- Every storage access is wrapped: a browser with storage disabled, or a private window that
  throws on access, degrades to the default rather than taking the page down.

Its own module because it is the only part with real edge cases, and it is testable without
rendering the Library at all.

### `dashboard/components/library-view.tsx` (modified)

The existing `sticky bottom-4 z-20` container gains a header row and wraps its current contents
in a conditional:

- **Header (always visible):** a `<button>` spanning the row — `aria-expanded`, and
  `aria-controls` pointing at the panel's id — containing the label "Scheduler & bulk edits",
  the live count (`N selected`), and a chevron that rotates with state. The whole row is the
  target rather than the chevron alone.
- **Panel (expanded only):** everything the bar renders today, unchanged, given an `id` for
  `aria-controls`.

**`z-20` on the container is load-bearing and must not move.** The comment above it records
why: the thumbnails' `MediaBadge` sits at `z-10` and punched through the bar's opaque
background as the grid scrolled under it. The collapsed state keeps the same stacking context,
and the lightbox stays above at `z-50`.

## Testing

- Unit tests for `usePersistedToggle`: returns the default when nothing is stored, round-trips
  a written value, survives a corrupt stored value, and degrades to the default when
  `localStorage` throws.
- In a real browser, against an isolated copy — never the live install:
  - collapse → reload → still collapsed; expand → reload → still expanded
  - select posts while collapsed → the header count updates and the panel stays closed
  - **measure the pixels reclaimed**, so the benefit is a number rather than a claim
  - the collapsed bar still paints over thumbnails scrolling beneath it (the `z-20` regression)
  - both a light and a dark theme

## Risks

**A visible flash of the expanded bar on load when the stored state is collapsed.** Inherent to
rendering the default on the server. One frame, and the alternative is a hydration mismatch.
Accepted deliberately.

**`library-view.tsx` stays at ~990 lines and grows slightly.** Recorded rather than fixed; the
extraction this file wants is a larger task than a collapse toggle should drag in.
