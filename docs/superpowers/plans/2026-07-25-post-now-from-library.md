# "Post now" for existing posts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the composer's "Post now" to the two places that schedule an **existing** post, so a post already in the library can be published immediately.

## Context

Post now shipped for new posts only (`POST /api/posts`, merged as `b2b1397`). It sets `scheduled_at` to the current instant, forces `status='scheduled'` — **bypassing the approval gate** — and the worker publishes on its next 30-second poll. `bulkCreatePublications` already accepts `skip_approval`; only the new-post route passes it today.

Three surfaces schedule an existing post:

| Surface | Route | In scope? |
|---|---|---|
| Composer → **From library** (`schedule-from-library.tsx`) | `POST /api/posts/{id}/schedule` | **Yes** — what the owner asked for |
| Post editor → **Add a send** (`post-sends-panel.tsx`) | same route | **Yes** — same route, same one-post shape |
| Library → **bulk schedule** (`library-view.tsx`) | `POST /api/posts/bulk` | **No** — see below |

**Why bulk is excluded:** bulk scheduling exists to *spread* posts over time (every N days at a time). "Post all of these now" would fire every selected post simultaneously into the same account and straight at the publish rate limit. If the owner wants it later it should be a deliberate design, not a checkbox inherited from this change.

## Design

Identical semantics to the shipped Post now, so there is one behaviour to learn, not two:
- `scheduled_at` = the current instant (UTC ISO, same format the scheduled path writes).
- Approval bypassed — `status='scheduled'`, never `pending_approval`.
- Publishing happens on the worker's next poll, **not instantly**.
- The same three silent preventers must be surfaced **before** the click: `DRY_RUN` on, the kill switch on, or the worker offline. `dashboard/lib/publish-readiness.ts` already provides these (read live from `.env`, matching how the worker re-reads them).
- `post_now` wins over a supplied date/time, matching the new-post route.

## Global Constraints

- **Never modify `data/socialscheduler.db`** beyond removing test rows you create; report before/after counts. Two live channels publish for real. WAL mode — a copy needs the `-wal`/`-shm` sidecars.
- **Never change `DRY_RUN` or `KILL_SWITCH`** — they stay `1` and `0`.
- **Deleting test rows must be done with foreign keys ON.** Python's `sqlite3` defaults them **off**, so a plain `DELETE FROM posts` leaves orphaned `caption_variants`/`post_targets` — that exact mistake corrupted this database once already and had to be repaired. Prefer deleting through the app's own API.
- The existing scheduled path must be unchanged, including still honouring `requires_approval`.
- No new dependencies, no schema changes.
- Checks: `cd dashboard && npx tsc --noEmit`; `node dashboard/scripts/smoke-post-now.mjs`; `.venv/bin/python -m pytest worker/tests -q` (324 passing).

---

### Task 1: `post_now` on the schedule route, and the two controls that use it

**Files:** Modify `dashboard/app/api/posts/[id]/schedule/route.ts`, `dashboard/components/schedule-from-library.tsx`, `dashboard/components/post-sends-panel.tsx`, and the server components that supply them (`dashboard/app/compose/page.tsx` already loads readiness for the composer; the post editor's page will need it too); create `dashboard/scripts/smoke-post-now-schedule.mjs`

- [ ] **Step 1: Write the smoke script first**

There is no JS unit runner here; the pattern is a Node script driving the real routes against a **scratch copy** of the database. **Read `dashboard/scripts/smoke-post-now.mjs` and follow it closely** — it covers the sibling route and already has the scratch-DB and server setup you need.

Cover, against `POST /api/posts/{id}/schedule`:
1. `post_now: true` with no date/time → **201**, publication is `status='scheduled'` (**not** `pending_approval`) for a channel with `requires_approval = 1`, and `scheduled_at` is at or before now.
2. Same for a channel without approval → `scheduled`.
3. **Regression guard:** a normal request with date + time and no `post_now` → unchanged, still `pending_approval` for an approval-required channel.
4. `post_now: true` **and** a date/time → `post_now` wins, matching the new-post route.
5. Validation parity — every check this route already enforces still applies under `post_now`: unknown channel, no channels selected, platform/post-type incompatibility, carousel size, caption limit. Post now must not become a hole around them.

- [ ] **Step 2: Run it; expect failures** (the route requires a date/time today).

- [ ] **Step 3: Implement the route change.** Mirror `dashboard/app/api/posts/route.ts`'s Post-now handling as closely as the two routes' shapes allow — same `body.post_now === true` strict check, same "post_now wins" comment, same `skip_approval` flag into `bulkCreatePublications`. Keep the scheduled path byte-identical.

- [ ] **Step 4: Add the control to both UIs.** In `schedule-from-library.tsx` and `post-sends-panel.tsx`, offer the same **Schedule / Post now** choice the composer has: when Post now is active, hide the date/time inputs and send `post_now: true`.

  Reuse the composer's readiness messaging rather than writing new copy — the same warnings must appear (dry-run on, kill switch on, worker offline, plus the note that approval is skipped), and they must render **all** applicable warnings, not just the first. If the composer's message block can be lifted into a small shared component without disturbing it, do that; if not, match its wording exactly and say why in your report. Both surfaces need `publish-readiness` passed in from their server components.

- [ ] **Step 5: Verify in the browser.** Dev server on port **3939** — reuse it.
  - Composer → **From library**: Post now off by default, the scheduled flow unchanged; turning it on hides date/time and shows the dry-run warning (`DRY_RUN=1` today, so it must appear).
  - Post editor → **Add a send**: the same.
  - Scheduling one post with Post now creates a publication that is `scheduled`, not `pending_approval`, and is immediately due.
  - **Then delete what you created through the app's own UI/API** (not raw SQL), and report the row counts before and after, including `PRAGMA foreign_key_check`.

  Save screenshots of both surfaces with Post now active and reference the paths in your report.

- [ ] **Step 6:** `npx tsc --noEmit` clean, both smoke scripts pass, worker suite still green. Commit.

---

## Definition of done

- Post now works from the composer's From-library tab and the post editor's Add-a-send, with identical semantics to the new-post path.
- Bulk scheduling is deliberately untouched.
- The scheduled path is unchanged and still honours `requires_approval`, pinned by a regression case.
- The same three preventers are surfaced before the click on both new surfaces.
- `tsc` clean; both smoke scripts pass; the real database left exactly as found, with `foreign_key_check` empty.
