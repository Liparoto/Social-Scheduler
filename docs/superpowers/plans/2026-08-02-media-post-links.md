# Media Page → Post Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Design:** `docs/superpowers/specs/2026-08-02-media-post-links-design.md`

**Goal:** From the Media page, reach **every** post an asset belongs to, and recognise each one
without opening it.

**Architecture:** Widen one query from `MIN(post_id)` to the full post set, and render each as a
link. **Read-path only. No migration, no new dependency, no worker change, no change to
deletion.**

**Tech Stack:** Next.js 16 App Router, TypeScript, React 19, better-sqlite3.

## Global Constraints

- **Branch:** `media-post-links`. Do not commit to `main`.
- **⚠️ Commit current working state first** — `docs/tasks.md` is modified.
- **No new dependencies**, **no migration**, **no change under `worker/`**.
- **Do not touch the delete path.** `post_assets.asset_id` is `ON DELETE RESTRICT` and
  `deleteAsset()` carries a `NOT EXISTS` guard on the DELETE itself. This is a read-path change;
  deletion behaviour must be provably unchanged.
- **Keep `post_count`** — the header summary and the used/unused branch depend on it.
- The dashboard has a test runner: `npm test` → `node --test` over `lib/*.test.ts`.
- Dev server runs on **port 3939**.
- Every task ends with a commit, message ending
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `dashboard/lib/queries.ts` (modify) | `listAssetsWithUsage()` returns all posts per asset |
| `dashboard/components/media-manager.tsx` (modify) | Link every post, with a readable label |

---

### Task 1: Return every post per asset

Deliverable: the query carries the full `(post_id, caption, status)` set. UI not yet changed.

**Files:** modify `dashboard/lib/queries.ts`

- [ ] **Step 1:** Replace `MIN(pa.post_id) AS first_post_id` (and its `LEFT JOIN` for
      `first_post_status`) with the full set per asset. A second batched query over
      `post_assets` joined to `posts`, keyed by asset id and assembled in memory, keeps the main
      query readable.
- [ ] **Step 2:** **Keep `post_count`.** The header summary and the used/unused branch read it.
- [ ] **Step 3:** Update the `AssetWithUsage` interface. Note `first_post_id` /
      `first_post_status` are consumed by `media-manager.tsx` — update both together or the
      typecheck will catch it.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Against a scratch DB copy: an asset used by 2+ posts returns **all** of them; an unused
      asset returns an empty set with `post_count = 0`.
- [ ] **Query count does not scale with asset count** — no N+1 across the store.

---

### Task 2: Link every post

Deliverable: every post is reachable and recognisable from the Media card.

**Files:** modify `dashboard/components/media-manager.tsx`

- [ ] **Step 1:** Replace the single link + unlinked `+N more` text at line ~140 with a link per
      post.
- [ ] **Step 2:** Label each with the caption's **first line**, truncated, rather than
      `post #47`. Keep the status in parentheses as it is now. Handle a null/empty caption by
      falling back to the id.
- [ ] **Step 3:** For heavily-reused assets, show the first few inline and put the rest behind an
      expander so the card stays readable.

**Verification:**
- [ ] `npx tsc --noEmit` clean.
- [ ] Browser: an asset used by **2+ posts links to all of them** — this is the dead end being
      fixed; verify by clicking through to a post that was previously only reachable as
      `+N more`.
- [ ] Each link lands on the right `/library/[id]`.
- [ ] A caption with newlines or very long text renders on one line without breaking layout.
- [ ] **Regression — deletion untouched:** an unused asset still shows `Unused` and still
      deletes; a used asset still shows **no** delete button.
- [ ] The header summary (`N items · N MB · N unused`) is unchanged.

---

## Final verification (whole branch)

- [ ] `npm test` and `npx tsc --noEmit` both clean.
- [ ] Worker suite still green (`worker/tests`) — untouched.
- [ ] Live DB: `PRAGMA foreign_key_check` empty; asset and `post_assets` row counts unchanged
      (this sub-project writes nothing).
- [ ] `/code-review` per the project's standing workflow.
- [ ] Mark the item done in `docs/tasks.md`.
