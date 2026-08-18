import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";
import { rebaseWallClock } from "./time.ts";

// See queries.merge.test.ts: node --test gives each FILE its own process, but lib/db.ts
// memoises its connection, so every setup() in this file shares the first temp DB. Hence
// the per-setup prefix to keep fixtures from colliding.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  return { q, db, prefix: `t${++setupSeq}` };
}

test("create, list, get and update a channel group", async () => {
  const { q, prefix } = await setup();
  const id = q.createChannelGroup({ name: `${prefix}-Personal`, timezone: "America/New_York" });

  const got = q.getChannelGroup(id);
  assert.equal(got?.name, `${prefix}-Personal`);
  assert.equal(got?.timezone, "America/New_York");
  assert.equal(got?.autofill_enabled, 0);
  assert.equal(got?.reuse_min_age_days, 180);

  q.updateChannelGroup(id, {
    autofill_enabled: 1,
    cadence_config: JSON.stringify({ days: ["mon", "thu"], time: "18:00" }),
    min_queue_depth: 3,
    target_queue_depth: 5,
  });
  const after = q.getChannelGroup(id);
  assert.equal(after?.autofill_enabled, 1);
  assert.equal(after?.min_queue_depth, 3);
  assert.ok(q.listChannelGroups().some((g) => g.id === id));
});

test("assigning and clearing a channel's group", async () => {
  const { q, prefix } = await setup();
  const gid = q.createChannelGroup({ name: `${prefix}-G`, timezone: "UTC" });
  const cid = q.createChannel({
    platform: "instagram",
    account_name: `${prefix}-ig`,
    timezone: "UTC",
  } as Parameters<typeof q.createChannel>[0]);

  q.setChannelGroup(cid, gid);
  assert.equal(q.getChannel(cid)?.group_id, gid);
  assert.deepEqual(q.getGroupMembers(gid).map((c) => c.id), [cid]);

  q.setChannelGroup(cid, null);
  assert.equal(q.getChannel(cid)?.group_id, null);
  assert.deepEqual(q.getGroupMembers(gid), []);
});

test("deleting a group ungroups its channels and keeps their publications", async () => {
  const { q, db, prefix } = await setup();
  const gid = q.createChannelGroup({ name: `${prefix}-Doomed`, timezone: "UTC" });
  const cid = q.createChannel({
    platform: "instagram",
    account_name: `${prefix}-ig`,
    timezone: "UTC",
  } as Parameters<typeof q.createChannel>[0]);
  q.setChannelGroup(cid, gid);

  const assetId = Number(
    db
      .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)")
      .run(`${prefix}-hash`, `a/${prefix}.jpg`).lastInsertRowid
  );
  const postId = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [assetId] });
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)"
  ).run(postId, cid, "2026-08-01T18:00:00.000Z");

  assert.equal(q.deleteChannelGroup(gid), true);
  assert.equal(q.getChannelGroup(gid), undefined);
  assert.equal(q.getChannel(cid)?.group_id, null);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE channel_id = ?").get(cid) as { n: number }).n,
    1
  );
  assert.equal(q.deleteChannelGroup(gid), false, "second delete reports not found");
});

test("changing a group's timezone rebases every member's pending sends", async () => {
  const { q, db, prefix } = await setup();
  const gid = q.createChannelGroup({ name: `${prefix}-TZ`, timezone: "America/New_York" });
  const a = q.createChannel({
    platform: "instagram", account_name: `${prefix}-a`, timezone: "America/New_York",
  } as Parameters<typeof q.createChannel>[0]);
  const b = q.createChannel({
    platform: "threads", account_name: `${prefix}-b`, timezone: "America/New_York",
  } as Parameters<typeof q.createChannel>[0]);
  q.setChannelGroup(a, gid);
  q.setChannelGroup(b, gid);

  const assetId = Number(
    db
      .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)")
      .run(`${prefix}-hash`, `a/${prefix}.jpg`).lastInsertRowid
  );
  const postId = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [assetId] });
  // 18:00 America/New_York on 2026-08-01 == 22:00Z
  for (const cid of [a, b]) {
    db.prepare(
      "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?,?,?, 'scheduled')"
    ).run(postId, cid, "2026-08-01T22:00:00.000Z");
  }

  const { moved } = q.changeChannelGroupTimezone(gid, "America/New_York", "America/Los_Angeles", rebaseWallClock);

  assert.equal(moved, 2, "both members' sends move");
  assert.equal(q.getChannelGroup(gid)?.timezone, "America/Los_Angeles");
  const rows = db
    .prepare("SELECT scheduled_at FROM publications WHERE channel_id IN (?,?) ORDER BY id")
    .all(a, b) as { scheduled_at: string }[];
  // 18:00 Los Angeles on 2026-08-01 == 01:00Z the next day.
  assert.equal(rows[0].scheduled_at, "2026-08-02T01:00:00+00:00");
  assert.equal(rows[1].scheduled_at, rows[0].scheduled_at, "members stay in lockstep");
});
