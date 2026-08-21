import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// Same constraint as queries.merge.test.ts: node --test gives this FILE its own process,
// but lib/db.ts memoises its connection, so every setup() here shares one database no
// matter how many temp files makeTestDb() creates. Assets are deduped by content_hash
// (UNIQUE), so fixtures need a per-setup prefix or the second test collides with the first.
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
  const mkDraft = (assetIds: number[]) =>
    q.createDraftPost({ caption: "", first_comment: "", asset_ids: assetIds });
  const exists = (id: number) =>
    db.prepare("SELECT 1 FROM assets WHERE id = ?").get(id) !== undefined;
  return { q, db, mkAsset, mkDraft, exists };
}

test("an unused asset is deleted", async () => {
  const { q, mkAsset, exists } = await setup();
  const id = mkAsset(1);

  assert.equal(q.deleteAsset(id), "ok");
  assert.equal(exists(id), false);
});

test("an asset attached to a post is REFUSED and survives", async () => {
  const { q, mkAsset, mkDraft, exists } = await setup();
  const id = mkAsset(1);
  mkDraft([id]);

  // THE invariant: a post's media must never vanish underneath it. The worker serves these
  // bytes to Meta at publish time, so a wrong answer here is a broken publish, not a UI bug.
  //
  // Known limit, verified by mutation: deleting the `NOT EXISTS` guard from deleteAsset()
  // leaves this whole file green, because post_assets' ON DELETE RESTRICT then throws and
  // the SQLITE_CONSTRAINT catch maps it to the same "in_use". The foreign key is the
  // load-bearing check; the inline guard only closes a check-then-act race that
  // better-sqlite3's synchronous, single-writer model makes unreachable from a test. So
  // these assertions pin the BEHAVIOUR, not which of the two mechanisms produced it —
  // which is the right thing to pin, but don't read them as coverage of the guard.
  assert.equal(q.deleteAsset(id), "in_use");
  assert.equal(exists(id), true);
});

test("an unknown id reports not_found rather than pretending to succeed", async () => {
  const { q } = await setup();
  assert.equal(q.deleteAsset(999_999), "not_found");
});

test("deleting the post frees its asset for deletion", async () => {
  const { q, mkAsset, mkDraft, exists } = await setup();
  const id = mkAsset(1);
  const postId = mkDraft([id]);
  assert.equal(q.deleteAsset(id), "in_use");

  assert.equal(q.deletePost(postId), "ok");

  // post_assets cascades on post delete, which is exactly how an asset becomes an orphan —
  // the condition that made this page necessary in the first place.
  assert.equal(q.deleteAsset(id), "ok");
  assert.equal(exists(id), false);
});

test("one asset in two posts is still refused after only one is deleted", async () => {
  const { q, mkAsset, mkDraft, exists } = await setup();
  const id = mkAsset(1);
  const first = mkDraft([id]);
  mkDraft([id]);

  assert.equal(q.deletePost(first), "ok");

  // The guard counts references, it doesn't track "was it ever used" — the second post
  // still needs these bytes.
  assert.equal(q.deleteAsset(id), "in_use");
  assert.equal(exists(id), true);
});

test("deleting one asset leaves its neighbours untouched", async () => {
  const { q, mkAsset, exists } = await setup();
  const doomed = mkAsset(1);
  const keep = mkAsset(2);

  assert.equal(q.deleteAsset(doomed), "ok");
  assert.equal(exists(keep), true);
});

test("listAssetsWithUsage reports usage that matches what delete will allow", async () => {
  const { q, mkAsset, mkDraft } = await setup();
  const used = mkAsset(1);
  const unused = mkAsset(2);
  mkDraft([used]);

  const rows = q.listAssetsWithUsage();
  const byId = new Map(rows.map((r) => [r.id, r]));

  // The page decides whether to show a Delete button from post_count. If that ever
  // disagreed with deleteAsset()'s guard, the UI would offer a button that always 409s.
  assert.equal(byId.get(used)?.post_count, 1);
  assert.equal(byId.get(unused)?.post_count, 0);
  assert.equal(q.deleteAsset(unused), "ok");
  assert.equal(q.deleteAsset(used), "in_use");
});

// ---- A Reels cover is a USE, even though it has no post_assets row --------------------
// The test above states the invariant these keep honest: the page decides whether to offer
// a Delete button from what listAssetsWithUsage() reports, so anything deleteAsset() will
// refuse has to be reported as used. migration 0016 added a second way to reference an
// asset — assets.cover_asset_id, a video pointing at the image it uses as its Reels cover —
// and it carries no post_assets row at all.

async function coverSetup() {
  const base = await setup();
  const mkVideo = (n: number) =>
    Number(
      base.db
        .prepare(
          "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'video', ?)"
        )
        .run(`cover-hash-${n}-${Math.random()}`, `v/${n}.mp4`).lastInsertRowid
    );
  return { ...base, mkVideo };
}

test("an asset used only as a Reels cover is reported as used, not as free space", async () => {
  const { q, mkAsset, mkVideo } = await coverSetup();
  const video = mkVideo(1);
  const cover = mkAsset(1);
  q.setAssetCoverImage(video, cover);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  const row = byId.get(cover);
  assert.equal(row?.post_count, 0, "a cover genuinely has no post_assets row");
  assert.equal(row?.cover_use_count, 1, "but it IS referenced, and /media has to say so");

  // The invariant: whatever delete refuses must never be shown as deletable.
  assert.equal(q.deleteAsset(cover), "in_use");
});

