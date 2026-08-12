# "Try again now" — forcing a waiting send out

Date: 2026-08-12
Status: approved, ready to implement

## Problem

A send sat in the queue looking stuck. The status column read **Publishing** in alarm
red, under it the text "publish endpoint unavailable: Not posted — will be retried
automatically." Nothing moved for over ten minutes. The owner had no way to say
*go now*, and no way to tell whether the tool was waiting on purpose or had wedged.

## What actually happened (publication 39, 2026-08-12)

Reconstructed from `data/logs/worker.log` and the row itself, not from guesswork:

1. All afternoon, `cloudflared` could not resolve `api.trycloudflare.com` — the NordVPN
   Meshnet DNS problem. The worker retried every ~35s and wrote the reason to
   `last_error` on both due rows. Correct behaviour, visible failure.
2. 14:33:05 — DNS recovered, the tunnel came up, and the batch claimed both rows
   (`status = 'publishing'`). **The claim did not clear the stale `last_error`.**
3. 14:34:02 — publication 38 (Instagram) published.
4. 14:35:14 — **the worker restarted** while publication 39 (Threads) was mid-flight.
5. The new worker left row 39 at `'publishing'`. `fetch_due_publications` only selects
   `'scheduled'`, so nothing looked at it again; `recover_stale_claims` would not touch
   it for a full 30 minutes (`publish_claim_lease_seconds = 1800`).

So the row was neither retrying nor failed. It was in a silent 30-minute quarantine,
wearing a status badge from step 2 and an error message from step 1 — two different
moments, neither of them current. That is why it read as stuck: it *was* stuck, and
everything on screen was describing something else.

Confirmed before touching anything: the Threads API showed the post was never created,
so re-queueing it was safe. It published within a minute of being set back to
`'scheduled'`.

## Three states that look identical and are not

| What the row is doing | How it looks today | What it needs |
|---|---|---|
| Waiting out a retry backoff (60s → 120s → 240s → 480s) | `Blocked` + error text | **A button.** Nothing was posted; the worker is going to retry anyway. |
| Endpoint unavailable, retrying every cycle | `Blocked` + error text | Nothing. It is already retrying every ~30s; a button would be a lie. |
| Orphaned mid-send by a worker restart | `Publishing` + a stale error | **Fast recovery**, not a button. Forcing this blindly is how you double-post. |

## Design

### A. "Try again now" button

Shown only on rows where the worker has *explicitly deferred* a retry to a future time:
`status = 'scheduled'` and `next_retry_at` is set and still in the future.

The button clears `next_retry_at`. The next poll (≤30s) picks the row up through the
normal due-work path. It writes nothing else.

**The safety argument, stated plainly: the button changes _when_, never _whether_.**
Every row it can act on is a row the worker had already committed to retrying on its
own. Clicking it buys minutes, not a new posting opportunity. If forcing one of these
could double-post, then so could the automatic retry that was already scheduled — that
would be a pre-existing bug in the backoff path, not something this button introduces.

Guards in the `UPDATE`, all load-bearing:

- `status = 'scheduled'` — never `'publishing'` (mid-flight or orphaned), never
  `'posted'`, never `'failed'` (that has Retry already).
- `next_retry_at IS NOT NULL` — the button only exists to cancel a wait. A row without
  one is not waiting, and "success" on it would be theatre.
- `is_held = 0` — a hold is a human saying stop. Forcing past it would let one button
  override an explicit pause.
- **`attempt_count` is left alone.** Resetting it would restart the backoff ladder and
  push `max_attempts` (5) out of reach, so a person clicking repeatedly could keep a
  doomed send alive forever instead of letting it come to rest in `failed`. The attempt
  history is also just true, and the queue displays it.

Anything the guards reject returns 409 with a plain reason, matching the existing
`retry` route.

### B. Recover orphaned claims at worker startup, not 30 minutes later

`main()` takes an exclusive OS-level lock (`single_instance.acquire`) before any cycle
runs, and the kernel releases that lock when the holder dies however it dies. So on the
**first cycle of a fresh process**, a row sitting at `'publishing'` cannot belong to a
live worker — there is provably no other worker. It is abandoned, full stop.

On that first cycle only, recover every `'publishing'` row regardless of age. Later
cycles in the same process keep the existing 1800s lease, which still covers the case
where `run_once` throws mid-batch and the next cycle finds a row whose fate is genuinely
unknown.

**Still recovered to `failed`, never to `scheduled`.** The dangerous case is unchanged: a
worker that died *after* the platform accepted the post but *before* it could record the
result. That post is live and the row is the only thing that does not know. Re-queueing
it would publish it twice. It becomes a visible `failed` row carrying the existing
`STALE_CLAIM_ERROR` — "check the account before retrying" — and a human decides.

The gain is latency, not a change of policy: restart the worker and the orphan surfaces
in seconds with its Retry button, instead of looking stuck for half an hour.

### C. Clear `last_error` when a row is claimed

One line in `claim_publication`. A claimed row displaying the previous cycle's error is
what turned a normal in-flight send into something that looked broken. Nothing is lost:
if the attempt fails, `_mark_failure` writes a fresh error; if the worker dies,
recovery writes `STALE_CLAIM_ERROR`.

## Non-goals

- **No "publish early" for a not-yet-due send.** Reschedule already covers that.
- **No platform lookup from the dashboard** to auto-decide whether an orphan really
  posted. It would need per-platform "did this go out?" matching, and it fails toward
  false confidence exactly when it matters. The human check stays.
- **No schema migration.** Every field involved already exists.

## Testing

Worker (`worker/tests/`, pytest):
- First cycle recovers a `'publishing'` row of any age; a later cycle in the same
  process does not, until the lease expires.
- Recovery still lands on `failed` with `STALE_CLAIM_ERROR`, never `scheduled`.
- `claim_publication` clears `last_error`.

Dashboard (`dashboard/test/`, node:test):
- Forcing a backoff row clears `next_retry_at` and leaves `attempt_count`,
  `scheduled_at`, and `status` untouched.
- 409 for each rejected case: held, `publishing`, `posted`, `failed`, no
  `next_retry_at`, unknown id.

Manual: verify the button renders on a genuinely deferred row and that the row goes out
on the following poll.
