# Design — Library overview upgrades (sub-project ④)

**Status:** approved 2026-07-23, ready for implementation planning
**Part of:** content-management sub-project ④ (item 4 of the "post workflow" batch). Builds on the
existing Library (tag/platform filters, badges, bulk actions, edit links).

---

## 1. Purpose

The Library already lists posts with badges, tag/platform filters, bulk-schedule, bulk re-target,
and edit links. As the library grows, four management gaps remain: you can't filter by
status/kind, can't search captions, have no at-a-glance sense of the library's makeup, and can't
sort to surface stale content. This adds all four — entirely client-side over the rows already
loaded (`content_status`, `content_kind`, `caption`, `last_posted_at`, `id`). No query/backend
change.

---

## 2. Scope

All in `dashboard/components/library-view.tsx`, folding into the existing `shown` filter + grid:

1. **Summary stat strip** (top): whole-library counts computed from `posts` —
   `{ready} Ready · {draft} Draft · {retired} Retired · {evergreen} Evergreen · {one_time} One-time`
   and a total. Subtle `.data` micro-text.
2. **Status filter**: All / Draft / Ready / Retired (`content_status`).
3. **Kind filter**: All / Evergreen / One-time (`content_kind`).
4. **Caption search**: text input; case-insensitive substring match on `caption`.
5. **Sort**: Newest (`id` desc) · Recently posted (`last_posted_at` desc) · Least recently posted
   (`last_posted_at` asc). Never-posted rows (`last_posted_at === null`) always sort **last** in
   both posted sorts, so "least recently posted" surfaces genuinely-stale posted content, not
   never-used drafts.
6. **"showing N of M"** count near the grid, so a filter is never silently empty.

**Combine with AND** alongside the existing `tagFilter`/`platformFilter`. The stat strip reflects
the **whole** library; "showing N of M" reflects the active filters.

**Out of scope (deliberate):** per-post performance rollup (would need a metrics query — deferred);
saved views; pagination. Everything existing (badges, bulk-schedule, re-target, edit links, tag/
platform chips) stays unchanged.

---

## 3. Implementation shape

In `library-view.tsx`:
- **State** (add): `statusFilter: "all" | "draft" | "ready" | "retired"`,
  `kindFilter: "all" | "evergreen" | "one_time"`, `search: string`,
  `sort: "newest" | "recent" | "stale"` (defaults `"all"`/`"all"`/`""`/`"newest"`).
- **Extend `shown`** (the existing `posts.filter(...)`) with: status match, kind match, and
  `caption` case-insensitive `includes(search)` when `search` is non-empty. Keep the existing
  tag/platform conditions.
- **`sorted`** = a sorted copy of `shown` per the sort rule (nulls-last for posted sorts;
  `newest` by `id` desc; tie-break by `id` desc). Change the grid's `shown.map` (line ~205) to
  `sorted.map`.
- **Stat strip**: computed counts over `posts` (not filtered), rendered above the filter area.
- **Controls row** (always visible — not gated on tags existing, unlike the current tag-chip row):
  the two selects + search input + sort select + "showing {shown.length} of {posts.length}".
  Keep the existing tag/platform chip row (still gated on `allTagNames.length > 0`).
- Reuse the existing `field` class for inputs/selects; match the current filter-bar look.

---

## 4. Correctness / UX

- **No data/query/schema change** — pure client-side view logic over `PostLite` rows the page
  already provides. The stat strip and sorts use fields already present.
- Defaults (`all`/`all`/empty search/`newest`) keep the initial view essentially as today (newest
  first is a sensible default order).
- `content_status` (Draft/Ready/Retired) is the automation-eligibility axis — labeled as such; not
  conflated with `posts.status` / publication counts (which the badges show separately).
- Bulk-select semantics unchanged: a selected post hidden by a filter stays selected (same as
  today's tag/platform behavior).

---

## 5. Verification

- `cd dashboard && npx tsc --noEmit` clean.
- Browser (controller): the Library shows a stat strip (counts), Status/Kind selects, a caption
  search, and a Sort select. Status = Ready hides non-ready posts and updates "showing N of M";
  Kind = Evergreen narrows further; typing in search filters by caption; Sort = "Least recently
  posted" reorders (never-posted last). Existing bulk-schedule / re-target / tag+platform chips /
  edit links still work.

---

## 6. Out of scope (deferred)
- Per-post performance rollup (aggregate reach/saves — needs a metrics query); saved views;
  pagination/virtualization.
