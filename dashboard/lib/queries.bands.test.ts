import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// See queries.groups.test.ts: node --test gives each FILE its own process, but lib/db.ts
// memoises its connection, so every setup() in this file shares the first temp DB. Hence
// the per-setup prefix to keep fixtures from colliding.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  return { q, db, prefix: `t${++setupSeq}` };
}

/** A ready post with a feed target on `channelId`, optionally tagged with a band.
 *  Raw SQL because this seeds three tables the query helpers don't cover together. */
function seedPost(
  db: ReturnType<typeof import("better-sqlite3")>,
  channelId: number,
  band: string | null,
  status = "ready",
): number {
  const postId = Number(
    db
      .prepare(
        `INSERT INTO posts (caption, post_type, status, content_status, content_kind)
         VALUES ('x','single','draft',?,'evergreen')`,
      )
      .run(status).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,'feed')`,
  ).run(postId, channelId);
  if (band) {
    db.prepare(
      `INSERT INTO post_tags (post_id, tag_id)
       SELECT ?, id FROM tags WHERE name = ? AND kind = 'time_of_day'`,
    ).run(postId, band);
  }
  return postId;
}

async function seedTwoChannels() {
  const { q, db, prefix } = await setup();
  const a = q.createChannel({
    platform: "instagram", account_name: `${prefix}-a`, timezone: "UTC",
    remote_account_id: `${prefix}-a`, access_token: "tok",
  });
  const b = q.createChannel({
    platform: "instagram", account_name: `${prefix}-b`, timezone: "UTC",
    remote_account_id: `${prefix}-b`, access_token: "tok",
  });
  return { q, db, a, b };
}

test("getBandCounts counts ready feed posts per band", async () => {
  const { q, db, a } = await seedTwoChannels();
  seedPost(db, a, "evening");
  seedPost(db, a, "evening");
  seedPost(db, a, "morning");
  seedPost(db, a, "evening", "draft"); // not ready -> not counted
  seedPost(db, a, null);              // untagged -> not counted

  const counts = q.getBandCounts([a], "feed");
  assert.equal(counts.evening, 2);
  assert.equal(counts.morning, 1);
  assert.equal(counts.afternoon ?? 0, 0);
});

test("getBandCounts spans every channel in a group", async () => {
  const { q, db, a, b } = await seedTwoChannels();
  seedPost(db, a, "evening");
  seedPost(db, b, "evening");

  assert.equal(q.getBandCounts([a], "feed").evening, 1);
  assert.equal(q.getBandCounts([a, b], "feed").evening, 2);
});

test("getBandCounts returns an empty object for no channels", async () => {
  const { q } = await setup();
  assert.deepEqual(q.getBandCounts([], "feed"), {});
});
