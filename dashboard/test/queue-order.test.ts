/**
 * The order of the Overview queue.
 *
 * Status comes first (what needs you, then what is coming, then what is done), and within
 * a status the queue reads chronologically. The subtlety is which clock: a posted send is
 * placed by when it ACTUALLY went out, everything else by when it is due. Sorting posted
 * rows by scheduled_at put a send that slipped overnight back among the posts it was
 * planned beside rather than the ones it actually landed among — the same lie the WHEN
 * column used to tell (see lib/send-time).
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

test("a posted send is placed by when it went out, not when it was due", () => {
  // The decisive pair. "slipped" was due FIRST but did not go out until the next morning,
  // so it belongs AFTER "punctual", which was due later and went out on time.
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
    seen.indexOf("punctual") < seen.indexOf("slipped"),
    `expected punctual before slipped, got ${JSON.stringify(seen)}`
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
