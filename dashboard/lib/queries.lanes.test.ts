import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  return { q, db, prefix: `t${++setupSeq}` };
}

function seedPost(
  db: ReturnType<typeof import("better-sqlite3")>,
  channelId: number,
  surface: string,
  band: string,
) {
  const postId = db
    .prepare("INSERT INTO posts (caption, post_type, content_status) VALUES ('x','single','ready')")
    .run().lastInsertRowid as number;
  db.prepare("INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,?)").run(
    postId,
    channelId,
    surface,
  );
  const tagId = (db.prepare("SELECT id FROM tags WHERE name = ? AND kind = 'time_of_day'").get(band) as { id: number }).id;
  db.prepare("INSERT INTO post_tags (post_id, tag_id) VALUES (?,?)").run(postId, tagId);
  return postId;
}

test("band counts are per surface, so a story lane is not warned about feed content", async () => {
  const { q, db } = await setup();
  const channelId = db
    .prepare("INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')")
    .run().lastInsertRowid as number;

  seedPost(db, channelId, "feed", "morning");
  seedPost(db, channelId, "feed", "morning");
  seedPost(db, channelId, "story", "evening");

  assert.deepEqual(q.getBandCounts([channelId], "feed"), { morning: 2 });
  assert.deepEqual(q.getBandCounts([channelId], "story"), { evening: 1 });
});

test("no channels means no counts, on any surface", async () => {
  const { q } = await setup();
  assert.deepEqual(q.getBandCounts([], "story"), {});
});

test("a group offers a story lane when any member can take a Story", async () => {
  const { anySupportsStory } = await import("./platforms.ts");
  assert.equal(anySupportsStory(["facebook", "instagram"]), true);
  assert.equal(anySupportsStory(["facebook", "telegram"]), false);
  assert.equal(anySupportsStory([]), false, "an empty group offers nothing");
  assert.equal(anySupportsStory(["not-a-platform"]), false, "unknown means no");
});

test("upsert creates a lane, then updates it in place", async () => {
  const { q, db } = await setup();
  const channelId = db
    .prepare("INSERT INTO channels (platform, account_name) VALUES ('instagram','IG')")
    .run().lastInsertRowid as number;
  const owner = { kind: "channel" as const, id: channelId };

  q.upsertAutofillLane(owner, "story", {
    enabled: 1,
    cadence_config: '{"days":["mon"],"time":"12:00"}',
    min_queue_depth: 2,
    target_queue_depth: 4,
    reuse_min_age_days: 30,
  });
  q.upsertAutofillLane(owner, "story", { target_queue_depth: 9 });

  const lanes = q.getAutofillLanes(owner);
  assert.equal(lanes.length, 1, "upsert must not create a second row for the same surface");
  assert.equal(lanes[0].surface, "story");
  assert.equal(lanes[0].target_queue_depth, 9);
  assert.equal(lanes[0].min_queue_depth, 2, "an omitted field is left alone");
  assert.equal(lanes[0].group_id, null);
});

test("feed and story lanes on one owner are independent rows", async () => {
  const { q, db } = await setup();
  const groupId = db
    .prepare("INSERT INTO channel_groups (name) VALUES ('G')")
    .run().lastInsertRowid as number;
  const owner = { kind: "group" as const, id: groupId };

  q.upsertAutofillLane(owner, "feed", { enabled: 1, target_queue_depth: 5 });
  q.upsertAutofillLane(owner, "story", { enabled: 1, target_queue_depth: 12 });

  const bySurface = Object.fromEntries(
    q.getAutofillLanes(owner).map((l) => [l.surface, l.target_queue_depth]),
  );
  assert.deepEqual(bySurface, { feed: 5, story: 12 });
});
