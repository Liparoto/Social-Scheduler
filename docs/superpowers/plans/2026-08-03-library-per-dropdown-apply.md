# Library Per-Dropdown Apply Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Apply into each Periods, Tags, and Platforms dropdown so each filter applies independently and closing without Apply discards that dropdown's temporary choices.

**Architecture:** `LibraryView` owns only applied filter Sets and availability reconciliation. Each `CheckboxFilterDropdown` owns its temporary selection and search state, initializes them from the applied prop when opened, and calls `onApply` only from its internal Apply button. The reducer, component, and caller change together because their public contracts are tightly coupled.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Node test runner, React server-rendering UI tests, Tailwind CSS.

---

## Global constraints

- Work only in `.worktrees/library-combined-preview` on branch `library-combined-preview`.
- Do not merge or push without owner approval.
- Add no dependency, migration, API route, database query, or worker change.
- Preserve the stale-option reconciliation added in `a957cd6`.
- Trigger counts show applied values only; temporary choices never change results or counts.
- Escape/outside click discard; internal Apply affects only its own dropdown.
- Use TDD and keep the implementation commit TypeScript-clean.

## File structure

| File | Responsibility |
|---|---|
| `dashboard/lib/library-checkbox-filters.ts` | Applied-only reducer, availability reconciliation, matching, and option helpers |
| `dashboard/lib/library-checkbox-filters.test.ts` | Per-group isolation, clearing, matching, and stale-option regression tests |
| `dashboard/components/checkbox-filter-dropdown.tsx` | Temporary selection, search, dismissal, focus, and internal Apply UI |
| `dashboard/test-ui/checkbox-filter-dropdown-ui.test.ts` | Applied trigger count and internal Apply markup contract |
| `dashboard/components/library-view.tsx` | Applied filter ownership and per-dropdown Apply dispatch |
| `docs/superpowers/specs/2026-08-03-library-compact-filters-design.md` | Revision completion status after verification |

---

### Task 1: Implement independent per-dropdown Apply

**Files:**
- Modify: `dashboard/lib/library-checkbox-filters.ts:8-84`
- Modify: `dashboard/lib/library-checkbox-filters.test.ts:28-181`
- Modify: `dashboard/components/checkbox-filter-dropdown.tsx:10-171`
- Modify: `dashboard/test-ui/checkbox-filter-dropdown-ui.test.ts:14-101`
- Modify: `dashboard/components/library-view.tsx:3-115, 400-466`

- [ ] **Step 1: Write failing reducer tests for independent Apply**

Replace shared draft/global Apply tests with:

```ts
test("applying one group leaves the other applied groups unchanged", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "periods",
    values: new Set([10]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "platforms",
    values: new Set(["instagram"]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(["tips", "promo"]),
  });

  assert.deepEqual([...state.applied.periods], [10]);
  assert.deepEqual([...state.applied.tags], ["tips", "promo"]);
  assert.deepEqual([...state.applied.platforms], ["instagram"]);
});

test("applying an empty group clears only that group", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "periods",
    values: new Set([10]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(["tips"]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(),
  });

  assert.deepEqual([...state.applied.periods], [10]);
  assert.deepEqual([...state.applied.tags], []);
});
```

Rewrite the availability regression to seed all groups through `apply-group`, reconcile against
empty period/tag availability plus Instagram, and assert stale values are removed while the valid
platform remains. Retain search, Select all, OR/AND, empty-group, and caption-composition tests.

- [ ] **Step 2: Write the failing internal-Apply UI test**

Update dropdown test props from `onChange`/`closeSignal` to `onApply`. Extend the panel props with
`onApply`, then add:

```ts
test("panel contains its own Apply action after the checkbox list", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterPanel<number>, {
      label: "Periods",
      options: periodOptions,
      selected: new Set([1]),
      onChange: noop,
      onApply: noop,
      query: "",
      onQueryChange: noop,
    }),
  );

  assert.match(html, /<button[^>]*>Apply<\/button>/);
  assert.ok(html.indexOf("Evening") < html.indexOf(">Apply</button>"));
});
```

- [ ] **Step 3: Run both focused tests and verify RED**

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/library-checkbox-filters.test.ts
node --import ./test/ui-hook.mjs --test --test-concurrency=1 test-ui/checkbox-filter-dropdown-ui.test.ts
```

Expected: reducer tests fail because `apply-group` does not exist; UI tests fail because the panel
has no internal Apply and the dropdown still expects shared-stage props.

- [ ] **Step 4: Make the reducer applied-only**

Use:

```ts
export interface LibraryCheckboxFilterState {
  applied: LibraryCheckboxSelections;
}

export type LibraryCheckboxFilterAction =
  | { type: "apply-group"; group: "periods"; values: Set<number> }
  | { type: "apply-group"; group: "tags" | "platforms"; values: Set<string> }
  | { type: "reconcile-available"; available: LibraryCheckboxSelections };

export function createLibraryCheckboxFilterState(): LibraryCheckboxFilterState {
  return { applied: emptySelections() };
}
```

The reducer implementation is:

```ts
if (action.type === "reconcile-available") {
  const applied = intersectSelections(state.applied, action.available);
  return selectionsEqual(applied, state.applied) ? state : { applied };
}

if (action.group === "periods") {
  return { applied: { ...state.applied, periods: new Set(action.values) } };
}

return {
  applied: { ...state.applied, [action.group]: new Set(action.values) },
};
```

Remove draft state, `set-draft`, global `apply`, and the unused whole-selection copy helper.
Retain option helpers, matching, typed identities, and no-op reconciliation identity.

- [ ] **Step 5: Put temporary state and Apply inside the dropdown**

Change `CheckboxFilterDropdown` props to applied `selected` plus `onApply(next)`. Remove
`closeSignal`. Add local `draft` initialized from `selected`.

```tsx
function discardAndClose() {
  setDraft(new Set(selected));
  setQuery("");
  setOpen(false);
}

