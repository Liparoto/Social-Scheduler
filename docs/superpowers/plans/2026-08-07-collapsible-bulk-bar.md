# Collapsible Bulk Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Library page's bulk bar collapses to a single row and stays that way across reloads, giving back the vertical space it costs while reviewing content.

**Architecture:** One new `localStorage`-backed hook built on `useSyncExternalStore` (server snapshot = the default, so no hydration mismatch), plus a header row and a conditional wrapper around the existing bar contents in `library-view.tsx`. No new dependencies, no schema change, no API change.

**Tech Stack:** React 19 client components, `useSyncExternalStore`, `node:test`, Tailwind theme tokens.

**Spec:** [`docs/superpowers/specs/2026-08-07-collapsible-bulk-bar-design.md`](../specs/2026-08-07-collapsible-bulk-bar-design.md)

## Global Constraints

- **No new dependencies.** The dashboard ships six runtime deps; keep it that way.
- **Default is EXPANDED.** A fresh clone must behave exactly as it does today until someone
  collapses it themselves.
- **Selecting posts must NOT auto-expand a collapsed bar.** Selecting is part of reviewing.
- **Never read `localStorage` during render or in a mount effect.** The server cannot know the
  stored value; `useSyncExternalStore` with a server snapshot is the required shape. Follow
  `dashboard/components/emoji-hint.tsx`, which solved the same problem.
- **`z-20` on the bar's container is load-bearing** — the thumbnails' `MediaBadge` is `z-10`
  and punched through the bar's background before it was added. Do not change it, and keep it
  on the collapsed state too. The lightbox stays above at `z-50`.
- **Theme tokens only** — no hardcoded hex. Must read correctly in light and dark.
- Dashboard tests: from `dashboard/`: `npm test`, `npm run lint` (must stay 0 errors)

---

### Task 1: `usePersistedToggle`

The only part with real edge cases, and testable without rendering the Library at all.

**Files:**
- Create: `dashboard/lib/use-persisted-toggle.ts`
- Create: `dashboard/lib/use-persisted-toggle.test.ts`

**Interfaces:**
- Produces:
  - `usePersistedToggle(key: string, defaultOn: boolean): [boolean, (next: boolean) => void]`
  - `readPersistedToggle(key: string, defaultOn: boolean): boolean` — the pure storage read,
    exported so the tests can exercise the edge cases without a React renderer
  - `writePersistedToggle(key: string, next: boolean): void`
  - `__resetPersistedToggleCacheForTests(): void`

**Note on testing shape:** the dashboard's test harness runs `node:test` without a DOM, so the
hook itself cannot be rendered here. Test the exported read/write/cache functions directly —
they hold all the branching. The hook is a thin `useSyncExternalStore` wrapper over them and is
covered by the browser pass in Task 3.

- [ ] **Step 1: Write the failing test**

Create `dashboard/lib/use-persisted-toggle.test.ts`:

```ts
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  readPersistedToggle,
  writePersistedToggle,
  __resetPersistedToggleCacheForTests,
} from "./use-persisted-toggle.ts";

// node:test runs without a DOM, so stand up the smallest localStorage that satisfies the
// three calls the module makes.
function installStorage(initial: Record<string, string> = {}, throwOnAccess = false) {
  const store = new Map(Object.entries(initial));
  // defineProperty, not assignment: recent Node versions expose a built-in `localStorage`
  // global that can be non-writable, and a plain `globalThis.localStorage = …` throws there.
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem(k: string) {
        if (throwOnAccess) throw new Error("storage disabled");
        return store.has(k) ? store.get(k)! : null;
      },
      setItem(k: string, v: string) {
        if (throwOnAccess) throw new Error("storage disabled");
        store.set(k, v);
      },
    },
  });
  return store;
}

beforeEach(() => {
  __resetPersistedToggleCacheForTests();
});

test("returns the default when nothing is stored", () => {
  installStorage();
  assert.equal(readPersistedToggle("k", true), true);
  __resetPersistedToggleCacheForTests();
  assert.equal(readPersistedToggle("k", false), false);
});

test("round-trips a written value", () => {
  installStorage();
  writePersistedToggle("k", false);
  assert.equal(readPersistedToggle("k", true), false, "stored false must beat a true default");
  __resetPersistedToggleCacheForTests();
  writePersistedToggle("k", true);
  assert.equal(readPersistedToggle("k", false), true);
});

test("a corrupt stored value falls back to the default rather than reading as false", () => {
  // JSON.parse("banana") throws; a bare `=== "true"` check would silently return false and
  // quietly collapse a bar the user never collapsed.
  installStorage({ k: "banana" });
  assert.equal(readPersistedToggle("k", true), true);
});

test("storage that throws degrades to the default instead of crashing the page", () => {
  installStorage({}, true);
  assert.equal(readPersistedToggle("k", true), true);
  assert.doesNotThrow(() => writePersistedToggle("k", false));
});

test("keys do not bleed into each other", () => {
  installStorage();
  writePersistedToggle("a", false);
  assert.equal(readPersistedToggle("a", true), false);
  assert.equal(readPersistedToggle("b", true), true);
});

test("the cache returns a STABLE value across reads", () => {
  // useSyncExternalStore re-renders forever if getSnapshot returns a fresh value each call.
  installStorage({ k: "false" });
  const first = readPersistedToggle("k", true);
  const second = readPersistedToggle("k", true);
  assert.equal(first, second);
});
```

