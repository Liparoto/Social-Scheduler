/**
 * "Try again now": cancelling a retry backoff so a waiting send goes on the next poll.
 *
 * The safety property is narrow and worth stating exactly, because "force publish" sounds
 * far more dangerous than what this does. Every row the route can act on is a row the
 * worker had ALREADY committed to retrying by itself — `status = 'scheduled'` with a
 * `next_retry_at` it set on the way out of a failed attempt. Clearing that timestamp
 * changes WHEN the retry happens, never WHETHER it happens. It creates no new posting
 * opportunity, so it cannot create a double-post that the automatic retry would not.
 *
 * That argument only holds while the guards do, which is what these tests pin down: a
 * 'publishing' row (in flight, or orphaned by a restart and possibly already live) is
 * never touchable from here, and neither is a hold, a finished send, or a row with no
 * pending retry at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const db = (await import("../lib/db.ts")).getDb();

const { POST: SEND_NOW } = await import(
  "../app/api/publications/[id]/send-now/route.ts"
);

const PAST = "2026-08-12T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const SCHEDULED_AT = "2026-08-12T12:00:00.000Z";

let seq = 0;

function makePublication({
  status = "scheduled",
  nextRetryAt = FUTURE,
  isHeld = 0,
  attemptCount = 2,
}: {
  status?: string;
  nextRetryAt?: string | null;
  isHeld?: number;
  attemptCount?: number;
} = {}): number {
  seq += 1;
  const postId = (
    db
      .prepare(
        `INSERT INTO posts (caption, post_type) VALUES (?, 'single') RETURNING id`
      )
      .get(`send-now-${seq}`) as { id: number }
  ).id;
  const channelId = (
    db
      .prepare(
        `INSERT INTO channels (platform, account_name, remote_account_id, access_token)
         VALUES ('instagram', 'Send Now Test', 'IG1', 'tok') RETURNING id`
      )
      .get() as { id: number }
  ).id;
  return (
    db
      .prepare(
        `INSERT INTO publications
           (post_id, channel_id, scheduled_at, status, next_retry_at, is_held,
            attempt_count, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'publish: boom') RETURNING id`
      )
      .get(postId, channelId, SCHEDULED_AT, status, nextRetryAt, isHeld, attemptCount) as {
      id: number;
    }
  ).id;
}

function row(id: number) {
  return db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as {
    status: string;
    next_retry_at: string | null;
    attempt_count: number;
    scheduled_at: string;
    is_held: number;
    last_error: string | null;
  };
}

async function sendNow(id: number) {
  return SEND_NOW(new Request("http://localhost", { method: "POST" }), {
    params: Promise.resolve({ id: String(id) }),
  });
}

// ---- the one case it exists for -------------------------------------------------------
test("a send waiting out a backoff is released for the next poll", async () => {
  const id = makePublication({ nextRetryAt: FUTURE });

  const res = await sendNow(id);

  assert.equal(res.status, 200);
  assert.equal(row(id).next_retry_at, null);
});

test("releasing it changes nothing else about the send", async () => {
  // Specifically NOT attempt_count. Resetting it would restart the backoff ladder and put
  // max_attempts out of reach, so repeated clicking could keep a doomed send alive forever
  // instead of letting it come to rest in 'failed'. The count is also simply true, and the
  // queue displays it.
  const id = makePublication({ attemptCount: 3 });

  await sendNow(id);

  const r = row(id);
  assert.equal(r.attempt_count, 3);
  assert.equal(r.status, "scheduled");
  assert.equal(r.scheduled_at, SCHEDULED_AT);
  assert.equal(r.last_error, "publish: boom", "the reason it failed is still on the row");
});

test("a retry whose time has already passed can still be released", async () => {
  // Harmless and avoids a dead button during the ≤30s window between the timer expiring
  // and the worker's next poll: the row is due either way, this just says so.
  const id = makePublication({ nextRetryAt: PAST });

  assert.equal((await sendNow(id)).status, 200);
  assert.equal(row(id).next_retry_at, null);
});

// ---- the guards ----------------------------------------------------------------------
test("a send the worker is mid-flight with cannot be forced", async () => {
  // The decisive one. 'publishing' is either genuinely in flight or orphaned by a restart
  // and possibly already live on the platform — forcing either is how you post twice.
  const id = makePublication({ status: "publishing" });

  const res = await sendNow(id);

  assert.equal(res.status, 409);
  assert.equal(row(id).status, "publishing");
  assert.equal(row(id).next_retry_at, FUTURE);
});

test("a held send stays held", async () => {
  // A hold is a person saying stop. One button must not override it.
  const id = makePublication({ isHeld: 1 });

  assert.equal((await sendNow(id)).status, 409);
  assert.equal(row(id).next_retry_at, FUTURE);
});

test("a send with no pending retry is refused rather than silently doing nothing", async () => {
  // Nothing to release. A 200 here would report success for a click that changed nothing.
  const id = makePublication({ nextRetryAt: null });

  assert.equal((await sendNow(id)).status, 409);
});

test("a failed send is refused — Retry owns that path", async () => {
  const id = makePublication({ status: "failed", nextRetryAt: null });
  assert.equal((await sendNow(id)).status, 409);
});

test("an already-posted send cannot be forced", async () => {
  const id = makePublication({ status: "posted" });

  assert.equal((await sendNow(id)).status, 409);
  assert.equal(row(id).status, "posted");
});

test("a canceled send cannot be forced", async () => {
  const id = makePublication({ status: "canceled" });
  assert.equal((await sendNow(id)).status, 409);
});

test("an unknown publication is a 409, not a crash", async () => {
  assert.equal((await sendNow(999999)).status, 409);
});

test("a non-numeric id is a 409, not a crash", async () => {
  const res = await SEND_NOW(new Request("http://localhost", { method: "POST" }), {
    params: Promise.resolve({ id: "not-a-number" }),
  });
  assert.equal(res.status, 409);
});
