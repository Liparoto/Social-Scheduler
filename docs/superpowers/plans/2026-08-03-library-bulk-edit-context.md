# Library Bulk Edit Context Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show how many selected posts already contain each bulk-edit value, hide irrelevant removal choices, summarize existing scalar values, and widen the modal.

**Architecture:** A read-only `POST /api/posts/bulk-edit/context` route validates the selected post ids and calls one grouped query function that returns tag, exact period-link, status, kind, and cooldown counts. Small pure UI helpers classify counts as all/some/none; the existing tag and period editors accept optional coverage props so their normal per-post callers remain unchanged. The modal fetches context once when opened, blocks review if context cannot be loaded, and keeps the existing atomic write endpoint unchanged.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, better-sqlite3, Node test runner.

---

## Global constraints

- Work only on branch `library-bulk-edit`; do not merge or push without owner approval.
- No migration, dependency, worker change, or live-database test.
- The context route is read-only. It must never write or cache context.
- Period coverage is keyed by exact `(period_id, mode)`; green and blackout are independent.
- Existing `TagEditor` and `PeriodAttach` callers must retain their current appearance and behavior when coverage props are omitted.
- Every task ends with a commit whose message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File structure

| File | Responsibility |
|---|---|
| `dashboard/lib/queries.ts` | Aggregate current metadata counts for the selected posts in one read transaction |
| `dashboard/lib/queries.bulk-edit-context.test.ts` | Query coverage and exact-mode regression tests against a scratch DB |
| `dashboard/app/api/posts/bulk-edit/context/route.ts` | Validate selected ids and return read-only context |
| `dashboard/test/bulk-edit-context-route.test.ts` | Route validation and response-shape tests |
| `dashboard/lib/bulk-edit-context.ts` | Pure coverage classification, labels, and ordering helpers |
| `dashboard/lib/bulk-edit-context.test.ts` | all/some/none and remove-order helper tests |
| `dashboard/components/tag-editor.tsx` | Optional coverage badges, disabling, and remove filtering |
| `dashboard/components/period-attach.tsx` | Optional exact-mode coverage and remove filtering |
| `dashboard/components/bulk-edit-modal.tsx` | Context fetch, legend, scalar summary, retry state, and wider layout |

---

### Task 1: Aggregate selected-post metadata context

**Files:**
- Modify: `dashboard/lib/queries.ts`
- Create: `dashboard/lib/queries.bulk-edit-context.test.ts`

- [ ] **Step 1: Write the failing grouped-query tests**

Create fixtures for three posts: one tag on all three, one on one post, a green period on all
three, the same named period as blackout on one, mixed status, common kind, and mixed cooldown.
The tests must assert this exact public shape:

```ts
const context = q.getBulkEditContext([postA, postB, postC, postA]);
assert.equal(context.post_count, 3, "duplicate ids count once");
assert.deepEqual(context.tags, [
  { tag_id: allTag.id, count: 3 },
  { tag_id: someTag.id, count: 1 },
]);
assert.deepEqual(context.periods, [
  { period_id: seasonId, mode: "blackout", count: 1 },
  { period_id: seasonId, mode: "green", count: 3 },
]);
assert.deepEqual(context.content_statuses, [
  { value: "draft", count: 1 },
  { value: "ready", count: 2 },
]);
assert.deepEqual(context.content_kinds, [{ value: "evergreen", count: 3 }]);
assert.deepEqual(context.cooldowns, [
  { value: null, count: 2 },
  { value: 90, count: 1 },
]);
```

- [ ] **Step 2: Run the query test and verify RED**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/queries.bulk-edit-context.test.ts
```

Expected: FAIL because `getBulkEditContext` does not exist.

- [ ] **Step 3: Add the context types and grouped query**

Add these exported types near the bulk-edit query types:

```ts
export interface BulkEditContext {
  post_count: number;
  tags: { tag_id: number; count: number }[];
  periods: { period_id: number; mode: PeriodMode; count: number }[];
  content_statuses: { value: ContentStatus; count: number }[];
  content_kinds: { value: ContentKind; count: number }[];
  cooldowns: { value: number | null; count: number }[];
}
```

Implement `getBulkEditContext(postIds: number[]): BulkEditContext` by deduplicating ids, building
one placeholder list, and running five grouped `SELECT` statements inside one
`db.transaction(() => ...)` so every count comes from the same SQLite snapshot. Use deterministic
ordering in SQL:

```sql
SELECT pt.tag_id, COUNT(*) AS count
FROM post_tags pt
WHERE pt.post_id IN (...)
GROUP BY pt.tag_id
ORDER BY pt.tag_id;

SELECT pp.period_id, pp.mode, COUNT(*) AS count
FROM post_periods pp
WHERE pp.post_id IN (...)
GROUP BY pp.period_id, pp.mode
ORDER BY pp.period_id, pp.mode;
```

Group scalar rows directly from `posts`. For cooldowns use `ORDER BY cooldown_days IS NOT NULL,
cooldown_days` so `null` is stable and first. Return empty arrays when the deduplicated input is
empty; the route rejects that case, but the query remains safe.

- [ ] **Step 4: Run query tests and TypeScript**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/queries.bulk-edit-context.test.ts
npx tsc --noEmit
```

