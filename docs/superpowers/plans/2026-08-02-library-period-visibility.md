# Library Period Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Design:** `docs/superpowers/specs/2026-08-02-library-period-visibility-design.md`

**Goal:** Show which periods a post carries, filter by one or many, and indicate whether a post
is actually eligible today.

**Architecture:** One widened query (period rows instead of counts), one new multi-select filter,
and one new **pure TypeScript port** of the worker's season math. **No migration, no new
dependency, no worker change.**

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, better-sqlite3.

## Global Constraints

- **Branch:** `library-period-visibility`. Do not commit to `main`.
- **⚠️ Commit current working state first** — `docs/tasks.md` is modified.
- **No new dependencies**, **no migration**, **no change under `worker/`**. The worker is
  authoritative on seasons. If a task seems to need a worker edit, stop and re-read the design.
- **Never test against the live database.** Copy it to the scratch dir. Note `migrate.py` has no
  argument parser — even `--help` applies migrations to whatever DB it finds.
- The dashboard has a test runner: `npm test` → `node --test` over `lib/*.test.ts`.
  *(The older `2026-07-29-media-page.md` plan says the dashboard has no test framework. That is
  stale — it does now, and Task 3 depends on it.)*
- Dev server runs on **port 3939**.
- Every task ends with a commit, message ending
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Timezone decision — resolved

The owner approved the full four-task plan on 2026-08-03. The Library badge evaluates against
`config.defaultTimezone` and names that timezone in its advisory tooltip; the worker remains
authoritative in each target channel's timezone.

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/lib/queries.ts` (modify) | Widen `listPosts` to return period rows |
| `dashboard/components/library-view.tsx` (modify) | Named chips, multi-select filter, season badge |
| `dashboard/lib/periods.ts` (create) | Pure TS port of `period_contains` / `in_season` |
| `dashboard/lib/periods.test.ts` (create) | Ported Python cases + wrap-around table |

---

### Task 1: Period names reach the card

Deliverable: cards show period **names** instead of `green ×2`. Read-only.

**Files:** modify `dashboard/lib/queries.ts`, `dashboard/components/library-view.tsx`

- [x] **Step 1:** Replace the `green_period_count` / `blackout_period_count` `COUNT(...)`
      subqueries in `listPosts()` with the period rows (`id`, `name`, `mode`) per post. Use
      `GROUP_CONCAT` or one batched second query keyed by post id. **Do not** call
      `getPostPeriods()` per card — that is N+1 across 139 posts.
- [x] **Step 2:** Update the `PostRow` type accordingly.
- [x] **Step 3:** Replace the `green ×N` render at `library-view.tsx:505` with named chips.
      Blackout chips must be **visually distinct** from green — they mean the opposite thing.

**Verification:**
- [x] `npx tsc --noEmit` clean.
- [x] Browser: a post known to carry Football Season shows it **by name**.
- [x] A post with a blackout period renders it distinguishably.
- [x] Query count does not scale with post count — confirm no N+1 (log or inspect).

---

### Task 2: Multi-select period filter

Deliverable: filter the Library to one or more periods.

**Files:** modify `dashboard/components/library-view.tsx`

- [x] **Step 1:** Add `periodFilter` as a `Set<number>`. Model it on `chans`, **not** on the
      single-select `tagFilter` — this is the first multi-select filter in the Library.
- [x] **Step 2:** Semantics: a post matches if it carries **any** selected period (OR within the
      filter), AND-combined with the existing tag / platform / status / kind / format / search
      filters. Include blackout periods as selectable.
- [x] **Step 3:** Feed the existing "showing N of M" count.

**Verification:**
- [x] `npx tsc --noEmit` clean.
- [x] Filter to Football Season → **36 posts** (the set marked on 2026-08-02 — a known-good
      number to check against).
- [x] Two periods selected → **union**, not intersection.
- [x] Period filter + tag filter together → AND (narrower, not broader).
- [x] Clearing the filter restores all 139.

---

### Task 3: Port the season math

Deliverable: `dashboard/lib/periods.ts`, tested, **not yet wired to any UI**.

**Files:** create `dashboard/lib/periods.ts`, `dashboard/lib/periods.test.ts`

- [x] **Step 1:** Port `period_contains` and `in_season` from `worker/periods.py`. Pure
      functions, no I/O. **Take the evaluation date as a parameter** — do not read "today"
      inside, or the tests cannot be deterministic.
- [x] **Step 2:** Write `periods.test.ts` **before wiring any UI**. Port the Python cases and add
      an explicit wrap-around table. Must cover:
      - Aug 25 → Feb 15 evaluated on **Dec 1 (in)**, **Aug 1 (out)**, **Feb 20 (out)**,
        **Aug 25 (in)**, **Feb 15 (in)** — the boundary days
      - a blackout beating an overlapping green
      - **no green periods ⇒ in season** (the easy inversion; it would mislabel most of the
        library)
      - one-off `start_date` / `end_date` windows
- [x] **Step 3:** Apply the owner's timezone decision for how "today" is derived.

**Verification:**
- [x] `npm test` — new tests pass; the existing test files still pass.
- [x] **Cross-check against the real Python, not just against these tests.** Pick 3 posts, run
      the worker's `in_season` against a scratch DB copy for the same date, and confirm the TS
      verdict matches. **This is the entire risk of the sub-project — do not skip it.**

---

### Task 4: The in-season badge

Deliverable: `ready` posts read **Live** / **Dormant** / **Blocked**.

**Files:** modify `dashboard/components/library-view.tsx`

- [x] **Step 1:** Compute the verdict per post using `lib/periods.ts`.
- [x] **Step 2:** Render per the design's badge state table. `draft` / `retired` keep their
      existing chip — season is moot for them.
- [x] **Step 3:** Tooltip names the timezone the verdict was computed in.

**Verification:**
- [x] `npx tsc --noEmit` clean.
- [x] Browser on today's date (**August**): a scratch-promoted Football Season post reads
      **Dormant**, not Live. The live 36 Football posts are drafts and correctly remain Draft.
- [x] A `ready` post with **no** periods reads **Live** (rule 3).
- [x] A post covered by a blackout reads **Blocked**, even if a green period also covers today.
- [x] `draft` posts are unchanged.

---

## Final verification (whole branch)

- [x] `npm test` and `npx tsc --noEmit` both clean.
- [x] Worker suite still green (`worker/tests`) — untouched, so a failure means something strayed.
- [x] Live DB untouched by testing: `PRAGMA foreign_key_check` empty, row counts unchanged.
- [x] **The badge agrees with the worker** on a spot-check of at least 3 posts (Task 3's
      cross-check, repeated on the finished UI).
- [ ] `/code-review` per the project's standing workflow.
- [x] Record the timezone decision in `docs/tasks.md` and mark the item done.
