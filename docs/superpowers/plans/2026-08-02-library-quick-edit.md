# Library Quick Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Design:** `docs/superpowers/specs/2026-08-02-library-quick-edit-design.md`

**Goal:** Edit a post's common metadata from the Library without navigating to `/library/[id]`.

**Architecture:** One new client component saving through the **existing**
`PATCH /api/posts/[id]/content`. **No new endpoint, no migration, no new dependency, no worker
change.**

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19.

## Global Constraints

- **Branch:** `library-quick-edit`. Do not commit to `main`.
- **⚠️ Commit current working state first** — `docs/tasks.md` is modified.
- **No new endpoint.** If a task seems to need one, stop and re-read the design — the existing
  `PATCH` route already accepts this field set.
- **No new dependencies**, **no migration**, **no change under `worker/`**.
- **No captions in v1** (they are `1..N` variants — ambiguous). No images, sends, or targets.
- The dashboard has a test runner: `npm test` → `node --test` over `lib/*.test.ts`.
- Dev server runs on **port 3939**.
- Every task ends with a commit, message ending
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Decision required in Task 2

**Dirty-state behaviour must be chosen, not defaulted:** confirm-on-dismiss, or save-then-close.
See the design's trap section — this project already shipped a fix for silently-discarded edits
once. Whichever is picked gets written into the component header **and** `docs/tasks.md`.

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/components/quick-edit-modal.tsx` (create) | The dialog: fields, save, dirty handling |
| `dashboard/components/library-view.tsx` (modify) | The trigger on the card + in-place refresh |

---

### Task 1: The modal, save path working

Deliverable: a dialog that loads a post's values and saves them. Dismissal behaviour not yet
hardened.

**Files:** create `dashboard/components/quick-edit-modal.tsx`

- [ ] **Step 1:** Build the dialog composing `<TagEditor>` and `<PeriodAttach>` plus
      `content_status` / `content_kind` / `cooldown_days` controls. **No captions.**
- [ ] **Step 2:** Load current values on open (the list row already carries status/kind/tags;
      fetch periods if not already present — one post, so a fetch on open is fine).
- [ ] **Step 3:** Save via the existing `PATCH /api/posts/[id]/content`. Do **not** add a route.
- [ ] **Step 4:** Surface API errors in the dialog rather than closing on failure.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Browser: open on a post → fields show that post's **current** values (not blanks/defaults).
- [ ] Change status → save → reopen shows the new value; confirm persisted in the DB.
- [ ] A rejected save (e.g. invalid cooldown) shows the error and keeps the dialog open with the
      user's input intact.

---

### Task 2: Dirty-state handling ⚠️ the trap

Deliverable: an unsaved edit can never be silently lost.

**Files:** modify `dashboard/components/quick-edit-modal.tsx`

- [ ] **Step 1:** Track dirty state across every field.
- [ ] **Step 2:** Implement the chosen behaviour — confirm-on-dismiss **or** save-then-close —
      and cover **all** dismissal paths: the close button, **Esc**, **click-outside**, and
      scroll-dismiss if the implementation allows it.
- [ ] **Step 3:** Document the choice in the component's header comment and in `docs/tasks.md`.

**Verification:**
- [ ] Edit a field then press **Esc** → behaves as decided, edit is **not** silently lost.
- [ ] Edit a field then **click outside** → same.
- [ ] Edit a field then use the close button → same.
- [ ] Dismissing with **no** changes does not prompt (no false friction).

---

### Task 3: The card trigger + in-place refresh

Deliverable: the button on the card, without breaking bulk-select.

**Files:** modify `dashboard/components/library-view.tsx`

- [ ] **Step 1:** Add the edit trigger to the card.
- [ ] **Step 2:** **Apply the existing `closest('a')` guard pattern.** The card is a
      `div role=button` wrapping a link to `/library/[id]`; without the guard the new control
      toggles bulk-selection instead of opening the dialog. This is a previously-fixed trap in
      this exact file — do not re-introduce it.
- [ ] **Step 3:** On save, refresh the affected card **in place**. No full page reload.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Browser: clicking the trigger opens the dialog and does **not** toggle selection.
- [ ] **Regression — bulk-select still works** after the trigger is added: select 3 posts, bulk
      bar shows 3, existing bulk-schedule still functions.
- [ ] Clicking the card title still navigates to `/library/[id]` (the original `closest('a')`
      behaviour).
- [ ] Save updates the card without a reload; the "showing N of M" count and active filters are
      preserved.

---

## Final verification (whole branch)

- [ ] `npm test` and `npx tsc --noEmit` both clean.
- [ ] Worker suite still green (`worker/tests`) — untouched.
- [ ] The full `/library/[id]` editor still works unchanged (it shares the same route).
- [ ] Live DB: `PRAGMA foreign_key_check` empty.
- [ ] `/code-review` per the project's standing workflow.
- [ ] Mark the item done in `docs/tasks.md` and record the dirty-state decision there.