- [ ] **Step 2: Run it to verify it fails**

From `dashboard/`:
```bash
npm test
```
Expected: FAIL — `Cannot find module './use-persisted-toggle.ts'`.

- [ ] **Step 3: Implement it**

Create `dashboard/lib/use-persisted-toggle.ts`:

```ts
"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A boolean that remembers itself in localStorage.
 *
 * Built on useSyncExternalStore rather than useState + a mount effect, for two reasons that
 * both bit this codebase already:
 *
 *  - The server cannot know what this browser last chose, so reading storage during render
 *    guarantees a hydration mismatch. `getServerSnapshot` returns the default instead, and the
 *    client corrects on hydration. (Same shape as components/emoji-hint.tsx.)
 *  - Calling setState synchronously inside an effect triggers a cascading render, and the lint
 *    rule that catches it is an error here, not a warning.
 *
 * Everything touching storage is wrapped: a browser with storage disabled, or a private window
 * that throws on access, must degrade to the default rather than taking the page down over a
 * remembered panel state.
 */

// getSnapshot MUST return a stable value across calls or useSyncExternalStore re-renders
// forever. This cache is what makes that true.
const cache = new Map<string, boolean>();
const listeners = new Set<() => void>();

/** Test seam: clears the memoised reads so each case starts clean. */
export function __resetPersistedToggleCacheForTests(): void {
  cache.clear();
}

export function readPersistedToggle(key: string, defaultOn: boolean): boolean {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let value = defaultOn;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      // Only an actual boolean counts. A corrupt value falls through to the default rather
      // than reading as false, which would collapse a bar nobody collapsed.
      if (typeof parsed === "boolean") value = parsed;
    }
  } catch {
    // No storage, or unparseable contents — the default is the honest answer.
  }
  cache.set(key, value);
  return value;
}

export function writePersistedToggle(key: string, next: boolean): void {
  cache.set(key, next);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage full or unavailable. The in-memory cache still holds for this session, so the
    // toggle works — it just will not survive a reload.
  }
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function usePersistedToggle(
  key: string,
  defaultOn: boolean
): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => readPersistedToggle(key, defaultOn),
    () => defaultOn
  );
  const set = useCallback((next: boolean) => writePersistedToggle(key, next), [key]);
  return [value, set];
}
```

- [ ] **Step 4: Run the tests and lint**

```bash
npm test && npm run lint
```
Expected: all PASS, lint 0 errors.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/use-persisted-toggle.ts dashboard/lib/use-persisted-toggle.test.ts
git commit -m "feat(library): add a localStorage-backed toggle hook"
```

---

### Task 2: Collapse the bulk bar

**Files:**
- Modify: `dashboard/components/library-view.tsx:3` (import)
- Modify: `dashboard/components/library-view.tsx:780-932` (the bar)

**Interfaces:**
- Consumes: `usePersistedToggle(key, defaultOn)` from Task 1

- [ ] **Step 1: Add the import**

In `dashboard/components/library-view.tsx`, beside the existing `@/lib/...` imports:

```ts
import { usePersistedToggle } from "@/lib/use-persisted-toggle";
```

- [ ] **Step 2: Add the state**

Next to the component's other `useState` calls:

```ts
  // Remembered per install. Default TRUE (expanded) so a fresh clone behaves exactly as it
  // did before this existed — the bar only ever hides because someone asked it to.
  const [barOpen, setBarOpen] = usePersistedToggle("ss.library.bulkBarOpen", true);
