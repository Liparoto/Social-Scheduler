# Library compact checkbox filters — design

**Date:** 2026-08-03
**Status:** per-dropdown Apply revision approved in conversation; awaiting written-spec review
**Builds on:** the combined Library preview containing period visibility and bulk editing

## Problem

The Library currently renders every period, tag, and platform filter as an individual chip.
That consumes too much horizontal and vertical space as the option lists grow. The controls also
use inconsistent selection models: periods are multi-select, while tags and platforms are
single-select.

The owner wants three compact dropdowns—Periods, Tags, and Platforms—with searchable checkbox
lists, Select all, Clear all, and an explicit Apply action inside each dropdown.

## Decisions

- Replace the expanded period, tag, and platform chip rows with three reusable checkbox
  dropdowns.
- Keep Periods, Tags, and Platforms as separate controls rather than combining them into one
  large filter panel.
- Make all three groups multi-select.
- Give each dropdown its own temporary checklist and **Apply** button.
- Applying one dropdown changes only that filter. It never submits pending choices in another
  dropdown.
- Closing with Escape or an outside click discards that dropdown's temporary choices.
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

Each dropdown button shows its currently applied selection count when nonzero, for example
`Periods · 3`. A zero-selection group displays only its name and imposes no filter. The existing
`showing N of M` summary describes the applied result set; temporary checkbox choices never
change the count.

## Reusable checkbox dropdown

Create one reusable `CheckboxFilterDropdown` component. Its caller supplies the group label,
available options, applied values, and an `onApply` callback. The component owns its open state,
search text, and temporary selection.

When open, the dropdown contains:

- a labeled search input;
- **Select all**, which selects every option in the group;
- **Clear all**, which clears every option in the group;
- a scrollable checkbox list; and
- that dropdown's own **Apply** button fixed at the bottom.

Search is case-insensitive and narrows only the visible checklist. It never changes the selected
set or silently removes selections hidden by the search. Select all and Clear all always apply to
the complete group, not only the current search results.

Opening copies the applied values into the temporary selection. Clicking the internal Apply sends
that temporary set to the parent and closes the dropdown. Escape or an outside click closes the
dropdown and resets its temporary values from the applied selection. Escape restores focus to the
trigger; outside click leaves focus at the user's destination. Controls have accessible names,
the trigger exposes expanded state, and keyboard users can reach the search field, bulk actions,
every checkbox, and Apply.

## State and data flow

The Library owns one applied `Set` for each group. Each dropdown owns its temporary `Set` while
open. Clicking a dropdown's Apply replaces only that group's applied Set; the other two groups are
unchanged. Until then, checkbox changes do not change the visible posts or the `showing N of M`
count. Closing without Apply discards the temporary Set, so reopening always starts from the
current applied values.

When refreshed Library data removes a tag or period option, the existing availability
reconciliation continues pruning that value from the applied Set. This prevents an invisible
stale selection after bulk edit or merge refreshes.

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
- Applying an empty temporary Set clears only that dropdown's filter.
- Closing without Apply never changes the result set.
- Option identity is stable: period ids for periods, and canonical string values for tags and
  platforms.
- No asynchronous request is introduced, so these controls need no loading or network-error
  state.

## Testing

Automated tests cover:

- case-insensitive option searching;
- Select all and Clear all operating on the complete option group;
- hidden selections surviving search changes;
- temporary checkbox changes leaving the applied result set unchanged;
- each dropdown's Apply updating only its own group;
- Escape and outside click discarding temporary choices;
- OR matching within each group;
- AND matching across groups;
- applying an empty selection clearing one group without changing the others;
- availability reconciliation removing stale applied choices after refreshed data; and
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
