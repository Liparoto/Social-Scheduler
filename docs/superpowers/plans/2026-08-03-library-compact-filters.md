# Library Compact Checkbox Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Library's expanded period, tag, and platform chips with three searchable multi-select dropdowns whose draft choices take effect together through one Apply button.

**Architecture:** A pure reducer and matching helpers own the draft-versus-applied contract and OR/AND semantics. One reusable client component owns dropdown visibility, search, outside-click, Escape, and checkbox rendering. `LibraryView` supplies options, keeps the staged filter reducer, and continues applying caption and existing scalar filters immediately.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Node test runner, React server rendering tests, Tailwind CSS.

---

## Global constraints

- Work only in `.worktrees/library-combined-preview` on branch `library-combined-preview`.
- Do not merge or push without owner approval.
- Add no dependency, migration, API route, database query, or worker change.
- Preserve period ids as numeric filter identity; preserve canonical tag and platform strings.
- The visible `showing N of M` count reads applied selections only.
- Caption search and status/publication-history/kind/format controls stay immediate.
- Run UI tests with `dashboard/test/ui-hook.mjs`; run pure helpers with the normal dashboard test hook.

## File structure

| File | Responsibility |
|---|---|
| `dashboard/lib/library-checkbox-filters.ts` | Pure staged selection reducer, option search, and OR-within/AND-between matching |
| `dashboard/lib/library-checkbox-filters.test.ts` | Reducer, search, Select all/Clear all inputs, and matching regression tests |
| `dashboard/components/checkbox-filter-dropdown.tsx` | Reusable accessible dropdown trigger and searchable checkbox panel |
| `dashboard/test-ui/checkbox-filter-dropdown-ui.test.ts` | Static markup assertions for labels, count, bulk actions, empty state, and no matches |
| `dashboard/package.json` | Include the new UI test in `npm test` |
| `dashboard/components/library-view.tsx` | Supply three option groups, maintain staged state, apply all groups, and filter posts |

---

### Task 1: Add pure staged-filter state and matching

**Files:**
- Create: `dashboard/lib/library-checkbox-filters.ts`
- Create: `dashboard/lib/library-checkbox-filters.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `dashboard/lib/library-checkbox-filters.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allOptionValues,
  createLibraryCheckboxFilterState,
  filterCheckboxOptions,
  libraryCheckboxFilterReducer,
  matchesLibraryCheckboxFilters,
} from "./library-checkbox-filters.ts";

const options = [
  { value: "football", label: "Football Season" },
  { value: "christmas", label: "Christmas" },
  { value: "spring", label: "Spring Training" },
];

test("option search is case-insensitive and does not mutate selections", () => {
  const selected = new Set(["christmas"]);
  assert.deepEqual(filterCheckboxOptions(options, "FOOT"), [options[0]]);
  assert.deepEqual([...selected], ["christmas"]);
});

test("Select all uses the complete option group even when search is narrowed", () => {
  assert.deepEqual([...allOptionValues(options)], ["football", "christmas", "spring"]);
  assert.deepEqual([...allOptionValues([])], []);
});

test("draft changes do not become applied until Apply", () => {
  const initial = createLibraryCheckboxFilterState();
  const drafted = libraryCheckboxFilterReducer(initial, {
    type: "set-draft",
    group: "tags",
    values: new Set(["tips", "promo"]),
  });

  assert.deepEqual([...drafted.draft.tags], ["tips", "promo"]);
  assert.equal(drafted.applied.tags.size, 0);

  const applied = libraryCheckboxFilterReducer(drafted, { type: "apply" });
  assert.deepEqual([...applied.applied.tags], ["tips", "promo"]);
  assert.notEqual(applied.applied.tags, applied.draft.tags, "Apply copies the Set");
});

test("Apply updates periods, tags, and platforms together", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "set-draft",
    group: "periods",
    values: new Set([10, 20]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "set-draft",
    group: "tags",
    values: new Set(["tips"]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "set-draft",
    group: "platforms",
    values: new Set(["instagram", "facebook"]),
  });
  state = libraryCheckboxFilterReducer(state, { type: "apply" });

  assert.deepEqual([...state.applied.periods], [10, 20]);
  assert.deepEqual([...state.applied.tags], ["tips"]);
  assert.deepEqual([...state.applied.platforms], ["instagram", "facebook"]);
});

