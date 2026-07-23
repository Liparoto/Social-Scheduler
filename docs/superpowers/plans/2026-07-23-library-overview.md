# Library Overview Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a summary stat strip, status/kind filters, caption search, and sort to the Library — all client-side over the rows already loaded.

**Architecture:** Extend `dashboard/components/library-view.tsx` only: new filter/sort state, extend the existing `shown` filter, add a `sorted` layer for the grid, add a stat strip + a controls row. No query/schema/backend change.

**Tech Stack:** Next.js 16 + TypeScript + Tailwind v4 (client component).

## Global Constraints

- **No schema/query/backend change, no new dependency.** Pure client-side logic over the `PostLite` rows the Library already receives.
- **Do not change** the existing bulk-schedule / bulk re-target flows, the badges, the tag/platform chip row, or the edit-links behavior. Bulk-select semantics unchanged (a selected-but-filtered-out post stays selected).
- **AND semantics:** new filters combine with the existing `tagFilter`/`platformFilter`. Defaults (`all`/`all`/empty/`newest`) keep the initial view ~as today.
- `content_status` (Draft/Ready/Retired) is the automation-eligibility axis — label it as such; do not conflate with `posts.status`/publication counts (the badges show those separately).
- Match the existing filter-bar visual language; reuse the component's `field` class for inputs/selects. Spec: `docs/design-library-overview.md`.

### Existing shape (verified in `library-view.tsx`)
- `PostLite` has: `id`, `caption: string | null`, `content_kind: "one_time" | "evergreen"`, `content_status: "draft" | "ready" | "retired"`, `last_posted_at: string | null`, plus tag/platform/badge fields.
- Existing state includes `tagFilter`, `platformFilter`; existing `const field = "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";` (~line 131).
- Existing `const shown = posts.filter((p) => { …tagFilter…platformFilter… return true; });` (~lines 139-148).
- The grid iterates `{shown.map((p) => { … })}` at ~line 205.
- The tag/platform chip filter row is gated on `allTagNames.length > 0` (~line 153).

---

### Task 1: Stat strip + status/kind/search/sort

**Files:**
- Modify: `dashboard/components/library-view.tsx`

- [ ] **Step 1: Add state**

Near the existing `tagFilter`/`platformFilter` `useState`s (~line 57), add:

```tsx
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "ready" | "retired">("all");
  const [kindFilter, setKindFilter] = useState<"all" | "evergreen" | "one_time">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "recent" | "stale">("newest");
```

- [ ] **Step 2: Extend `shown` and add `sorted`**

Replace the existing `const shown = posts.filter(...)` block with the extended filter, then add a `sorted` copy:

```tsx
  const q = search.trim().toLowerCase();
  const shown = posts.filter((p) => {
    if (tagFilter) {
      const names = [...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)];
      if (!names.includes(tagFilter)) return false;
    }
    if (platformFilter) {
      if (!splitTags(p.target_platforms).includes(platformFilter)) return false;
    }
    if (statusFilter !== "all" && p.content_status !== statusFilter) return false;
    if (kindFilter !== "all" && p.content_kind !== kindFilter) return false;
    if (q && !(p.caption ?? "").toLowerCase().includes(q)) return false;
    return true;
  });

  const sorted = [...shown].sort((a, b) => {
    if (sort === "newest") return b.id - a.id;
    const av = a.last_posted_at;
    const bv = b.last_posted_at;
    if (av === null && bv === null) return b.id - a.id;
    if (av === null) return 1; // never-posted always last
    if (bv === null) return -1;
    return sort === "recent" ? bv.localeCompare(av) : av.localeCompare(bv);
  });
```

- [ ] **Step 3: Point the grid at `sorted`**

Change the grid iteration `{shown.map((p) => {` (~line 205) to `{sorted.map((p) => {`. Leave the entire card markup inside the map unchanged.

- [ ] **Step 4: Add the stat strip + controls row**

Just inside the top-level `return ( <div className="space-y-5">` (before the existing `{/* Filter bar */}` tag-chip block ~line 152), insert the stat strip and a controls row. Compute the counts inline:

```tsx
      {/* Summary: whole-library makeup */}
      <div className="data flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        <span><span className="text-status-posted">{posts.filter((p) => p.content_status === "ready").length}</span> Ready</span>
        <span><span className="text-ink-soft">{posts.filter((p) => p.content_status === "draft").length}</span> Draft</span>
        <span><span className="text-faint">{posts.filter((p) => p.content_status === "retired").length}</span> Retired</span>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <span>{posts.filter((p) => p.content_kind === "evergreen").length} Evergreen</span>
        <span>{posts.filter((p) => p.content_kind === "one_time").length} One-time</span>
        <span className="ml-auto">{posts.length} total</span>
      </div>

      {/* Controls: status / kind / search / sort */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={field} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="ready">Ready</option>
          <option value="retired">Retired</option>
        </select>
        <select className={field} value={kindFilter} onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}>
          <option value="all">All kinds</option>
          <option value="evergreen">Evergreen</option>
          <option value="one_time">One-time</option>
        </select>
        <input
          className={`${field} min-w-48 flex-1`}
          placeholder="Search captions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className={field} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="newest">Newest</option>
          <option value="recent">Recently posted</option>
          <option value="stale">Least recently posted</option>
        </select>
        <span className="data text-[11px] text-muted">showing {shown.length} of {posts.length}</span>
      </div>
```

- [ ] **Step 5: Typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 6: Browser verification (controller runs this; list it)**

Note for the controller: the Library shows a stat strip (Ready/Draft/Retired/Evergreen/One-time/total), a Status select, a Kind select, a caption search box, and a Sort select. Status=Ready hides non-ready posts and updates "showing N of M"; Kind=Evergreen narrows further; typing filters by caption; Sort="Least recently posted" reorders (never-posted last). Existing tag/platform chips, bulk-schedule, re-target, and edit links still work.

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/library-view.tsx
git commit -m "feat(dashboard): Library overview — status/kind filters, caption search, sort, stat strip"
```

---

## Self-Review

**Spec coverage** (spec `docs/design-library-overview.md`):
- §2.1 stat strip → Step 4. ✅
- §2.2/2.3 status + kind filters → Steps 1, 2, 4. ✅
- §2.4 caption search → Steps 1, 2, 4. ✅
- §2.5 sort (nulls-last for posted sorts) → Steps 1, 2. ✅
- §2.6 "showing N of M" → Step 4. ✅
- §4 AND with existing filters, defaults keep today's view, no data change, bulk-select unchanged → Steps 2, 3 (grid source only changes; selected state untouched). ✅

**Placeholder scan:** No TBD/TODO; full code in each step; the grid change is a one-token edit against a concrete line.

**Type consistency:** State union types match the `PostLite` field literal types (`content_status`, `content_kind`). `sorted` derives from `shown` (same `PostLite[]`). The grid still receives a `PostLite` per iteration — card markup unchanged. Reuses the existing `field` const.

---

## Out of scope (deferred, per spec §6)
- Per-post performance rollup; saved views; pagination.