function toggleOpen() {
  if (open) return discardAndClose();
  setDraft(new Set(selected));
  setQuery("");
  setOpen(true);
}
```

Pass `draft`/`setDraft` to `CheckboxFilterPanel`. Give the panel an `onApply` callback and render
Apply in a bordered footer after the scrollable list.

Sanitize against current options before applying so refreshed-away values cannot return:

```tsx
function applyAndClose() {
  const available = allOptionValues(options);
  onApply(new Set([...draft].filter((value) => available.has(value))));
  setOpen(false);
  setQuery("");
  requestAnimationFrame(() => triggerRef.current?.focus());
}
```

Escape prevents default, discards, closes, and restores trigger focus. Outside click discards and
closes without moving destination focus. Dismissal must copy the latest applied `selected` prop,
even if refreshed availability changes while the panel is open; use correct hook dependencies or
a current ref rather than a stale event-listener closure. Trigger text reads the applied
`selected` prop.

- [ ] **Step 6: Wire each Library dropdown independently**

Delete `filterApplySignal`, shared Apply JSX, and the staged-together comment. Keep availability
reconciliation and the applied matcher. Use:

```tsx
<CheckboxFilterDropdown
  label="Periods"
  options={periodOptions}
  selected={checkboxFilters.applied.periods}
  onApply={(values) =>
    dispatchCheckboxFilters({ type: "apply-group", group: "periods", values })
  }
/>
<CheckboxFilterDropdown
  label="Tags"
  options={tagOptions}
  selected={checkboxFilters.applied.tags}
  onApply={(values) =>
    dispatchCheckboxFilters({ type: "apply-group", group: "tags", values })
  }
/>
<CheckboxFilterDropdown
  label="Platforms"
  options={platformOptions}
  selected={checkboxFilters.applied.platforms}
  onApply={(values) =>
    dispatchCheckboxFilters({ type: "apply-group", group: "platforms", values })
  }
/>
```

The filter row contains no shared Apply button.

- [ ] **Step 7: Run focused and full verification**

```bash
cd dashboard
node --conditions=react-server --import ./test/hook.mjs --test --test-concurrency=1 lib/library-checkbox-filters.test.ts
node --import ./test/ui-hook.mjs --test --test-concurrency=1 test-ui/checkbox-filter-dropdown-ui.test.ts
npm test
npx tsc --noEmit
npx eslint components/library-view.tsx components/checkbox-filter-dropdown.tsx lib/library-checkbox-filters.ts lib/library-checkbox-filters.test.ts test-ui/checkbox-filter-dropdown-ui.test.ts
```

Expected: focused and full dashboard tests PASS; TypeScript and scoped ESLint exit 0.

- [ ] **Step 8: Commit Task 1**

```bash
git add dashboard/lib/library-checkbox-filters.ts dashboard/lib/library-checkbox-filters.test.ts dashboard/components/checkbox-filter-dropdown.tsx dashboard/test-ui/checkbox-filter-dropdown-ui.test.ts dashboard/components/library-view.tsx
git commit -m "feat(library): apply each filter independently"
```

---

### Task 2: Verify the revised interaction

**Files:**
- Modify: `docs/superpowers/specs/2026-08-03-library-compact-filters-design.md:4`

- [ ] **Step 1: Run full automated verification**

```bash
cd dashboard
npm test
npx tsc --noEmit
npx eslint components/library-view.tsx components/checkbox-filter-dropdown.tsx lib/library-checkbox-filters.ts lib/library-checkbox-filters.test.ts test-ui/checkbox-filter-dropdown-ui.test.ts
DATABASE_PATH='/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/data/socialscheduler.db' npm run build
cd ../worker
"/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/.venv/bin/python" -m pytest tests -q
```

Expected: all dashboard tests, TypeScript, scoped lint, build, and all worker tests exit 0.

- [ ] **Step 2: Verify real localhost behavior in Chrome**

Use an unused port and task-owned Chrome/CDP profile. Verify:

1. No shared Apply appears in the row; each dropdown has one Apply at its bottom.
2. Period temporary changes do not change results until Periods Apply.
3. Tags may hold different temporary choices while Periods is applied; Periods Apply does not
   submit Tags.
4. Tags Apply updates only Tags and composes with Periods using AND.
5. Escape and outside click discard temporary changes; reopening shows applied checks/count.
6. Select all/Clear all remain complete-group temporary actions.
7. Applying an empty Set clears only that group.
8. Apply and Escape restore trigger focus; outside click retains destination focus.
9. Caption search remains immediate and existing Library workflows remain present.
10. The stale-option bulk-edit refresh regression remains fixed on a scratch DB.
11. Console/runtime errors are empty and no unintended live DB writes occur.

- [ ] **Step 3: Mark the revision implemented**

```markdown
**Status:** per-dropdown Apply revision implemented and verified on `library-combined-preview`
```

- [ ] **Step 4: Commit verification documentation**

```bash
git add docs/superpowers/specs/2026-08-03-library-compact-filters-design.md
git commit -m "docs: record per-filter apply completion"
```

---

## Final completion checklist

- [ ] Each dropdown applies only itself and has no shared Apply button.
- [ ] Closing without Apply discards temporary values.
- [ ] Trigger counts and `showing N of M` reflect applied values only.
- [ ] Stale availability reconciliation passes automated and scratch-browser regression.
- [ ] Dashboard tests, TypeScript, scoped lint, build, and worker tests are clean.
- [ ] Worktree is clean; no merge or push occurred without approval.
