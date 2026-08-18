import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";
import { rebaseWallClock } from "./time.ts";

// See queries.merge.test.ts: node --test gives each FILE its own process, but lib/db.ts
// memoises its connection, so every setup() in this file shares the first temp DB. Hence
// the per-setup prefix to keep fixtures from colliding.
let setupSeq = 0;

async function setup(channelTz: string) {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `t${++setupSeq}`;

  const channelId = q.createChannel({
    platform: "instagram",
    account_name: `${prefix}-acct`,
    timezone: channelTz,
  } as Parameters<typeof q.createChannel>[0]);

  const assetId = Number(
    db
      .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)")
      .run(`${prefix}-hash`, `a/${prefix}.jpg`).lastInsertRowid
  );
  const postId = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [assetId] });

  /** Insert a publication with an explicit status/hold, returning its id. */
  const mkPub = (scheduledAt: string, status: string, isHeld = 0) =>
    Number(
      db
        .prepare(
          `INSERT INTO publications (post_id, channel_id, scheduled_at, status, is_held)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(postId, channelId, scheduledAt, status, isHeld).lastInsertRowid
    );

  const schedAt = (id: number) =>
    (db.prepare("SELECT scheduled_at FROM publications WHERE id = ?").get(id) as {
      scheduled_at: string;
    }).scheduled_at;

  return { q, db, channelId, mkPub, schedAt };
}

test("a pending send keeps its wall clock and moves its UTC instant", async () => {
  const { q, channelId, mkPub, schedAt } = await setup("UTC");
  // Reads as 09:00 UTC.
  const pub = mkPub("2026-08-02T09:00:00.000Z", "scheduled");

  const res = q.changeChannelTimezone(channelId, "UTC", "America/Chicago", rebaseWallClock);

  assert.equal(res.moved, 1);
  // Still 09:00, now in Chicago (CDT, UTC-5) => 14:00Z.
  assert.equal(schedAt(pub), "2026-08-02T14:00:00+00:00");
  assert.equal(q.getChannel(channelId)?.timezone, "America/Chicago");
});

test("history and in-flight sends are never touched", async () => {
  const { q, channelId, mkPub, schedAt } = await setup("UTC");
  const at = "2026-08-02T09:00:00.000Z";

  const scheduled = mkPub(at, "scheduled");
  const awaiting = mkPub(at, "pending_approval");
  const held = mkPub(at, "scheduled", 1);
  const posted = mkPub(at, "posted");
  const failed = mkPub(at, "failed");
  const canceled = mkPub(at, "canceled");
  const publishing = mkPub(at, "publishing");

  const res = q.changeChannelTimezone(channelId, "UTC", "America/Chicago", rebaseWallClock);

  // Moved: everything still waiting to go out, INCLUDING held (a pause, not a cancel).
  assert.equal(res.moved, 3);
  assert.equal(schedAt(scheduled), "2026-08-02T14:00:00+00:00");
  assert.equal(schedAt(awaiting), "2026-08-02T14:00:00+00:00");
  assert.equal(schedAt(held), "2026-08-02T14:00:00+00:00", "held sends are still pending");

  // Untouched: history stays honest, and the worker's in-flight row isn't yanked.
  assert.equal(schedAt(posted), at);
  assert.equal(schedAt(failed), at);
  assert.equal(schedAt(canceled), at);
  assert.equal(schedAt(publishing), at, "the worker already has this one");
});

test("a retry backoff survives the rebase", async () => {
  const { q, db, channelId, mkPub } = await setup("UTC");
  const pub = mkPub("2026-08-02T09:00:00.000Z", "scheduled");
  const backoff = "2026-08-02T09:05:00.000Z";
  db.prepare("UPDATE publications SET next_retry_at = ? WHERE id = ?").run(backoff, pub);

  q.changeChannelTimezone(channelId, "UTC", "America/Chicago", rebaseWallClock);

  // The worker gates on scheduled_at AND next_retry_at. Clearing the backoff here
  // would turn a timezone correction into an immediate re-attempt.
  const row = db.prepare("SELECT next_retry_at FROM publications WHERE id = ?").get(pub) as {
    next_retry_at: string;
  };
  assert.equal(row.next_retry_at, backoff);
});

test("re-selecting the same zone moves nothing", async () => {
  const { q, channelId, mkPub, schedAt } = await setup("America/Denver");
  const at = "2026-08-02T15:00:00.000Z";
  const pub = mkPub(at, "scheduled");

  const res = q.changeChannelTimezone(
    channelId,
    "America/Denver",
    "America/Denver",
    rebaseWallClock
  );

  assert.equal(res.moved, 0);
  assert.equal(schedAt(pub), at);
});

test("only this channel's sends move", async () => {
  const { q, db, channelId, mkPub, schedAt } = await setup("UTC");
  const other = q.createChannel({
    platform: "instagram",
    account_name: "bystander",
    timezone: "UTC",
  } as Parameters<typeof q.createChannel>[0]);

  const at = "2026-08-02T09:00:00.000Z";
  const mine = mkPub(at, "scheduled");
  const theirs = Number(
    db
      .prepare(
        `INSERT INTO publications (post_id, channel_id, scheduled_at, status)
         SELECT post_id, ?, ?, 'scheduled' FROM publications WHERE id = ?`
      )
      .run(other, at, mine).lastInsertRowid
  );

  q.changeChannelTimezone(channelId, "UTC", "America/Chicago", rebaseWallClock);

  assert.equal(schedAt(mine), "2026-08-02T14:00:00+00:00");
  assert.equal(schedAt(theirs), at, "a different channel is unaffected");
  assert.equal(q.getChannel(other)?.timezone, "UTC");
});
