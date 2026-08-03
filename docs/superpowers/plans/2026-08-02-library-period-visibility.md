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

## ⚠️ Blocking decision

**Tasks 3–4 cannot start until the owner answers the timezone question** in the design's §Open
question (recommendation: `config.defaultTimezone`). **Tasks 1–2 are unblocked** and deliver
real value on their own — do those first regardless.

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

- [ ] **Step 1:** Replace the `green_period_count` / `blackout_period_count` `COUNT(...)`
      subqueries in `listPosts()` with the period rows (`id`, `name`, `mode`) per post. Use
      `GROUP_CONCAT` or one batched second query keyed by post id. **Do not** call
      `getPostPeriods()` per card — that is N+1 across 139 posts.
- [ ] **Step 2:** Update the `PostRow` type accordingly.
- [ ] **Step 3:** Replace the `green ×N` render at `library-view.tsx:505` with named chips.
      Blackout chips must be **visually distinct** from green — they mean the opposite thing.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Browser: a post known to carry Football Season shows it **by name**.
- [ ] A post with a blackout period renders it distinguishably.
- [ ] Query count does not scale with post count — confirm no N+1 (log or inspect).

---

### Task 2: Multi-select period filter

Deliverable: filter the Library to one or more periods.

**Files:** modify `dashboard/components/library-view.tsx`

- [ ] **Step 1:** Add `periodFilter` as a `Set<number>`. Model it on `chans`, **not** on the
      single-select `tagFilter` — this is the first multi-select filter in the Library.
- [ ] **Step 2:** Semantics: a post matches if it carries **any** selected period (OR within the
      filter), AND-combined with the existing tag / platform / status / kind / format / search
      filters. Include blackout periods as selectable.
- [ ] **Step 3:** Feed the existing "showing N of M" count.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Filter to Football Season → **36 posts** (the set marked on 2026-08-02 — a known-good
      number to check against).
- [ ] Two periods selected → **union**, not intersection.
- [ ] Period filter + tag filter together → AND (narrower, not broader).
- [ ] Clearing the filter restores all 139.

---

### Task 3: Port the season math ⚠️ blocked on the timezone decision

Deliverable: `dashboard/lib/periods.ts`, tested, **not yet wired to any UI**.

**Files:** create `dashboard/lib/periods.ts`, `dashboard/lib/periods.test.ts`

- [ ] **Step 1:** Port `period_contains` and `in_season` from `worker/periods.py`. Pure
      functions, no I/O. **Take the evaluation date as a parameter** — do not read "today"
      inside, or the tests cannot be deterministic.
- [ ] **Step 2:** Write `periods.test.ts` **before wiring any UI**. Port the Python cases and add
      an explicit wrap-around table. Must cover:
      - Aug 25 → Feb 15 evaluated on **Dec 1 (in)**, **Aug 1 (out)**, **Feb 20 (out)**,
        **Aug 25 (in)**, **Feb 15 (in)** — the boundary days
      - a blackout beating an overlapping green
      - **no green periods ⇒ in season** (the easy inversion; it would mislabel most of the
        library)
      - one-off `start_date` / `end_date` windows
- [ ] **Step 3:** Apply the owner's timezone decision for how "today" is derived.

**Verification:**
- [ ] `npm test` — new tests pass; the existing 8 test files still pass.
- [ ] **Cross-check against the real Python, not just against these tests.** Pick 3 posts, run
      the worker's `in_season` against a scratch DB copy for the same date, and confirm the TS
      verdict matches. **This is the entire risk of the sub-project — do not skip it.**

---

### Task 4: The in-season badge ⚠️ depends on Task 3

Deliverable: `ready` posts read **Live** / **Dormant** / **Blocked**.

**Files:** modify `dashboard/components/library-view.tsx`

- [ ] **Step 1:** Compute the verdict per post using `lib/periods.ts`.
- [ ] **Step 2:** Render per the design's badge state table. `draft` / `retired` keep their
      existing chip — season is moot for them.
- [ ] **Step 3:** Tooltip names the timezone the verdict was computed in.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Browser on today's date (**August**): the 36 football posts read **Dormant**, not Live.
      This is the owner's stated example and the headline check.
- [ ] A `ready` post with **no** periods reads **Live** (rule 3).
- [ ] A post covered by a blackout reads **Blocked**, even if a green period also covers today.
- [ ] `draft` posts are unchanged.

---

## Final verification (whole branch)

- [ ] `npm test` and `npx tsc --noEmit` both clean.
- [ ] Worker suite still green (`worker/tests`) — untouched, so a failure means something strayed.
- [ ] Live DB untouched by testing: `PRAGMA foreign_key_check` empty, row counts unchanged.
- [ ] **The badge agrees with the worker** on a spot-check of at least 3 posts (Task 3's
      cross-check, repeated on the finished UI).
- [ ] `/code-review` per the project's standing workflow.
- [ ] Record the timezone decision in `docs/tasks.md` and mark the item done.
