/**
 * The order of the Overview queue.
 *
 * Status ranks first: what needs you, then what is coming, then what is done. Within a
 * rank the queue reads chronologically, and BOTH the clock and the direction depend on
 * which rank it is:
 *
 *   - Upcoming work (failed, publishing, scheduled) runs FORWARD from now — the next
 *     thing to happen is the thing you care about, so soonest first.
 *   - Finished work runs BACKWARD from now — history is read newest first, and the most
 *     recent post is the one you want without scrolling past a month of older ones.
 *
 * And the clock: a posted send is placed by when it ACTUALLY went out, everything else by
 * when it is due. Sorting posted rows by scheduled_at put a send that slipped overnight
 * back among the posts it was planned beside rather than the ones it actually landed
 * among — the same lie the WHEN column used to tell (see lib/send-time).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();

const channelId = (
  db
    .prepare(
      `INSERT INTO channels (platform, account_name, remote_account_id, access_token)
       VALUES ('instagram', 'Order Test', 'IG1', 'tok') RETURNING id`
    )
    .get() as { id: number }
).id;

/** Returns the publication id, and labels the post so assertions read plainly. */
function send({
  label,
  status = "posted",
  scheduledAt,
  publishedAt = null,
  surface = "feed",
  postId,
}: {
  label: string;
  status?: string;
  scheduledAt: string;
  publishedAt?: string | null;
  surface?: string;
  postId?: number;
}): number {
  const pid =
    postId ??
    (
      db
        .prepare(`INSERT INTO posts (caption, post_type) VALUES (?, 'single') RETURNING id`)
        .get(label) as { id: number }
    ).id;
  return (
    db
      .prepare(
        `INSERT INTO publications
           (post_id, channel_id, scheduled_at, status, published_at, surface)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(pid, channelId, scheduledAt, status, publishedAt, surface) as { id: number }
  ).id;
}

/** Captions in queue order — the thing a human actually reads down the page. */
function order(): string[] {
  return q.getPublicationsOverview().map((r) => r.post_caption ?? "");
}

test("posted sends read newest first, by when they actually went out", () => {
  // The decisive pair, and it pins down BOTH rules at once. "slipped" was due first but
  // did not go out until the next afternoon, so it is the more RECENT post and leads.
  // Sorting by scheduled_at — in either direction — cannot produce this order:
  //   published_at DESC -> slipped (Aug 12 14:20), punctual (Aug 12 01:00)  <- wanted
  //   scheduled_at DESC -> punctual (Aug 12 01:00), slipped (Aug 11 19:30)
  send({
    label: "slipped",
    scheduledAt: "2026-08-11T19:30:00+00:00",
    publishedAt: "2026-08-12T14:20:08+00:00",
  });
  send({
    label: "punctual",
    scheduledAt: "2026-08-12T01:00:00+00:00",
    publishedAt: "2026-08-12T01:00:11+00:00",
  });

  const seen = order();
  assert.ok(
    seen.indexOf("slipped") < seen.indexOf("punctual"),
    `expected slipped (posted later) first, got ${JSON.stringify(seen)}`
  );
});

test("an older post sits below a newer one", () => {
  // The plain reading of "newest first", independent of any delay.
  send({
    label: "last-month",
    scheduledAt: "2026-07-01T12:00:00+00:00",
    publishedAt: "2026-07-01T12:00:05+00:00",
  });

  const seen = order();
  assert.ok(
    seen.indexOf("slipped") < seen.indexOf("last-month"),
    `expected August above July, got ${JSON.stringify(seen)}`
  );
});

test("work that needs attention still comes before work that is done", () => {
  // Sorting by a different clock must not disturb the status grouping. The failed row is
  // deliberately given the OLDEST times, so only the status rank can put it first.
  send({ label: "broken", status: "failed", scheduledAt: "2026-01-01T00:00:00+00:00" });
  send({ label: "upcoming", status: "scheduled", scheduledAt: "2026-12-31T00:00:00+00:00" });

  const seen = order();
  assert.ok(seen.indexOf("broken") < seen.indexOf("upcoming"), "failed before scheduled");
  assert.ok(seen.indexOf("upcoming") < seen.indexOf("punctual"), "scheduled before posted");
});

test("a send that has not gone out is still placed by when it is due", () => {
  // published_at is NULL for these, so the fallback has to hold or the whole upcoming
  // section loses its order.
  send({ label: "due-later", status: "scheduled", scheduledAt: "2026-12-30T00:00:00+00:00" });
  send({ label: "due-sooner", status: "scheduled", scheduledAt: "2026-12-29T00:00:00+00:00" });

  const seen = order();
  assert.ok(seen.indexOf("due-sooner") < seen.indexOf("due-later"));
});

test("a send awaiting approval sorts with live work, above the queue", () => {
  // It used to land in the ORDER BY's ELSE branch and sort down among posted sends —
  // invisible only because no channel here requires approval. Nothing goes out until a
  // human acts on it, so it belongs at the top, not filed under Done.
  send({
    label: "needs-approval",
    status: "pending_approval",
    scheduledAt: "2027-06-01T12:00:00+00:00", // far future: only the rank can lift it
  });

  const seen = order();
  assert.ok(
    seen.indexOf("needs-approval") < seen.indexOf("due-sooner"),
    `expected approval above scheduled work, got ${JSON.stringify(seen.slice(0, 6))}`
  );
  assert.ok(
    seen.indexOf("needs-approval") < seen.indexOf("slipped"),
    "and well above the posted block"
  );
});

test("a canceled send reads newest first too — it is finished work, not upcoming", () => {
  // Cancel is reachable from the queue, so these rows are real. They share the 'done'
  // rank with posted sends, and reversing only half a rank would interleave two
  // directions into one block that reads as neither.
  send({ label: "scrapped-jan", status: "canceled", scheduledAt: "2026-01-05T12:00:00+00:00" });
  send({ label: "scrapped-jun", status: "canceled", scheduledAt: "2026-06-05T12:00:00+00:00" });

  const seen = order();
  assert.ok(
    seen.indexOf("scrapped-jun") < seen.indexOf("scrapped-jan"),
    `expected June above January, got ${JSON.stringify(seen)}`
  );
});

test("the slides of one Story keep slide order when their times tie", () => {
  // Slides of a fan-out share a scheduled_at, and when they publish in one worker cycle
  // they share a published_at too. With both keys tied, only the id tie-break keeps them
  // in slide order — without it the order is whatever the query plan happens to produce.
  const pid = (
    db
      .prepare(`INSERT INTO posts (caption, post_type) VALUES ('story-post', 'story') RETURNING id`)
      .get() as { id: number }
  ).id;
  const ids = [1, 2, 3].map(() =>
    send({
      label: "story-post",
      scheduledAt: "2026-09-01T10:00:00+00:00",
      publishedAt: "2026-09-01T10:00:05+00:00",
      surface: "story",
      postId: pid,
    })
  );

  const slideIds = q
    .getPublicationsOverview()
    .filter((r) => r.post_id === pid)
    .map((r) => r.id);

  assert.deepEqual(slideIds, ids, "slides must stay in ascending id (slide) order");
});