```

- [ ] **Step 3: Wrap the bar in a header plus a conditional panel**

Replace the opening of the bar block at line 783. The container keeps its exact classes —
`z-20` is load-bearing (see the comment already above it) and the collapsed state needs the
same stacking.

```tsx
      <div className="sticky bottom-4 z-20 rounded-card border border-border-strong bg-surface shadow-lg">
        {/* The whole header row toggles, not just the chevron — a 12px icon is a poor target
            for something used this often. */}
        <button
          type="button"
          onClick={() => setBarOpen(!barOpen)}
          aria-expanded={barOpen}
          aria-controls="bulk-bar-panel"
          className="flex w-full items-center gap-3 rounded-card px-4 py-3 text-left hover:bg-surface-sunken"
        >
          <span className="text-sm font-semibold text-ink">Scheduler &amp; bulk edits</span>
          <span className="text-xs text-muted">
            <span className="data font-semibold text-ink">{selected.length}</span> selected
          </span>
          <svg
            viewBox="0 0 20 20"
            className={`ml-auto h-4 w-4 text-muted transition-transform ${barOpen ? "" : "rotate-180"}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden="true"
          >
            <path d="M5 12.5 10 7.5l5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {barOpen ? (
          <div id="bulk-bar-panel" className="border-t border-border p-4">
            <div className="flex flex-wrap items-end gap-4">
```

Then, at the end of the bar (the closing `</div>` at line 932), close the new wrapper too:

```tsx
          </div>
        ) : null}
      </div>
```

**Two details that are easy to get wrong:**
- The container previously carried `p-4`. That padding moves onto the inner panel, or the
  collapsed header sits inside 16px of dead space on every side.
- The old first child was `<div className="flex flex-wrap items-end gap-4">`. It is now nested
  one level deeper inside `#bulk-bar-panel`; do not delete it.

- [ ] **Step 4: Verify the JSX still balances**

```bash
npm run lint && npx tsc --noEmit 2>&1 | grep -v "queries.tags.test" | head -5
```
Expected: lint 0 errors. The only `tsc` error should be the pre-existing
`lib/queries.tags.test.ts(54,5)`, which this task does not touch.

- [ ] **Step 5: Run the suite**

```bash
npm test
```
Expected: PASS, no change in count (this task adds no unit tests — the behaviour is visual and
is covered by Task 3).

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/library-view.tsx
git commit -m "feat(library): collapse the bulk bar to a single row"
```

---

### Task 3: Verify it in a real browser

The dashboard's harness renders to static markup, so it cannot catch a toggle that does not
fire, a panel that does not persist, or a collapsed bar that lets thumbnails punch through it.

**Runs against an ISOLATED copy — never the live install.**

- [ ] **Step 1: Stand up an isolated dashboard**

Next 16 refuses a second dev server from the same directory and the owner's runs on 3939, so
clone the app rather than killing theirs:

```bash
SP=<scratchpad>
REPO=<repo root>
rm -rf "$SP/dash-verify" && mkdir -p "$SP/dash-verify"
cp -Rc "$REPO/dashboard" "$SP/dash-verify/dashboard"   # APFS copy-on-write, ~1s for 500 MB
rm -rf "$SP/dash-verify/dashboard/.next"
ln -sf "$REPO/.env" "$SP/dash-verify/.env"
sqlite3 "$REPO/data/socialscheduler.db" ".backup '$SP/verify.db'"
```

Add a `dashboard-verify` entry to `.claude/launch.json` running that copy on port 3941 with
`DATABASE_PATH` and `ASSET_STORAGE_DIR` pointed at the scratch copies, and **revert that file
when done** — it is tracked.

- [ ] **Step 2: Measure the space reclaimed**

On `/library`, record `document.querySelector('[aria-controls="bulk-bar-panel"]')
.closest('div').getBoundingClientRect().height` expanded, then collapsed. Report both numbers
and the difference — the benefit should be a measured figure, not a claim.

- [ ] **Step 3: Confirm the toggle and its persistence**

Collapse → reload → still collapsed. Expand → reload → still expanded. Check
`localStorage.getItem('ss.library.bulkBarOpen')` reads `"false"` then `"true"`.

- [ ] **Step 4: Confirm selecting does not auto-expand**

With the bar collapsed, tick two posts. The header count must update to `2 selected` and the
panel must stay closed. This is the specific behaviour the spec chose; if it springs open, the
feature is wrong.

- [ ] **Step 5: Confirm the z-20 regression has not returned**

Collapse the bar, scroll the grid so thumbnails pass beneath it, and screenshot. No media badge
may show through the bar's background. This is why the `z-20` comment exists.

- [ ] **Step 6: Confirm both themes**

Screenshot the collapsed and expanded header in a light and a dark theme. Chevron, label, and
count must all be legible in both.

- [ ] **Step 7: Run everything, record results, commit**

```bash
cd dashboard && npm test && npm run lint
.venv/bin/python -m pytest worker/tests -q
```

Append a section to `docs/tasks.md` in the established style with the measured pixel figures and
the real test counts. Tear down the scratch copy and revert `.claude/launch.json`.

---

## Still open after this plan

**`library-view.tsx` remains ~990 lines and grows slightly.** The bar reads a dozen pieces of
parent state, so extracting it is a much larger change than a collapse toggle should carry.
Recorded in the spec rather than fixed here.

**One frame renders expanded before a collapsed bar settles.** Inherent to returning the default
as the server snapshot; the alternative is a hydration mismatch. Accepted deliberately.