test("clearing the cover releases the asset again", async () => {
  const { q, mkAsset, mkVideo } = await coverSetup();
  const video = mkVideo(2);
  const cover = mkAsset(2);
  q.setAssetCoverImage(video, cover);
  q.setAssetCoverImage(video, null);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  assert.equal(byId.get(cover)?.cover_use_count, 0);
  assert.equal(q.deleteAsset(cover), "ok", "nothing references it any more");
});

test("one image serving as the cover for several videos counts every one", async () => {
  const { q, mkAsset, mkVideo } = await coverSetup();
  const cover = mkAsset(3);
  const videos = [mkVideo(3), mkVideo(4)];
  for (const v of videos) q.setAssetCoverImage(v, cover);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  assert.equal(byId.get(cover)?.cover_use_count, 2);
  // The videos themselves are unused — pointing AT a cover is not being used BY anything.
  assert.equal(byId.get(videos[0])?.cover_use_count, 0);
});

test("an asset in a post AND serving as a cover reports both", async () => {
  const { q, mkAsset, mkVideo, mkDraft } = await coverSetup();
  const video = mkVideo(5);
  const cover = mkAsset(4);
  mkDraft([cover]);
  q.setAssetCoverImage(video, cover);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  assert.equal(byId.get(cover)?.post_count, 1);
  assert.equal(byId.get(cover)?.cover_use_count, 1);
});

// ---- Every post an asset belongs to, not an arbitrary one ----------------------------
// listAssetsWithUsage used to return MIN(pa.post_id): the LOWEST-numbered post using the
// asset, picked by id with no relation to relevance, while every other post collapsed into
// the plain text "+N more" that was not a link. For an asset reused across posts — the
// normal case for evergreen recycling — most of its posts could not be reached at all.

test("an asset in several posts reports every one of them", async () => {
  const { q, mkAsset, mkDraft } = await setup();
  const shared = mkAsset(1);
  const first = mkDraft([shared]);
  const second = mkDraft([shared]);
  const third = mkDraft([shared]);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  const row = byId.get(shared);

  assert.equal(row?.post_count, 3);
  assert.deepEqual(
    row?.posts.map((p) => p.post_id),
    [first, second, third],
    "all three, in creation order — MIN() returned only the first"
  );
});

test("each linked post carries what it takes to recognise it", async () => {
  const { q, db, mkAsset } = await setup();
  const asset = mkAsset(2);
  const postId = q.createDraftPost({
    caption: "Spring sale — last chance\nsecond line that must not appear",
    first_comment: "",
    asset_ids: [asset],
  });
  db.prepare("UPDATE posts SET status = 'scheduled' WHERE id = ?").run(postId);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  const [linked] = byId.get(asset)!.posts;

  assert.equal(linked.post_id, postId);
  assert.equal(linked.status, "scheduled");
  // The full caption travels; taking the first line is the RENDERER's job, so the query
  // stays useful to any other caller.
  assert.match(linked.caption ?? "", /^Spring sale/);
});

test("an unused asset has no linked posts", async () => {
  const { q, mkAsset } = await setup();
  const unused = mkAsset(3);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  assert.equal(byId.get(unused)?.post_count, 0);
  assert.deepEqual(byId.get(unused)?.posts, []);
});

test("one asset's posts never leak onto another asset", async () => {
  const { q, mkAsset, mkDraft } = await setup();
  const a = mkAsset(4);
  const b = mkAsset(5);
  const postA = mkDraft([a]);
  const postB = mkDraft([b]);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  assert.deepEqual(byId.get(a)?.posts.map((p) => p.post_id), [postA]);
  assert.deepEqual(byId.get(b)?.posts.map((p) => p.post_id), [postB]);
});

test("a carousel counts once per post, not once per slide", async () => {
  // post_count comes from a GROUP BY over post_assets; the linked-post list is assembled
  // from the same rows. A carousel puts several slides on ONE post, and each asset belongs
  // to it exactly once, so neither number may double up.
  const { q, mkAsset, mkDraft } = await setup();
  const one = mkAsset(6);
  const two = mkAsset(7);
  const carousel = mkDraft([one, two]);

  const byId = new Map(q.listAssetsWithUsage().map((r) => [r.id, r]));
  for (const id of [one, two]) {
    assert.equal(byId.get(id)?.post_count, 1);
    assert.deepEqual(byId.get(id)?.posts.map((p) => p.post_id), [carousel]);
  }
});

test("linking every post does not cost a query per asset", async () => {
  // The whole asset store is read at once on /media. A per-asset lookup would be an N+1
  // that only shows up as the store grows — 167 assets on the owner's install today.
  const { q, db, mkAsset, mkDraft } = await setup();
  for (let i = 20; i < 32; i++) mkDraft([mkAsset(i)]);

  let statements = 0;
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    statements += 1;
    return original(sql);
  }) as typeof db.prepare;
  try {
    const rows = q.listAssetsWithUsage();
    assert.ok(rows.length >= 12, "precondition: there are plenty of assets to fan out over");
  } finally {
    (db as unknown as { prepare: typeof db.prepare }).prepare = original;
  }
  assert.ok(statements <= 2, `expected a batched read, got ${statements} prepared statements`);
});
