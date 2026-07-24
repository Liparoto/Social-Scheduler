# Design — Queue control (manage sends before they post)

**Status:** approved 2026-07-23, ready for implementation planning
**Depends on:** the publications state machine, the Overview queue (`PublicationActions` /
`PublicationQueue`), the post editor (`/library/[id]`), and the existing schedule route
(`POST /api/posts/[id]/schedule`) — all shipped. Builds on **Cancel** (`dc5dd40`), already done.
**Feeds:** confidence — you can fully manage a send after it's scheduled (hold, reschedule,
retarget, delete) instead of only being able to create and approve it.

---

## 1. Purpose

Once a post is scheduled there was almost no way to manage it: no cancel (just added), no
hold, no reschedule, no retarget, no delete. For a self-hosted tool where **the worker fires
sends at their scheduled time whenever it's running** (there is no Meta-side scheduling — see
`reference.md`), the owner needs real control over the queue between "scheduled" and "posted".

This sub-project adds the missing controls, with one guiding safety rule from the owner:
**never destroy the record of something already posted to Instagram.** Deletes are blocked on
posted/publishing content; the IG post stays live regardless (we can't and don't un-publish).

Placement (owner's call): **per-send actions on the Overview queue rows**; **post-level actions
in the post editor**.

---

## 2. The one schema change — migration `0007_queue_control.sql`

```sql
ALTER TABLE publications ADD COLUMN is_held INTEGER NOT NULL DEFAULT 0; -- 1 = paused, worker skips it
```

Additive. Everything else reuses existing columns. `is_held` is a **modifier** on a scheduled
send, not a new status — this avoids rewriting the `status` CHECK constraint (SQLite can't ALTER
a CHECK) and keeps `scheduled_at` intact so Resume needs no recomputation.

The worker's due-query gains one clause so held sends are simply never picked up:
`worker/db.py fetch_due_publications` → add `AND is_held = 0` to the WHERE. (Same mechanism that
already makes `canceled` and `pending_approval` invisible to the worker.)

---

## 3. The controls

State vocabulary (existing): a publication is `scheduled | pending_approval | publishing |
posted | failed | canceled`. "Not yet sent" = `scheduled | pending_approval`. "Terminal-but-not-
live" = `canceled | failed`. "Live" = `posted` (or mid-flight `publishing`).

### ① Hold / Resume — Overview + editor
- **Hold** sets `is_held = 1` on a `scheduled | pending_approval` send (409 otherwise). The row
  shows a **"Held"** chip and stops counting down.
- **Resume** sets `is_held = 0`. `scheduled_at` is untouched, so it re-enters the queue at its
  original time (fires immediately if that time has passed — expected).
- Routes: `POST /api/publications/[id]/hold`, `POST /api/publications/[id]/resume`.

### ② Reschedule time — Overview + editor
- Inline **date + time** editor on a `scheduled | pending_approval` send. Entered in the
  **channel's** timezone; the server looks up the channel tz and converts to UTC via the existing
  `intervalSlots(date, time, 1, 1, channel.timezone)[0]` (which wraps `zonedTimeToUtc`).
- Updates `scheduled_at` and clears `next_retry_at` (so it's due exactly at the new time); guarded
  to non-posted sends (409 otherwise). A past time is **allowed** but the UI warns "this will send
  on the next worker run."
- Route: `POST /api/publications/[id]/reschedule` `{ date, time }`.

### ③ Delete — protect posted
- **Delete a send:** hard `DELETE FROM publications WHERE id AND status IN ('scheduled',
  'pending_approval','canceled','failed')` → 409 if `posted`/`publishing`. This is the *hard*
  sibling of Cancel: Cancel keeps a `canceled` record (audit), Delete clears clutter/mistakes.
  Route: `DELETE /api/publications/[id]`.
- **Delete a post** (post editor): blocked if the post has ANY publication in
  `('posted','publishing')` → 409 with a clear message (the IG post is still live; its metrics
  would be lost). Otherwise deletes the post row; FK `ON DELETE CASCADE` removes its publications,
  `post_assets`, `caption_variants`, `post_tags`, `post_periods`. **Assets are never deleted**
  (content-hash-shared; an asset may back other posts). Route: `DELETE /api/posts/[id]`.

### ④ Retarget channels — post editor
A "send" is one publication row per (post, channel, time), so retargeting = manage the set of the
post's sends. The editor gains a **"Scheduled sends"** panel:
- Lists each **non-posted** send: channel · local time (its channel tz) · status/held.
- Per-send: **Reschedule**, **Hold/Resume**, **Remove** (Cancel or Delete).
- **Add a send** to another channel: reuses the existing `POST /api/posts/[id]/schedule`
  (`{ channel_ids, date, time }`) — the same picker Compose-from-library uses.
So "retarget to a different account" = Add the new channel's send + Remove the old one, in one
place. Posted sends are shown read-only for context (not editable).

New query: `getPostPublications(postId)` → each publication joined to its channel (name, tz,
platform) + `is_held`, ordered by `scheduled_at`.

---

## 4. UI placement & density

**Overview rows (`PublicationActions`)** — to keep rows legible, the common actions are inline and
the rest are behind a small **"More"** toggle:
- `scheduled` / `pending_approval`: **Hold** (or **Resume** if held) + **Cancel** inline;
  **Reschedule** + **Delete** under "More". (`pending_approval` also keeps **Approve**.)
- `failed`: **Retry** (existing) + **Delete** under "More".
- `posted` (non-dry): **Refresh metrics** (existing) — no destructive actions.
- A **"Held"** chip renders next to the status when `is_held = 1`.

**Post editor (`/library/[id]`)** — the **"Scheduled sends"** panel (③④ above) + a **Delete post**
control (guarded, two-click / typed confirm). Destructive confirms follow the Cancel pattern
(two-click), and Delete-post spells out the cascade.

---

## 5. Endpoints summary

| Route | Method | Guard |
|---|---|---|
| `/api/publications/[id]/hold` | POST | status ∈ {scheduled, pending_approval}, not held |
| `/api/publications/[id]/resume` | POST | status ∈ {scheduled, pending_approval}, held |
| `/api/publications/[id]/reschedule` | POST | status ∈ {scheduled, pending_approval} |
| `/api/publications/[id]` | DELETE | status ∈ {scheduled, pending_approval, canceled, failed} |
| `/api/posts/[id]` | DELETE | no publication in {posted, publishing} |
| `/api/posts/[id]/schedule` | POST | *(existing — reused for retarget-add)* |

All routes return `{ ok: true }` or `NextResponse.json({ error }, { status })` with 404 (missing)
/ 409 (wrong state), matching the existing approve/retry/cancel routes.

---

## 6. Out of scope / deferred

- **Bulk queue ops** (cancel/hold/delete many at once) — single-row for now.
- **Editing a send's content** mid-queue — already covered: caption/tags are read live at publish
  from the post, editable in the post editor.
- **Un-publish / delete from Instagram** — impossible via our flow and never attempted; deletes
  are local-record-only and blocked on posted content anyway.
- **Facebook Pages / Reels** — Phase 6; Pages *does* support native scheduling, revisit then.

---

## 7. What good looks like

- A scheduled send can be **held** (stops firing, keeps its time) and **resumed**; the worker
  provably skips held rows.
- A scheduled send can be **rescheduled** to a new time in its channel's tz; it then fires at the
  new time.
- A **send** can be deleted (non-posted only); a **post** can be deleted only when nothing of it is
  live, cascading its own rows but never its shared assets.
- From the post editor you can **add a send to another channel and remove one** — retargeting —
  reusing the schedule endpoint.
- Every guard returns a clear 409 instead of corrupting state or racing the worker; posted content
  is never destroyable.