Expected: query tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add dashboard/lib/queries.ts dashboard/lib/queries.bulk-edit-context.test.ts
git commit -m $'feat(library): aggregate bulk edit context\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
```

---

### Task 2: Add the read-only context route

**Files:**
- Create: `dashboard/app/api/posts/bulk-edit/context/route.ts`
- Create: `dashboard/test/bulk-edit-context-route.test.ts`

- [ ] **Step 1: Write failing route tests**

Use `makeTestDb()`, create three draft posts, and dynamically import the route. Test:

```ts
assert.equal((await post({ post_ids: [] })).status, 400);
assert.equal((await post({ post_ids: [postA, "bad"] })).status, 400);
assert.equal((await post({ post_ids: [postA, 999999] })).status, 400);

const response = await post({ post_ids: [postA, postB, postA] });
assert.equal(response.status, 200);
const body = await response.json();
assert.equal(body.post_count, 2);
```

Also record `post_tags` and `post_periods` counts before and after the request and assert they are
unchanged, proving the route is read-only.

- [ ] **Step 2: Run the route test and verify RED**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 test/bulk-edit-context-route.test.ts
```

Expected: FAIL because the route module does not exist.

- [ ] **Step 3: Implement route validation and response**

Create a Node runtime route that catches malformed JSON, requires a non-empty array of integer
ids, deduplicates ids, validates every id with `getPost`, then returns
`NextResponse.json(getBulkEditContext(postIds))`. Use the existing bulk-edit route’s messages:

```ts
if (!Array.isArray(body.post_ids) || body.post_ids.length === 0) {
  return NextResponse.json({ error: "Select at least one post." }, { status: 400 });
}
if (body.post_ids.some((id: unknown) => typeof id !== "number" || !Number.isInteger(id))) {
  return NextResponse.json({ error: "post_ids must contain integers." }, { status: 400 });
}
```

No write function may be imported by this route.

- [ ] **Step 4: Run route tests and TypeScript**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 test/bulk-edit-context-route.test.ts
npx tsc --noEmit
```

Expected: route tests PASS and TypeScript exits 0.

- [ ] **Step 5: Verify the real route on a scratch database**

Start the worktree dashboard on an unused preview port with `DATABASE_PATH` set to a migrated
scratch copy. `curl` a valid selection and confirm HTTP 200 plus the expected `post_count`. Curl
an unknown id and confirm HTTP 400. Compare `post_tags` and `post_periods` row counts before and
after; both must be unchanged.

- [ ] **Step 6: Commit Task 2**

```bash
git add dashboard/app/api/posts/bulk-edit/context/route.ts dashboard/test/bulk-edit-context-route.test.ts
git commit -m $'feat(api): expose bulk edit context\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
```

---

### Task 3: Add pure coverage helpers

**Files:**
- Create: `dashboard/lib/bulk-edit-context.ts`
- Create: `dashboard/lib/bulk-edit-context.test.ts`

- [ ] **Step 1: Write failing helper tests**

Test the three states and labels:

```ts
assert.equal(coverageState(3, 3), "all");
assert.equal(coverageState(1, 3), "some");
assert.equal(coverageState(0, 3), "none");
assert.equal(coverageLabel(3, 3), "All 3");
assert.equal(coverageLabel(1, 3), "1 of 3");
assert.equal(coverageLabel(0, 3), "None");
```

Test removal ordering/filtering:

```ts
assert.deepEqual(
  removableIds([4, 9, 12], { 4: 1, 9: 3, 12: 0 }, 3),
  [9, 4]
);
```

- [ ] **Step 2: Run helper tests and verify RED**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/bulk-edit-context.test.ts
```

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the minimal helpers**

Export:

```ts
export type CoverageState = "all" | "some" | "none";
export function coverageState(count: number, total: number): CoverageState;
export function coverageLabel(count: number, total: number): string;
export function removableIds(
  ids: number[],
  counts: Record<number, number>,
  total: number
): number[];
```

`removableIds` filters zero counts, sorts all-coverage first, then descending count, then retains
input order for ties. Keep styling out of this module.

- [ ] **Step 4: Run helper tests**

