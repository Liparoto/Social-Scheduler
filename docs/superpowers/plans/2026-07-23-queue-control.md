# Queue Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner fully manage a scheduled send before it posts — hold/resume, reschedule, delete (send and post), and retarget channels — without ever destroying posted content.

**Architecture:** One additive column (`publications.is_held`) + a one-clause worker change make Hold work; the rest reuses existing columns and the existing schedule route. New query helpers + thin API routes mirror the shipped approve/retry/cancel pattern. Per-send actions live on the Overview rows; post-level actions (retarget, delete-post) live in the post editor.

**Tech Stack:** Next.js (App Router, TS) + `better-sqlite3`; Python worker (pytest); `.sql` migrations.

## Global Constraints

- **Protect posted content:** deleting a *send* is blocked on `posted`/`publishing`; deleting a *post* is blocked if ANY of its publications is `posted`/`publishing`. Deletes are local-record-only — never attempt to un-publish from Instagram.
- **Worker↔dashboard talk ONLY via the shared SQLite DB** — no HTTP between them; no new dependency; local-only.
- **Migrations additive**, in `/migrations`, applied by `migrate.py`/launcher; back-compat for existing rows.
- **Guards are atomic against the worker:** every state-changing UPDATE/DELETE carries a `WHERE ... AND status IN (...)` clause so it no-ops (→ 409) if the worker already moved the row. Never race the worker.
- **Reuse, don't duplicate:** retarget-add reuses `POST /api/posts/[id]/schedule`; tz conversion reuses `intervalSlots`/`zonedTimeToUtc`; confirms follow the shipped two-click Cancel pattern.
- Dev server on **port 3939**; worker daemon running. Verify dashboard via endpoint/curl + in-browser (no JS unit runner); worker via `pytest`.

---

### Task 1: Migration `0007` + worker skips held sends

**Files:**
- Create: `migrations/0007_queue_control.sql`
- Modify: `worker/db.py` (`fetch_due_publications`)
- Test: `worker/tests/test_db.py` or wherever due-selection is tested (grep `fetch_due_publications`)

**Interfaces:**
- Produces: `publications.is_held INTEGER NOT NULL DEFAULT 0`; the worker excludes `is_held = 1`.

- [ ] **Step 1: Write the migration**

```sql
-- 0007_queue_control.sql
-- Hold/pause a scheduled send without canceling it: is_held=1 makes the worker skip the row
-- while preserving scheduled_at (Resume just clears it). A modifier on 'scheduled', not a new
-- status (avoids rewriting the status CHECK). Additive.
ALTER TABLE publications ADD COLUMN is_held INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Apply + verify**

Run: `worker/.venv/bin/python migrate.py` — expect `Applying 0007_queue_control.sql ... done.`
Run: `sqlite3 data/socialscheduler.db "SELECT id, is_held FROM publications;"` — existing rows show `|0`.

- [ ] **Step 3: Write the failing worker test** (in the file that tests `fetch_due_publications`)

A due `scheduled` publication with `is_held = 1` must NOT be returned; the same row with `is_held = 0` IS returned. Build the row via the existing test fixtures (grep how other due-selection tests insert a due publication) and set `is_held` accordingly.

- [ ] **Step 4: Run it, expect FAIL** — `worker/.venv/bin/python -m pytest worker/tests/ -k held -v` → held row still returned (no filter yet).

- [ ] **Step 5: Implement** — in `worker/db.py fetch_due_publications`, add `AND is_held = 0` to the WHERE:

```python
        WHERE status = 'scheduled'
          AND scheduled_at <= ?
          AND is_held = 0
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
```

- [ ] **Step 6: Run full suite** — `worker/.venv/bin/python -m pytest worker/tests/ -q` → all green (82 + new).

- [ ] **Step 7: Commit** — `git add migrations/0007_queue_control.sql worker/db.py worker/tests && git commit -m "feat(schema+worker): is_held so the worker skips paused sends (migration 0007)"`

---

### Task 2: Dashboard query layer + is_held surfacing

**Files:**
- Modify: `dashboard/lib/queries.ts` (new helpers + `is_held` in overview)
- Modify: `dashboard/lib/types.ts` (`PublicationRow` gains `is_held: number`)

**Interfaces (consumed by Tasks 3–6):**
- `deletePublication(id): boolean` — hard delete, guarded to `scheduled|pending_approval|canceled|failed`.
- `reschedulePublication(id, scheduledAtUtc): boolean` — sets `scheduled_at`, clears `next_retry_at`, guarded to `scheduled|pending_approval`.
- `holdPublication(id): boolean` / `resumePublication(id): boolean` — toggle `is_held`, guarded.
- `deletePost(id): "ok" | "not_found" | "has_live"` — blocked if any pub `posted|publishing`.
- `getPostPublications(postId): PostPublicationRow[]` — each pub + channel name/tz/platform + is_held, ordered by scheduled_at.
- `getPublicationsOverview` now selects `pub.is_held`.

- [ ] **Step 1:** Add `is_held: number` to `PublicationRow` in `types.ts`. Define `PostPublicationRow` (id, channel_id, channel_name, channel_platform, channel_timezone, scheduled_at, status, is_held, is_dry_run, remote_post_id).

- [ ] **Step 2:** In `getPublicationsOverview`, add `pub.is_held` to the SELECT (it uses `pub.*` — confirm is_held is included; if the SELECT lists columns explicitly, add it).

- [ ] **Step 3:** Add the write helpers, mirroring `cancelPublication`/`approvePublication` (guarded UPDATE/DELETE returning `info.changes > 0`):

```ts
export function deletePublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `DELETE FROM publications
       WHERE id = @id AND status IN ('scheduled','pending_approval','canceled','failed')`
    )
    .run({ id });
  return info.changes > 0;
}

