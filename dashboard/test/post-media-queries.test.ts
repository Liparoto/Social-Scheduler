import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();

let seq = 0;

function mkAsset(kind: "image" | "video" = "image"): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, ?, ?, 1080, 1080)"
      )
      .run(`pmq-hash-${n}`, kind, `a/pmq/${n}.jpg`).lastInsertRowid
  );
}

function mkPost(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: assetIds.length > 1 ? "carousel" : "single",
  });
}

function mkChannel(platform: string): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES (?, ?, ?, 1)"
      )
      .run(platform, `acct-${n}`, `remote-${n}`).lastInsertRowid
  );
}

function slideIds(postId: number): number[] {
  return q.getPostSlides(postId).map((s) => s.asset_id);
}

/** Raw stored sort_order values, in the order SQLite hands them back — not derived from getPostSlides. */
function storedSortOrders(postId: number): number[] {
  return (
    db
      .prepare("SELECT sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order")
      .all(postId) as { sort_order: number }[]
  ).map((r) => r.sort_order);
}

test("getPostSlides returns slides in order with their media kind", () => {
  const a = mkAsset();
  const b = mkAsset("video");
  const post = mkPost([a, b]);
  assert.deepEqual(q.getPostSlides(post), [
    { asset_id: a, media_kind: "image" },
    { asset_id: b, media_kind: "video" },
  ]);
});

test("addPostAssets appends after the existing slides and sets post_type", () => {
  const post = mkPost([mkAsset()]);
  const extra = mkAsset();
  assert.equal(q.addPostAssets(post, [extra], "carousel"), "ok");
  assert.equal(slideIds(post).at(-1), extra);
  assert.equal(q.getPost(post)!.post_type, "carousel");
});

test("removePostAsset unlinks the slide and leaves the asset alone", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  assert.equal(q.removePostAsset(post, b, "single", false), "ok");
  assert.deepEqual(slideIds(post), [a]);
  assert.ok(q.getAsset(b), "the asset row must survive a remove-from-post");
  assert.equal(q.getPost(post)!.post_type, "single", "a successful remove writes the post_type passed in");
});

test("removePostAsset on an asset that isn't on the post reports not_found, not has_live", () => {
  const a = mkAsset();
  const post = mkPost([a]);
  const notOnPost = mkAsset();
  assert.equal(q.removePostAsset(post, notOnPost, "single", false), "not_found");
  assert.deepEqual(slideIds(post), [a]);
});

test("removePostAsset with alsoDeleteAsset removes the row too", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  assert.equal(q.removePostAsset(post, b, "single", true), "ok");
  assert.deepEqual(slideIds(post), [a]);
  assert.equal(q.getAsset(b), undefined);
});

test("a live send blocks both writes, and nothing changes", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  const channel = mkChannel("instagram");
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(post, channel);

  const postTypeBefore = q.getPost(post)!.post_type;
  assert.equal(q.addPostAssets(post, [mkAsset()], "carousel"), "has_live");
  assert.equal(q.removePostAsset(post, b, "single", false), "has_live");
  assert.deepEqual(slideIds(post), [a, b]);
  assert.equal(
    q.getPost(post)!.post_type,
    postTypeBefore,
    "a refused write must not retype the post either"
  );
});

test("countOtherPostsUsingAsset excludes the post being edited", () => {
  const shared = mkAsset();
  const one = mkPost([shared, mkAsset()]);
  assert.equal(q.countOtherPostsUsingAsset(one, shared), 0);
  mkPost([shared, mkAsset()]);
  assert.equal(q.countOtherPostsUsingAsset(one, shared), 1);
});

test("removePostAsset refuses to delete an asset another post still holds", () => {
  const shared = mkAsset();
  const post = mkPost([shared, mkAsset()]);
  mkPost([shared, mkAsset()]);
  const postTypeBefore = q.getPost(post)!.post_type;
  assert.equal(q.removePostAsset(post, shared, "single", true), "still_used");
  assert.ok(slideIds(post).includes(shared), "the link must survive a refusal");
  assert.ok(q.getAsset(shared));
  assert.equal(
    q.getPost(post)!.post_type,
    postTypeBefore,
    "a refused write must not retype the post either"
  );
});

