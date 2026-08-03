# Library compact checkbox filters — design

**Date:** 2026-08-03
**Status:** approved in conversation; awaiting written-spec review
**Builds on:** the combined Library preview containing period visibility and bulk editing

## Problem

The Library currently renders every period, tag, and platform filter as an individual chip.
That consumes too much horizontal and vertical space as the option lists grow. The controls also
use inconsistent selection models: periods are multi-select, while tags and platforms are
single-select.

The owner wants three compact dropdowns—Periods, Tags, and Platforms—with searchable checkbox
lists, Select all, Clear all, and one explicit Apply action that controls what the Library shows.

## Decisions

- Replace the expanded period, tag, and platform chip rows with three reusable checkbox
  dropdowns.
- Keep Periods, Tags, and Platforms as separate controls rather than combining them into one
  large filter panel.
- Make all three groups multi-select.
- Hold checkbox changes as draft state until one shared **Apply** button is clicked.
- Keep caption search and the existing status, publication-history, kind, format, and sort
  controls immediate.
- Use OR semantics within each dropdown and AND semantics between dropdowns and the other Library
  filters.
- Add no dependency, API, migration, database query, or worker change.

## Filter row

The existing expanded filter area becomes one compact row containing:

1. A **Periods** dropdown button.
2. A **Tags** dropdown button.
3. A **Platforms** dropdown button.
4. One shared **Apply** button.

Each dropdown button shows its current draft selection count when nonzero, for example
`Periods · 3`. A zero-selection group displays only its name and imposes no filter after Apply.
The existing `showing N of M` summary continues to describe the applied result set, not
unapplied draft choices.

## Reusable checkbox dropdown

Create one reusable `CheckboxFilterDropdown` component. Its caller supplies the group label,
available options, selected values, and selection-change callback. The component owns only its
open state and local search text; the Library owns filter selections.

When open, the dropdown contains:

- a labeled search input;
- **Select all**, which selects every option in the group;
- **Clear all**, which clears every option in the group; and
- a scrollable checkbox list.

Search is case-insensitive and narrows only the visible checklist. It never changes the selected
set or silently removes selections hidden by the search. Select all and Clear all always apply to
the complete group, not only the current search results.

The dropdown closes with Escape or an outside click. Applying the filters closes any open
dropdown. Controls have accessible names, the trigger exposes expanded state, and keyboard users
can reach the search field, bulk actions, and every checkbox.

## State and data flow

The Library holds two `Set` values for each group:

- **draft selections**, edited by the dropdown checkboxes; and
- **applied selections**, read by the post-filtering calculation.

Clicking Apply copies all three draft sets into their applied counterparts in one state update.
Until then, changing checkboxes does not change the visible posts or the `showing N of M` count.
Closing and reopening a dropdown retains the draft choices so the owner can configure multiple
groups before applying them.

The existing Period matcher continues to compare numeric period ids. Tags continue to derive
from the Library post's tag names, and platforms from its target-platform values, but both applied
filters become sets instead of a single nullable value.

For a post to remain visible:

- it must match at least one selected period when periods are applied;
- it must match at least one selected tag when tags are applied;
- it must match at least one selected platform when platforms are applied; and
- it must also satisfy every other active Library filter.

An empty applied set for a group imposes no restriction.

## Error handling and edge cases

- An empty option group renders a disabled dropdown trigger with a clear empty-state label rather
  than an empty popover.
- A search with no matches renders `No matches` without altering selection.
- Apply remains safe when all three draft sets are empty; it clears these three filters and shows
  posts subject only to the other active controls.
- Option identity is stable: period ids for periods, and canonical string values for tags and
  platforms.
- No asynchronous request is introduced, so these controls need no loading or network-error
  state.

## Testing

Automated tests cover:

- case-insensitive option searching;
- Select all and Clear all operating on the complete option group;
- hidden selections surviving search changes;
- draft checkbox changes leaving the applied result set unchanged;
- Apply updating all three groups together;
- OR matching within each group;
- AND matching across groups;
- clearing all three groups restoring the unfiltered Library result set; and
- caption search remaining immediate.

Final verification includes the dashboard test suite, TypeScript, changed-file lint, production
build, and a browser check in the combined Library preview with real period, tag, and platform
options.

## Out of scope

- Saved filter presets or URL-persisted filter state.
- Changing the immediate behavior of status, publication-history, kind, format, sort, or caption
  search.
- Adding, editing, or deleting period, tag, or platform options from these dropdowns.
- Server-side filtering or pagination.
- Any change to bulk editing, season eligibility, publishing, or worker behavior.