export function reschedulePublication(id: number, scheduledAtUtc: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications SET scheduled_at = @at, next_retry_at = NULL, updated_at = @now
       WHERE id = @id AND status IN ('scheduled','pending_approval')`
    )
    .run({ id, at: scheduledAtUtc, now: nowIso() });
  return info.changes > 0;
}

export function holdPublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications SET is_held = 1, updated_at = @now
       WHERE id = @id AND is_held = 0 AND status IN ('scheduled','pending_approval')`
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}

export function resumePublication(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE publications SET is_held = 0, updated_at = @now
       WHERE id = @id AND is_held = 1 AND status IN ('scheduled','pending_approval')`
    )
    .run({ id, now: nowIso() });
  return info.changes > 0;
}
```

- [ ] **Step 4:** Add `deletePost` with the posted-guard, in a transaction:

```ts
export function deletePost(id: number): "ok" | "not_found" | "has_live" {
  const db = getDb();
  const post = db.prepare("SELECT id FROM posts WHERE id = ?").get(id);
  if (!post) return "not_found";
  const live = db
    .prepare("SELECT 1 FROM publications WHERE post_id = ? AND status IN ('posted','publishing') LIMIT 1")
    .get(id);
  if (live) return "has_live";
  // FK ON DELETE CASCADE removes publications/post_assets/caption_variants/post_tags/post_periods.
  // Assets are content-hash-shared and are NOT deleted here.
  db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  return "ok";
}
```

- [ ] **Step 5:** Add `getPostPublications(postId)` joining `publications` → `channels`:

```ts
export function getPostPublications(postId: number): PostPublicationRow[] {
  return getDb()
    .prepare(
      `SELECT pub.id, pub.channel_id, pub.scheduled_at, pub.status, pub.is_held,
              pub.is_dry_run, pub.remote_post_id,
              c.account_name AS channel_name, c.platform AS channel_platform,
              c.timezone AS channel_timezone
       FROM publications pub JOIN channels c ON c.id = pub.channel_id
       WHERE pub.post_id = ? ORDER BY pub.scheduled_at ASC`
    )
    .all(postId) as PostPublicationRow[];
}
```

- [ ] **Step 6: Verify** — `cd dashboard && npx tsc --noEmit` → 0. Confirm FK cascade actually deletes child rows: on the live DB (worker venv) inspect the `publications` / `post_assets` FKs already declare `ON DELETE CASCADE` (they do per `0001_init.sql`); no schema change needed. (Behavior is exercised end-to-end in Task 4's route verification.)

- [ ] **Step 7: Commit** — `git add dashboard/lib/queries.ts dashboard/lib/types.ts && git commit -m "feat(dashboard): queue-control query layer (delete/reschedule/hold/resume/delete-post) + is_held"`

---

### Task 3: Publication API routes (hold, resume, reschedule, delete-send)

**Files:**
- Create: `dashboard/app/api/publications/[id]/hold/route.ts`
- Create: `dashboard/app/api/publications/[id]/resume/route.ts`
- Create: `dashboard/app/api/publications/[id]/reschedule/route.ts`
- Create: `dashboard/app/api/publications/[id]/route.ts` (DELETE handler)

**Interfaces:** consumes Task 2 helpers + `getChannel`/`intervalSlots`.

- [ ] **Step 1:** `hold` and `resume` routes — mirror `approve/route.ts` exactly (`runtime="nodejs"`, `await params`, `Number(id)`, 409 on false). Messages: hold → "Only a scheduled or awaiting-approval send can be held."; resume → "This send isn't currently held.".

- [ ] **Step 2:** `reschedule/route.ts` — POST `{ date, time }`. Load the publication to get its `channel_id`, load the channel for its timezone, convert with `intervalSlots(date, time, 1, 1, channel.timezone)[0]`, call `reschedulePublication(id, utc)`. 400 if `date`/`time` missing or the channel is gone; 404 if the publication is missing; 409 if the helper returns false. Look at `app/api/posts/[id]/schedule/route.ts` for the exact `intervalSlots` usage and param handling. You will need a query to load a single publication's `channel_id`/`status` — add `getPublication(id)` to `queries.ts` if none exists (a plain `SELECT * FROM publications WHERE id = ?`), reusing it here.

- [ ] **Step 3:** `route.ts` DELETE handler — `export async function DELETE(_req, { params })`; `deletePublication(Number(id))`; 409 if false ("Only a not-yet-posted send can be deleted."). Same `runtime`/`params` conventions.

- [ ] **Step 4: Verify (curl against :3939, using a far-future test publication you INSERT then clean up):**
  - Insert a `scheduled` test pub (`created_by='qc-test'`, `scheduled_at` in 2027). 
  - `hold` → `{ok:true}`, DB `is_held=1`; `hold` again → 409; `resume` → `is_held=0`.
  - `reschedule` `{date,time}` → DB `scheduled_at` = the converted UTC (verify tz math against the channel tz); rescheduling a posted pub (id=1) → 409.
  - `DELETE` the test pub → row gone; `DELETE` posted id=1 → 409.
  - **Delete every test row you inserted**; report what you added/removed. Leave the DB as found.

- [ ] **Step 5: Commit** — `git add dashboard/app/api/publications dashboard/lib/queries.ts && git commit -m "feat(dashboard): publication routes — hold/resume/reschedule/delete send"`

---

### Task 4: Delete-post API route (guarded)

**Files:**
- Modify: `dashboard/app/api/posts/[id]/route.ts` — add a `DELETE` handler (if the file/route doesn't exist, create it; check first).

**Interfaces:** consumes `deletePost` (Task 2).

- [ ] **Step 1:** Add `DELETE`: `deletePost(Number(id))` → `"not_found"` → 404; `"has_live"` → 409 with "This post has sends already posted to Instagram — delete is blocked to protect their records (the Instagram post stays live)."; `"ok"` → `{ ok: true }`. `runtime="nodejs"`, `await params`.

- [ ] **Step 2: Verify (curl, with throwaway data you create + clean up):**
  - Create a draft post with no publications (`POST /api/posts/draft {asset_ids:[1], caption:"qc-del"}`) → DELETE it → 200, row gone, and confirm its `post_assets` rows are gone (cascade) while asset 1 still exists.
  - Create a draft + schedule it to a channel (`POST /api/posts/[id]/schedule`), then manually set that publication's status to `posted` via sqlite → DELETE the post → 409 has_live; reset/clean up.
  - **Clean up all throwaway posts/publications**; report exactly what you added/removed.

- [ ] **Step 3: Commit** — `git add dashboard/app/api/posts && git commit -m "feat(dashboard): delete a post (guarded — blocked when any send is live)"`

---

### Task 5: Overview row actions (Hold/Resume + Reschedule + Delete + Held chip)

**Files:**
- Modify: `dashboard/components/publication-actions.tsx`
- Modify: `dashboard/components/publication-queue.tsx` (pass `is_held`; render the Held chip)

**Interfaces:** consumes the Task 3 routes; `PublicationRow.is_held` (Task 2).

- [ ] **Step 1:** Extend `PublicationActions` (it already has `id`, `status`, `isDryRun`, `workerOnline`, and the shipped `Cancel` two-click control). Add an `isHeld?: boolean` prop. Add:
  - `scheduled`/`pending_approval`: inline **Hold** (or **Resume** when `isHeld`) + **Cancel**; a **"More"** toggle revealing **Reschedule** + **Delete**. `pending_approval` keeps **Approve** inline.
  - `failed`: keep **Retry**; add **Delete** under a "More" toggle.
  - **Reschedule** control: a small `date` + `time` input (prefilled from the row's local scheduled time) + Save → `POST /api/publications/[id]/reschedule {date,time}` → `router.refresh()`. Show a hint when the chosen datetime is in the past. Follow existing input styling.
  - **Delete** control: two-click confirm (reuse the Cancel pattern's shape) → `DELETE /api/publications/[id]`.
  - Hold/Resume: `POST .../hold` or `.../resume` → `router.refresh()`.
  Keep the "More" state local; default collapsed. Don't disturb the posted-row Refresh-metrics branch.

- [ ] **Step 2:** In `publication-queue.tsx`, pass `isHeld={p.is_held === 1}` to `PublicationActions`, and render a small **"Held"** chip next to the status badge when `p.is_held === 1` (use a muted token, e.g. `--color-status-draft`, matching the badge idiom in `ui.tsx`).

- [ ] **Step 3:** `cd dashboard && npx tsc --noEmit` → 0.

- [ ] **Step 4: Verify in browser (:3939)** — INSERT a far-future `scheduled` test pub (qc-test). On the Overview: Hold → row shows "Held" + button becomes Resume; Resume → back. Open "More" → Reschedule to a new date/time → the row's time updates (verify DB scheduled_at). "More" → Delete (two-click) → row disappears. Confirm a `posted` row shows no Cancel/Delete/Hold. **Clean up the test row(s).** Screenshot the scheduled-row actions for the summary.

- [ ] **Step 5: Commit** — `git add dashboard/components/publication-actions.tsx dashboard/components/publication-queue.tsx && git commit -m "feat(dashboard): Overview per-send controls — hold/resume, reschedule, delete + Held chip"`

---

### Task 6: Post-editor "Scheduled sends" panel + Delete post

**Files:**
- Create: `dashboard/components/post-sends-panel.tsx` (`"use client"`)
- Modify: `dashboard/components/post-editor.tsx` (mount the panel + a Delete-post control)
- Modify: `dashboard/app/library/[id]/page.tsx` (pass `getPostPublications(id)` to the editor)

**Interfaces:** consumes `getPostPublications` (Task 2), the Task 3 routes, `DELETE /api/posts/[id]` (Task 4), and `POST /api/posts/[id]/schedule` (existing).

- [ ] **Step 1:** `page.tsx` — call `getPostPublications(id)` and pass to `<PostEditor>`; thread into a new `sends` prop.

- [ ] **Step 2:** `<PostSendsPanel postId sends channels>`:
  - Lists each send: channel · local time (its `channel_timezone`, via `formatInTz`) · status (+ Held chip). Posted/publishing sends are read-only (context only).
  - Per non-posted send: **Reschedule** (date/time → `/reschedule`), **Hold/Resume**, **Remove** (two-click → `DELETE /api/publications/[id]`; offer Cancel-vs-Delete or default to Delete — keep it to Delete for simplicity here, Cancel lives on the Overview).
  - **Add a send:** channel picker + date/time → `POST /api/posts/[id]/schedule { channel_ids:[cid], date, time }` → `router.refresh()`. Reuse the shapes from `schedule-from-library.tsx` / `ScheduleFromLibrary` where practical.
  - All mutations → `router.refresh()`.
- [ ] **Step 3:** In `post-editor.tsx`, mount `<PostSendsPanel>` (a clearly-labeled section) and add a **Delete post** control at the bottom: two-click / typed confirm that spells out the cascade → `DELETE /api/posts/[id]`; on success redirect to `/library`. Surface the 409 has-live message inline.

- [ ] **Step 4:** `cd dashboard && npx tsc --noEmit` → 0.

- [ ] **Step 5: Verify in browser (:3939)** — on `/library/1` (or a throwaway post): the panel lists the post's sends; Add a send to a channel → appears; Reschedule/Hold/Remove a non-posted send works (verify DB); a post WITH a posted send shows Delete-post blocked (409 message); a throwaway post with no live sends deletes and redirects. **Clean up throwaway data.** Screenshot the panel.

- [ ] **Step 6: Commit** — `git add dashboard/components/post-sends-panel.tsx dashboard/components/post-editor.tsx dashboard/app/library && git commit -m "feat(dashboard): post-editor scheduled-sends panel (retarget) + guarded delete post"`

---

### Task 7: Docs + memory

- [ ] **Step 1:** Update `docs/tasks.md` — add a "Queue control" section marked done (hold/reschedule/delete/retarget + the earlier Cancel), with verification notes.
- [ ] **Step 2:** Add/update memory: a `queue-control.md` project memory (the publications state machine + is_held + guards + which controls live where) and the MEMORY.md index line. Link `[[metrics-refresh-needs-worker]]` (worker-must-run) and `[[image-conformance]]` neighborhood.
- [ ] **Step 3: Commit** — `docs: queue control shipped — tasks.md + memory`.

---

## Self-Review notes

- **Spec coverage:** is_held+worker (T1) ↔ §2/①; query layer (T2) ↔ §3/§5; publication routes (T3) + post-delete (T4) ↔ §5; Overview UI (T5) ↔ §4; editor panel (T6) ↔ §3④/§4. Cancel already shipped (dc5dd40) — not re-done.
- **Guards:** every mutation carries `WHERE ... AND status IN (...)` (or the posted-check for delete-post) so it's atomic vs the worker and returns 409 rather than corrupting state — the plan's central correctness property.
- **Reuse:** retarget-add = existing `POST /posts/[id]/schedule`; tz = `intervalSlots`; confirms = shipped Cancel two-click. No new dependency, no HTTP worker↔dashboard.
- **Type consistency:** `is_held` is INTEGER (0/1) in DB/rows, surfaced as boolean (`is_held === 1`) only at the UI edge; helper names identical across T2 definitions and T3–T6 consumers.