test("removePostAsset(alsoDeleteAsset: true) reports referenced_asset — NOT still_used — when a Story send references the asset row directly", () => {
  // publications.asset_id REFERENCES assets(id) ON DELETE RESTRICT (migration 0014): a
  // scheduled Story send pinned to this exact slide isn't caught by dropAsset's own
  // NOT EXISTS (post_assets ...) guard, because post_assets has nothing to do with
  // publications. Without a catch, this used to escape as a raw SQLITE_CONSTRAINT error.
  //
  // It must NOT come back as "still_used": that word means a post_assets row appeared
  // mid-request (a genuine race), and the route says so to the user. A foreign key is a
  // standing reference, not a race.
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  const channel = mkChannel("instagram");
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled', 'story', ?)`
  ).run(post, channel, b);

  assert.equal(q.removePostAsset(post, b, "single", true), "referenced_asset");
  assert.ok(slideIds(post).includes(b), "the post link must survive the refusal");
  assert.ok(q.getAsset(b), "the asset row must survive the refusal");
});

test("an untargeted draft falls back to Instagram's stricter cap", () => {
  const post = mkPost([mkAsset()]);
  assert.deepEqual(
    q.getPostCompatChannels(post).map((c) => c.platform),
    ["instagram"]
  );
});

test("getPostCompatChannels unions targets and queued sends", () => {
  const post = mkPost([mkAsset()]);
  const target = mkChannel("threads");
  const queued = mkChannel("facebook");
  db.prepare("INSERT INTO post_targets (post_id, channel_id) VALUES (?, ?)").run(post, target);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled')"
  ).run(post, queued);
  assert.deepEqual(
    q.getPostCompatChannels(post).map((c) => c.platform).sort(),
    ["facebook", "threads"]
  );
});

test("removing a middle slide then appending closes the gap without a UNIQUE collision", () => {
  const a = mkAsset();
  const b = mkAsset();
  const c = mkAsset();
  const post = mkPost([a, b, c]);
  assert.equal(q.removePostAsset(post, b, "carousel", false), "ok");
  assert.deepEqual(slideIds(post), [a, c]);
  // The assertion that actually proves the gap was closed: without it, [a, c] would sit at
  // stored sort_order [0, 2] (the hole left by b), the two getPostSlides checks above would
  // still pass, and the append below would land at MAX+1 = 3 without ever colliding.
  assert.deepEqual(storedSortOrders(post), [0, 1]);
  const d = mkAsset();
  assert.equal(q.addPostAssets(post, [d], "carousel"), "ok");
  assert.deepEqual(slideIds(post), [a, c, d]);
});

test("countQueuedPerSlideSendsForPost counts Story rows and ignores feed rows", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  const channel = mkChannel("instagram");
  assert.equal(q.countQueuedPerSlideSendsForPost(post), 0);

  // A feed send names no slide — it publishes whatever the post holds at publish time, so
  // it must never block adding one.
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, scheduled_at, status)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled')`
  ).run(post, channel);
  assert.equal(q.countQueuedPerSlideSendsForPost(post), 0);

  for (const slide of [a, b]) {
    db.prepare(
      `INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id)
       VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled', 'story', ?)`
    ).run(post, channel, slide);
  }
  assert.equal(q.countQueuedPerSlideSendsForPost(post), 2);
});

test("countOtherAssetReferences sees publications of ANY status, and cover images", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  const channel = mkChannel("instagram");
  assert.deepEqual(q.countOtherAssetReferences(b), { sends: 0, covers: 0 });

  // 'failed' is the status countQueuedDirectSendsForSlide() deliberately misses — and the
  // one that matters most, since fixing the media is often why a send failed.
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'failed', 'story', ?)`
  ).run(post, channel, b);
  assert.deepEqual(q.countOtherAssetReferences(b), { sends: 1, covers: 0 });

  db.prepare("UPDATE assets SET cover_asset_id = ? WHERE id = ?").run(b, a);
  assert.deepEqual(q.countOtherAssetReferences(b), { sends: 1, covers: 1 });
});