test("matching is OR within a group and AND between groups", () => {
  const selected = {
    periods: new Set([10, 20]),
    tags: new Set(["tips", "promo"]),
    platforms: new Set(["instagram", "facebook"]),
  };

  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [20], tags: ["tips"], platforms: ["facebook"] },
      selected,
    ),
    true,
  );
  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [20], tags: ["other"], platforms: ["facebook"] },
      selected,
    ),
    false,
  );
  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [99], tags: ["tips"], platforms: ["facebook"] },
      selected,
    ),
    false,
  );
});

test("empty applied groups impose no restriction", () => {
  const empty = createLibraryCheckboxFilterState().applied;
  assert.equal(
    matchesLibraryCheckboxFilters({ periods: [], tags: [], platforms: [] }, empty),
    true,
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/library-checkbox-filters.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `library-checkbox-filters.ts`.

- [ ] **Step 3: Implement the pure filter module**

Create `dashboard/lib/library-checkbox-filters.ts`:

```ts
export type CheckboxFilterValue = string | number;

export interface CheckboxFilterOption<T extends CheckboxFilterValue> {
  value: T;
  label: string;
}

export interface LibraryCheckboxSelections {
  periods: Set<number>;
  tags: Set<string>;
  platforms: Set<string>;
}

export interface LibraryCheckboxFilterState {
  draft: LibraryCheckboxSelections;
  applied: LibraryCheckboxSelections;
}

export type LibraryCheckboxGroup = keyof LibraryCheckboxSelections;

export type LibraryCheckboxFilterAction =
  | {
      type: "set-draft";
      group: "periods";
      values: Set<number>;
    }
  | {
      type: "set-draft";
      group: "tags" | "platforms";
      values: Set<string>;
    }
  | { type: "apply" };

function emptySelections(): LibraryCheckboxSelections {
  return { periods: new Set(), tags: new Set(), platforms: new Set() };
}

function copySelections(source: LibraryCheckboxSelections): LibraryCheckboxSelections {
  return {
    periods: new Set(source.periods),
    tags: new Set(source.tags),
    platforms: new Set(source.platforms),
  };
}

export function createLibraryCheckboxFilterState(): LibraryCheckboxFilterState {
  return { draft: emptySelections(), applied: emptySelections() };
}

export function libraryCheckboxFilterReducer(
  state: LibraryCheckboxFilterState,
  action: LibraryCheckboxFilterAction,
): LibraryCheckboxFilterState {
  if (action.type === "apply") {
    return { draft: copySelections(state.draft), applied: copySelections(state.draft) };
  }

  if (action.group === "periods") {
    return {
      ...state,
      draft: { ...state.draft, periods: new Set(action.values) },
    };
  }

  return {
    ...state,
    draft: { ...state.draft, [action.group]: new Set(action.values) },
  };
}

export function filterCheckboxOptions<T extends CheckboxFilterValue>(
  options: CheckboxFilterOption<T>[],
  query: string,
): CheckboxFilterOption<T>[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return options;
  return options.filter((option) => option.label.toLocaleLowerCase().includes(normalized));
}

export function allOptionValues<T extends CheckboxFilterValue>(
  options: CheckboxFilterOption<T>[],
): Set<T> {
  return new Set(options.map((option) => option.value));
}

function matchesAny<T extends CheckboxFilterValue>(values: T[], selected: Set<T>): boolean {
  return selected.size === 0 || values.some((value) => selected.has(value));
}

export function matchesLibraryCheckboxFilters(
  post: { periods: number[]; tags: string[]; platforms: string[] },
  selected: LibraryCheckboxSelections,
): boolean {
  return (
    matchesAny(post.periods, selected.periods) &&
    matchesAny(post.tags, selected.tags) &&
    matchesAny(post.platforms, selected.platforms)
  );
}
```

- [ ] **Step 4: Run the focused test and TypeScript**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/library-checkbox-filters.test.ts
npx tsc --noEmit
```

Expected: all 6 focused tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add dashboard/lib/library-checkbox-filters.ts dashboard/lib/library-checkbox-filters.test.ts
git commit -m "feat(library): add staged checkbox filter logic"
```

---

### Task 2: Build the reusable searchable checkbox dropdown

**Files:**
- Create: `dashboard/components/checkbox-filter-dropdown.tsx`
- Create: `dashboard/test-ui/checkbox-filter-dropdown-ui.test.ts`
- Modify: `dashboard/package.json:5-11`

- [ ] **Step 1: Write the failing UI rendering tests**

Create `dashboard/test-ui/checkbox-filter-dropdown-ui.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CheckboxFilterDropdown,
  CheckboxFilterPanel,
} from "../components/checkbox-filter-dropdown.tsx";

const options = [
  { value: "football", label: "Football Season" },
  { value: "christmas", label: "Christmas" },
];
const noop = () => {};

test("closed trigger reports its draft selection count and expanded state", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterDropdown<string>, {
      label: "Periods",
      options,
      selected: new Set(["football"]),
      onChange: noop,
      closeSignal: 0,
    }),
  );
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Periods · 1/);
});

test("panel renders search, full-group actions, checked state, and options", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterPanel<string>, {
      label: "Periods",
      options,
      selected: new Set(["football"]),
      query: "",
      onQueryChange: noop,
      onChange: noop,
    }),
  );
  assert.match(html, /aria-label="Search Periods"/);
  assert.match(html, />Select all</);
  assert.match(html, />Clear all</);
  assert.match(html, /Football Season/);
  assert.match(html, /Christmas/);
  assert.match(html, /checked=""/);
});

test("panel reports no matches without dropping the selected count", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterPanel<string>, {
      label: "Periods",
      options,
      selected: new Set(["football"]),
      query: "missing",
      onQueryChange: noop,
      onChange: noop,
    }),
  );
  assert.match(html, /No matches/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test("empty groups have a disabled, explicit trigger", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterDropdown<string>, {
      label: "Tags",
      options: [],
      selected: new Set(),
      onChange: noop,
      closeSignal: 0,
    }),
  );
  assert.match(html, /disabled=""/);
  assert.match(html, /Tags — none available/);
});
```

- [ ] **Step 2: Add the new test entry and verify RED**

Change the first `dashboard/package.json` test command to include both client-rendering files:

```json
"test": "node --import ./test/ui-hook.mjs --test --test-concurrency=1 test-ui/bulk-edit-context-ui.test.ts test-ui/checkbox-filter-dropdown-ui.test.ts && node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 \"lib/*.test.ts\" \"test/*.test.ts\""
```

Run:

```bash
cd dashboard
node --import ./test/ui-hook.mjs --test --test-concurrency=1 test-ui/checkbox-filter-dropdown-ui.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `checkbox-filter-dropdown.tsx`.

- [ ] **Step 3: Implement the dropdown and panel**

Create `dashboard/components/checkbox-filter-dropdown.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import {
  allOptionValues,
  filterCheckboxOptions,
  type CheckboxFilterOption,
  type CheckboxFilterValue,
} from "@/lib/library-checkbox-filters";

interface SharedProps<T extends CheckboxFilterValue> {
  label: string;
  options: CheckboxFilterOption<T>[];
  selected: Set<T>;
  onChange: (next: Set<T>) => void;
}

export function CheckboxFilterPanel<T extends CheckboxFilterValue>({
  label,
  options,
  selected,
  query,
  onQueryChange,
  onChange,
}: SharedProps<T> & {
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const shown = filterCheckboxOptions(options, query);

  function toggle(value: T) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  return (
    <div
      role="dialog"
      aria-label={`${label} filters`}
      className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-surface p-3 shadow-lg"
    >
      <input
        type="search"
        aria-label={`Search ${label}`}
        placeholder={`Search ${label.toLowerCase()}…`}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand"
      />
      <div className="mt-2 flex items-center justify-between border-b border-border pb-2">
        <button
          type="button"
          onClick={() => onChange(allOptionValues(options))}
          className="text-xs font-medium text-brand-strong hover:underline"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => onChange(new Set<T>())}
          className="text-xs text-muted hover:underline"
        >
          Clear all
        </button>
      </div>
      <div className="mt-2 max-h-64 space-y-1 overflow-y-auto">
        {shown.length > 0 ? (
          shown.map((option) => (
            <label
              key={String(option.value)}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-ink hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                checked={selected.has(option.value)}
                onChange={() => toggle(option.value)}
                className="accent-brand"
              />
              <span>{option.label}</span>
            </label>
          ))
        ) : (
          <p className="px-2 py-4 text-center text-sm text-faint">No matches</p>
        )}
      </div>
    </div>
  );
}

export function CheckboxFilterDropdown<T extends CheckboxFilterValue>({
  label,
  options,
  selected,
  onChange,
  closeSignal,
}: SharedProps<T> & { closeSignal: number }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const disabled = options.length === 0;

  useEffect(() => {
    setOpen(false);
  }, [closeSignal]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-faint"
      >
        {disabled ? `${label} — none available` : `${label}${selected.size ? ` · ${selected.size}` : ""}`}
      </button>
      {open ? (
        <CheckboxFilterPanel
          label={label}
          options={options}
          selected={selected}
          query={query}
          onQueryChange={setQuery}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run UI tests, lint, and TypeScript**

Run:

```bash
cd dashboard
node --import ./test/ui-hook.mjs --test --test-concurrency=1 test-ui/checkbox-filter-dropdown-ui.test.ts
npx eslint components/checkbox-filter-dropdown.tsx test-ui/checkbox-filter-dropdown-ui.test.ts
npx tsc --noEmit
```

Expected: 4 UI tests PASS; ESLint and TypeScript exit 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add dashboard/components/checkbox-filter-dropdown.tsx dashboard/test-ui/checkbox-filter-dropdown-ui.test.ts dashboard/package.json
git commit -m "feat(library): add searchable checkbox dropdown"
```

---

### Task 3: Wire three staged dropdowns into the Library

**Files:**
- Modify: `dashboard/components/library-view.tsx:3-230, 355-477`
- Test: `dashboard/lib/library-checkbox-filters.test.ts`

- [ ] **Step 1: Add a regression test for Clear all and immediate caption composition**

Append to `dashboard/lib/library-checkbox-filters.test.ts`:

```ts
test("clearing every draft group and applying restores checkbox-filtered posts", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "set-draft",
    group: "tags",
    values: new Set(["tips"]),
  });
  state = libraryCheckboxFilterReducer(state, { type: "apply" });
  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [], tags: ["other"], platforms: [] },
      state.applied,
    ),
    false,
  );

  state = libraryCheckboxFilterReducer(state, {
    type: "set-draft",
    group: "tags",
    values: new Set(),
  });
  state = libraryCheckboxFilterReducer(state, { type: "apply" });
  const posts = [
    { caption: "Football tip", periods: [] as number[], tags: ["other"], platforms: [] as string[] },
    { caption: "Holiday post", periods: [] as number[], tags: ["other"], platforms: [] as string[] },
  ];
  const captionQuery = "football";
  const shown = posts.filter(
    (post) =>
      matchesLibraryCheckboxFilters(post, state.applied) &&
      post.caption.toLowerCase().includes(captionQuery),
  );
  assert.equal(shown.length, 1, "checkbox filters clear while caption search remains active");
});
```

- [ ] **Step 2: Run the helper test before integration**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/library-checkbox-filters.test.ts
```

Expected: all 7 helper tests PASS. This pins the integration contract before editing the large Library component.

- [ ] **Step 3: Replace the three immediate filter states with the staged reducer**

In `dashboard/components/library-view.tsx`, change the React import and add imports:

```tsx
import { useReducer, useState, useTransition } from "react";
import { CheckboxFilterDropdown } from "@/components/checkbox-filter-dropdown";
import {
  createLibraryCheckboxFilterState,
  libraryCheckboxFilterReducer,
  matchesLibraryCheckboxFilters,
  type CheckboxFilterOption,
} from "@/lib/library-checkbox-filters";
```

Remove the `matchesPeriodFilter` import. Replace `tagFilter`, `periodFilter`, and
`platformFilter` state plus `togglePeriod()` with:

```tsx
const [checkboxFilters, dispatchCheckboxFilters] = useReducer(
  libraryCheckboxFilterReducer,
  undefined,
  createLibraryCheckboxFilterState,
);
const [filterApplySignal, setFilterApplySignal] = useState(0);
```

- [ ] **Step 4: Build typed dropdown options and read only applied filters in `shown`**

After `allTagNames` and `allPeriods`, add:

```tsx
const periodFilterOptions: CheckboxFilterOption<number>[] = allPeriods.map((period) => ({
  value: period.id,
  label: period.name,
}));
const tagFilterOptions: CheckboxFilterOption<string>[] = allTagNames.map((name) => ({
  value: name,
  label: name,
}));
const platformFilterOptions: CheckboxFilterOption<string>[] = PLATFORMS.map((platform) => ({
  value: platform.value,
  label: platformLabel(platform.value),
}));
```

Replace the first period/tag/platform conditions inside `shown` with one applied matcher:

```tsx
if (
  !matchesLibraryCheckboxFilters(
    {
      periods: p.periods.map((period) => period.id),
      tags: [...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)],
      platforms: splitTags(p.target_platforms),
    },
    checkboxFilters.applied,
  )
) return false;
```

Leave the status, publication-history, kind, format, and caption conditions directly below it
unchanged so those controls remain immediate.

- [ ] **Step 5: Replace both expanded chip rows with three dropdowns and Apply**

Delete the existing `Periods:` chip row and `Filter:` tag/platform chip row. Insert:

```tsx
<div className="flex flex-wrap items-center gap-2">
  <span className="text-xs text-ink-soft">Filter:</span>
  <CheckboxFilterDropdown
    label="Periods"
    options={periodFilterOptions}
    selected={checkboxFilters.draft.periods}
    onChange={(values) =>
      dispatchCheckboxFilters({ type: "set-draft", group: "periods", values })
    }
    closeSignal={filterApplySignal}
  />
  <CheckboxFilterDropdown
    label="Tags"
    options={tagFilterOptions}
    selected={checkboxFilters.draft.tags}
    onChange={(values) =>
      dispatchCheckboxFilters({ type: "set-draft", group: "tags", values })
    }
    closeSignal={filterApplySignal}
  />
  <CheckboxFilterDropdown
    label="Platforms"
    options={platformFilterOptions}
    selected={checkboxFilters.draft.platforms}
    onChange={(values) =>
      dispatchCheckboxFilters({ type: "set-draft", group: "platforms", values })
    }
    closeSignal={filterApplySignal}
  />
  <button
    type="button"
    onClick={() => {
      dispatchCheckboxFilters({ type: "apply" });
      setFilterApplySignal((value) => value + 1);
    }}
    className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-ink"
  >
    Apply
  </button>
</div>
```

- [ ] **Step 6: Run focused and full static checks**

Run:

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/library-checkbox-filters.test.ts
npx eslint components/library-view.tsx components/checkbox-filter-dropdown.tsx lib/library-checkbox-filters.ts lib/library-checkbox-filters.test.ts test-ui/checkbox-filter-dropdown-ui.test.ts
npx tsc --noEmit
npm test
```

Expected: 7 helper tests PASS, 4 dropdown UI tests PASS, all pre-existing dashboard tests PASS,
and ESLint/TypeScript exit 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add dashboard/components/library-view.tsx dashboard/lib/library-checkbox-filters.test.ts
git commit -m "feat(library): apply compact multi-select filters"
```

---

### Task 4: Verify the completed Library interaction

**Files:**
- Modify: `docs/superpowers/specs/2026-08-03-library-compact-filters-design.md:3`

- [ ] **Step 1: Run the full dashboard and worker verification**

Run:

```bash
cd dashboard
npm test
npx tsc --noEmit
npx eslint components/library-view.tsx components/checkbox-filter-dropdown.tsx lib/library-checkbox-filters.ts lib/library-checkbox-filters.test.ts test-ui/checkbox-filter-dropdown-ui.test.ts
npm run build
cd ../worker
"/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/.venv/bin/python" -m pytest tests -q
```

Expected: dashboard tests, TypeScript, changed-file ESLint, production build, and the complete
worker suite all exit 0.

- [ ] **Step 2: Start the combined preview on an unused local port**

From the worktree root, run:

```bash
cd dashboard
npm run dev -- --port 3941
```

Expected: Next.js reports the Library preview at `http://localhost:3941/library`. If port 3941 is
already occupied, identify the owning process first and choose another unused port rather than
terminating an unrelated server.

- [ ] **Step 3: Check the real interaction in the browser**

At `http://localhost:3941/library`, verify all of the following:

1. Periods, Tags, and Platforms appear as three compact dropdowns rather than chip clouds.
2. Each dropdown has a searchable field, Select all, Clear all, and checkboxes.
3. Search hides nonmatching options while preserving checked options that are hidden.
4. Select all selects the complete group even while search is narrowed; Clear all clears it.
5. Choosing one or more values does not change cards or `showing N of M` before Apply.
6. Apply closes open dropdowns and updates the cards and count.
7. Two choices in one group form a union.
8. Choices across two groups narrow each other as an intersection.
9. Clearing all three and applying restores all posts allowed by the immediate filters.
10. Caption search changes results immediately without clicking Apply.
11. Escape and outside click close a dropdown; keyboard Tab reaches search, actions, and boxes.
12. Existing Select all shown, bulk edit, merge, schedule, season badges, and media links still work.

- [ ] **Step 4: Mark the design implemented**

Change the status line in
`docs/superpowers/specs/2026-08-03-library-compact-filters-design.md` to:

```markdown
**Status:** implemented and verified on `library-combined-preview`
```

- [ ] **Step 5: Commit verification documentation**

```bash
git add docs/superpowers/specs/2026-08-03-library-compact-filters-design.md
git commit -m "docs: record compact filter completion"
```

---

## Final completion checklist

- [ ] `git status --short` is clean in `.worktrees/library-combined-preview`.
- [ ] The final diff contains no migration, dependency, API, database-query, or worker change.
- [ ] `npm test`, `npx tsc --noEmit`, changed-file ESLint, `npm run build`, and worker tests are clean.
- [ ] The browser verification was performed on the combined preview, not main's older Library.
- [ ] No merge or push was performed without owner approval.
