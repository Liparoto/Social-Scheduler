import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// Same constraint as queries.merge.test.ts: node --test gives this FILE its own process,
// but lib/db.ts memoises the connection in a module-level `_db`, so every setup() here
// gets the SAME database. Assets are deduped by content_hash (UNIQUE), so a literal
// "hash-1" in two tests would collide — hence the per-setup prefix.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `t${++setupSeq}`;
  const mkAsset = (n: number) =>
    Number(
      db
        .prepare(
          "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)"
        )
        .run(`${prefix}-hash-${n}`, `a/${prefix}/${n}.jpg`).lastInsertRowid
    );
  const mkCarousel = (assetIds: number[]) =>
    q.createDraftPost({
      caption: "",
      first_comment: "",
      asset_ids: assetIds,
      post_type: "carousel",
    });
  const orderOf = (postId: number) =>
    db
      .prepare(
        "SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order"
      )
      .all(postId);
  return { q, db, mkAsset, mkCarousel, orderOf };
}

test("reordering rewrites sort_order contiguously from zero", async () => {
  const { q, mkAsset, mkCarousel, orderOf } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const post = mkCarousel(ids);

  q.reorderPostAssets(post, [ids[2], ids[0], ids[1]]);

  assert.deepEqual(orderOf(post), [
    { asset_id: ids[2], sort_order: 0 },
    { asset_id: ids[0], sort_order: 1 },
    { asset_id: ids[1], sort_order: 2 },
  ]);
});

// The reason this can't be a loop of UPDATEs: UNIQUE (post_id, sort_order) is enforced
// per-row and immediately, so moving the last slide to position 0 collides with the row
// already there. A reversal is the case that trips every intermediate position at once.
test("a full reversal survives UNIQUE (post_id, sort_order)", async () => {
  const { q, mkAsset, mkCarousel, orderOf } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4), mkAsset(5)];
  const post = mkCarousel(ids);

  q.reorderPostAssets(post, [...ids].reverse());

  assert.deepEqual(
    orderOf(post).map((r) => (r as { asset_id: number }).asset_id),
    [...ids].reverse()
  );
});

test("reordering one post leaves another post's order alone", async () => {
  const { q, mkAsset, mkCarousel, orderOf } = await setup();
  const mine = [mkAsset(1), mkAsset(2)];
  const theirs = [mkAsset(3), mkAsset(4)];
  const postA = mkCarousel(mine);
  const postB = mkCarousel(theirs);

  q.reorderPostAssets(postA, [mine[1], mine[0]]);

  assert.deepEqual(
    orderOf(postB).map((r) => (r as { asset_id: number }).asset_id),
    theirs
  );
});

// Assets are content-hash-shared and ON DELETE RESTRICT. Rebuilding join rows must not
// reach them.
test("no asset row is deleted by a reorder", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const post = mkCarousel(ids);
  const before = (db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n;

  q.reorderPostAssets(post, [ids[1], ids[2], ids[0]]);

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM assets").get() as { n: number }).n, before);
});

test("post_type and asset count are untouched", async () => {
  const { q, mkAsset, mkCarousel, orderOf } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const post = mkCarousel(ids);

  q.reorderPostAssets(post, [ids[1], ids[0], ids[2]]);

  assert.equal(q.getPost(post)?.post_type, "carousel");
  assert.equal(orderOf(post).length, 3);
});

test("getPostAssets reads back in the new order", async () => {
  const { q, mkAsset, mkCarousel } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const post = mkCarousel(ids);

  q.reorderPostAssets(post, [ids[2], ids[1], ids[0]]);

  assert.deepEqual(
    q.getPostAssets(post).map((a) => a.id),
    [ids[2], ids[1], ids[0]]
  );
});

test("a reorder bumps posts.updated_at", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const post = mkCarousel(ids);
  db.prepare("UPDATE posts SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(post);

  q.reorderPostAssets(post, [ids[1], ids[0]]);

  const row = db.prepare("SELECT updated_at FROM posts WHERE id = ?").get(post) as {
    updated_at: string;
  };
  assert.notEqual(row.updated_at, "2000-01-01T00:00:00Z");
});

// Deviation from the brief's fixture: createChannel(input) returns the new channel's id
// directly (a number), not an object with an `.id` field — and CreateChannelInput has no
// display_name/account_ref fields, only account_name (required) and timezone (required,
// even though the column itself defaults to 'UTC'). See queries.ts's CreateChannelInput
// and createChannel(). Also, the publications column is scheduled_at, not scheduled_for
// (see migrations/0001_init.sql) — the brief's note anticipated exactly this kind of
// mismatch and asked to adjust the fixture, not the assertions.
test("postHasPublishingPublication only reports the in-flight status", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const post = mkCarousel([mkAsset(1), mkAsset(2)]);
  const channelId = q.createChannel({
    platform: "instagram",
    account_name: `reorder-${setupSeq}`,
    timezone: "UTC",
  });
  const addSend = (status: string) =>
    db
      .prepare(
        `INSERT INTO publications (post_id, channel_id, status, scheduled_at)
         VALUES (?, ?, ?, '2030-01-01T00:00:00Z')`
      )
      .run(post, channelId, status);

  assert.equal(q.postHasPublishingPublication(post), false, "no sends at all");

  addSend("scheduled");
  assert.equal(q.postHasPublishingPublication(post), false, "a queued send does not block");

  addSend("posted");
  assert.equal(q.postHasPublishingPublication(post), false, "a past send does not block");

  addSend("publishing");
  assert.equal(q.postHasPublishingPublication(post), true, "an in-flight send blocks");
});