Run the focused helper test. Expected: all tests PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add dashboard/lib/bulk-edit-context.ts dashboard/lib/bulk-edit-context.test.ts
git commit -m $'feat(library): classify metadata coverage\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
```

---

### Task 4: Render context in the editors and modal

**Files:**
- Modify: `dashboard/components/tag-editor.tsx`
- Modify: `dashboard/components/period-attach.tsx`
- Modify: `dashboard/components/bulk-edit-modal.tsx`

- [ ] **Step 1: Extend `TagEditor` with optional coverage props**

Add optional props:

```ts
coverage?: Record<number, number>;
selectedPostCount?: number;
hideZeroCoverage?: boolean;
disableFullCoverage?: boolean;
emptyCoverageMessage?: string;
```

When `coverage` is omitted, render exactly as today. When present, each visible tag chip includes
a small `coverageLabel(count, selectedPostCount)` badge with these classes:

```ts
all:  "border-status-posted/60 bg-status-posted/15 text-status-posted"
some: "border-amber-500/60 bg-amber-500/10 text-amber-700"
none: "border-border bg-surface text-faint"
```

When `hideZeroCoverage` is true, omit zero-count tags. When `disableFullCoverage` is true, a tag
whose count equals `selectedPostCount` remains visible but disabled. Preserve topic/time-of-day
grouping and show `emptyCoverageMessage` if both groups are empty.

- [ ] **Step 2: Extend `PeriodAttach` with exact-mode coverage props**

Add optional props:

```ts
coverage?: Record<string, number>; // key `${periodId}:${mode}`
selectedPostCount?: number;
hideZeroCoverage?: boolean;
disableFullCoverage?: boolean;
```

When coverage is supplied, show the label inside each Green/Blackout button. In remove mode
(`hideZeroCoverage`), omit a period row when both exact mode counts are zero and omit/disable the
individual zero-count mode. In add mode (`disableFullCoverage`), disable only the exact mode whose
count equals the selected total. “Off” always remains available to clear the pending choice.
Normal per-post callers remain unchanged.

- [ ] **Step 3: Fetch context when the modal opens**

In `BulkEditModal`, add `context`, `contextLoading`, and `contextError` state and a `useEffect` with
an `AbortController`. POST `{ post_ids: postIds }` to `/api/posts/bulk-edit/context`. On failure,
show the server error or `Could not load existing metadata.` and a Retry button driven by a
`contextAttempt` counter. Never substitute empty counts after failure.

Build lookup records:

```ts
const tagCoverage = Object.fromEntries(context.tags.map((row) => [row.tag_id, row.count]));
const periodCoverage = Object.fromEntries(
  context.periods.map((row) => [`${row.period_id}:${row.mode}`, row.count])
);
```

- [ ] **Step 4: Add the legend, scalar summary, and editor coverage**

Change modal width to `max-w-6xl`. Above Tags render three legend pills: green `All N`, amber
`Some (X of N)`, and gray `None`.

Pass coverage to the Add editors with `disableFullCoverage`, and to Remove editors with
`hideZeroCoverage`. Set the remove tag empty message to `None of the selected posts have removable
tags.`

Above scalar controls render “Current selection” rows from `content_statuses`, `content_kinds`,
and `cooldowns`. Each entry must include a human-readable value plus coverage, such as
`Ready 2/3`, `Evergreen All 3`, `Channel default 2/3`, and `90 days 1/3`.

Disable “Review changes” while context is loading or failed. The existing add/remove payload,
confirmation page, and save request do not change.

- [ ] **Step 5: Run focused tests, TypeScript, and changed-file lint**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 \
  lib/bulk-edit-context.test.ts \
  lib/queries.bulk-edit-context.test.ts \
  test/bulk-edit-context-route.test.ts
npx tsc --noEmit
npm run lint -- components/tag-editor.tsx components/period-attach.tsx \
  components/bulk-edit-modal.tsx lib/bulk-edit-context.ts
```

Expected: tests PASS, TypeScript exits 0, ESLint reports zero errors.

- [ ] **Step 6: Verify the preview interaction**

On the scratch preview:

1. Filter the Library and select three posts.
2. Open Edit metadata and confirm the modal is visibly wider.
3. Confirm at least one tag shows `All 3`, one shows `X of 3`, and an absent tag shows `None` in Add.
4. Confirm Remove hides absent tags and sorts common tags first.
5. Confirm green/blackout coverage is separate.
6. Confirm scalar values show counts.
7. Select a partial tag for Add, review, and cancel; prove row counts are unchanged.
8. Complete the scratch edit; reopen and confirm the coverage reflects the new scratch data.

- [ ] **Step 7: Commit Task 4**

```bash
git add dashboard/components/tag-editor.tsx dashboard/components/period-attach.tsx \
  dashboard/components/bulk-edit-modal.tsx
git commit -m $'feat(library): show existing bulk metadata\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>'
```

---

## Final verification

- [ ] Run `npm test` in `dashboard` and confirm zero failures.
- [ ] Run `npx tsc --noEmit` in `dashboard` and confirm exit 0.
- [ ] Run the changed-file ESLint command and confirm zero errors.
- [ ] Run `DATABASE_PATH=<scratch-db> npm run build` and confirm the production build includes
      `/api/posts/bulk-edit/context` and `/library`.
- [ ] Run the full worker suite with the existing worker virtual environment; confirm zero
      failures and no file under `worker/` changed.
- [ ] Open the live database read-only and confirm `PRAGMA foreign_key_check` is empty. Explain
      live `post_tags` and `post_periods` counts; all feature writes must remain in scratch.
- [ ] Run code review over the implementation-plan base SHA through HEAD and resolve every
      Critical or Important finding.
