# Library Bulk Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Design:** `docs/superpowers/specs/2026-08-02-library-bulk-edit-design.md`

**Goal:** Select N posts in the Library and apply tags, periods, status, kind or cooldown to all
of them in one atomic action.

**Architecture:** One new endpoint (`POST /api/posts/bulk-edit`) backed by one new query function
wrapped in a single transaction, driven from the bulk bar that already exists. **No migration,
no new dependency, no worker change.**

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, better-sqlite3.

## Global Constraints

- **Branch:** `library-bulk-edit`. Do not commit to `main`.
- **⚠️ Commit current working state first** — `docs/tasks.md` is modified.
- **No new dependencies**, **no migration**, **no change under `worker/`**.
- **Add/remove verbs only.** No set/replace path for tags or periods, ever.
- **Validate the whole batch before the first write.** Follow `/api/posts/bulk-import`, not
  `/api/posts/targets/bulk` (which leaves partial edits — see design).
- **Never test against the live database.** Copy it to the scratch dir first. Note `migrate.py`
  has no argument parser — even `--help` applies migrations to whatever DB it finds.
- The dashboard has a test runner: `npm test` → `node --test` over `lib/*.test.ts`.
- Dev server runs on **port 3939**.
- Every task ends with a commit, message ending
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/lib/queries.ts` (modify) | `bulkEditPosts()` — one transaction, add/remove verbs |
| `dashboard/app/api/posts/bulk-edit/route.ts` (create) | Validate-all-then-write-once |
| `dashboard/components/library-view.tsx` (modify) | Bulk-edit controls + confirm step |

---

### Task 1: `bulkEditPosts()` — the transactional write

Deliverable: a query function that applies a bulk edit atomically. No route, no UI yet.

**Files:** modify `dashboard/lib/queries.ts`

- [ ] **Step 1:** Define the input type — `post_ids`, optional `tags {add, remove}`,
      `periods {add, remove}`, and optional `content_status` / `content_kind` /
      `cooldown_days`. Omitted field ⇒ untouched; it does **not** mean "clear".
- [ ] **Step 2:** Implement inside a `better-sqlite3` transaction. Use `INSERT OR IGNORE` for
      adds so re-adding an existing tag/period is a no-op against the existing primary keys
      (`post_tags(post_id, tag_id)`, `post_periods(post_id, period_id, mode)`).
- [ ] **Step 3:** Deletes are scoped to the given post ids **and** the given tag/period ids only
      — never a blanket `DELETE ... WHERE post_id IN (...)`, which would be replace semantics
      through the back door.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Unit test in `dashboard/lib/` against a scratch DB: add a tag to 3 posts → all 3 carry it;
      re-run → still 3, no duplicates, no throw.
- [ ] Remove verb detaches only the named tag, leaving each post's other tags intact.
- [ ] A throw mid-transaction rolls back — assert **zero** rows changed.

---

### Task 2: `POST /api/posts/bulk-edit`

Deliverable: the route, validating everything before writing anything.

**Files:** create `dashboard/app/api/posts/bulk-edit/route.ts`

- [ ] **Step 1:** Parse and validate in this order, **all before any write**: every `post_id`
      exists → every tag id exists → every period id exists → scalars match the schema's CHECK
      values (`content_status IN ('draft','ready','retired')`,
      `content_kind IN ('one_time','evergreen')`).
- [ ] **Step 2:** Reuse `parseTagIds` and `parsePeriodLinks` from
      `lib/content-model-validation.ts`. Do not re-implement — the rules must not drift from
      the per-post route.
- [ ] **Step 3:** Call `bulkEditPosts()` once. Return the counts actually applied.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] **Against a scratch DB copy, via curl on the real route:** valid batch of 3 → 3 updated.
- [ ] **The atomicity test — the one that matters:** a batch containing one invalid period id
      returns 400 and changes **zero** rows. Prove it with a before/after `COUNT(*)` on
      `post_periods`, not by reading the response.
- [ ] Unknown post id → 400, nothing written.
- [ ] Empty `post_ids` → 400.

---

### Task 3: Bulk-edit UI

Deliverable: the controls in the Library's existing bulk bar.

**Files:** modify `dashboard/components/library-view.tsx`

- [ ] **Step 1:** Add controls to the existing bulk bar — reuse `<TagEditor>` / `<PeriodAttach>`
      where they fit, plus status / kind / cooldown pickers. Use the existing `selected` array;
      do **not** introduce a second selection model.
- [ ] **Step 2:** Make add-vs-remove explicit in the UI. The user must never be able to guess
      wrong about whether an action replaces.
- [ ] **Step 3:** Confirm step reading **"apply X to N posts"** before the request fires.
- [ ] **Step 4:** On success, refresh the affected cards and clear the selection.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Browser: select 3 posts → add a tag → all 3 cards show it.
- [ ] Select 3 → set status `ready` → cards update; reload confirms persistence.
- [ ] Confirm step shows the right count and can be cancelled with nothing written.
- [ ] Existing bulk-schedule / bulk re-target / merge still work (regression).

---

## Final verification (whole branch)

- [ ] `npm test` and `npx tsc --noEmit` both clean.
- [ ] Worker suite still green (`worker/tests`) — untouched, so a failure means something strayed.
- [ ] **Live DB untouched by testing:** `PRAGMA foreign_key_check` empty; `post_tags` /
      `post_periods` row counts explained.
- [ ] **Real-use dry run:** promote a filtered set to `ready` and confirm the count matches
      what the filter showed.
- [ ] `/code-review` per the project's standing workflow.
- [ ] Mark the bulk-edit item done in `docs/tasks.md`.
