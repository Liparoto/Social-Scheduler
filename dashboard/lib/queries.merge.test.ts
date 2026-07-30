import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// node --test runs each FILE in its own process, but every test in this file shares that
// process — and lib/db.ts memoises its connection in a module-level `_db`, so the second
// setup() here gets the SAME database as the first no matter how many temp files
// makeTestDb() creates. Hence the per-setup prefix on content_hash/storage_path: assets
// are deduped by content hash (UNIQUE), so a literal "hash-1" in two tests would collide.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `t${++setupSeq}`;
  // Assets need a unique content_hash; storage_path is NOT NULL.
  const mkAsset = (n: number) =>
    Number(db.prepare(
      "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)"
    ).run(`${prefix}-hash-${n}`, `a/${prefix}/${n}.jpg`).lastInsertRowid);
  // createDraftPost's caption/first_comment are required strings; every fixture below is
  // about assets, not text, so they are always empty here.
  const mkDraft = (assetIds: number[], postType?: "single" | "carousel" | "text") =>
    q.createDraftPost({
      caption: "",
      first_comment: "",
      asset_ids: assetIds,
      ...(postType ? { post_type: postType } : {}),
    });
  return { q, db, mkAsset, mkDraft };
}

test("merging three singles yields one carousel with contiguous slides", async () => {
  const { q, db, mkAsset, mkDraft } = await setup();
  const ids = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const posts = ids.map((a) => mkDraft([a]));

  const res = q.mergePostsIntoCarousel(posts, [ids[2], ids[0], ids[1]], null);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // THE invariant from spec §3 — wrong here means a silent failure at publish time.
  assert.equal(q.getPost(res.post_id)?.post_type, "carousel");

  const rows = db.prepare(
    "SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order"
  ).all(res.post_id);
  assert.deepEqual(rows, [
    { asset_id: ids[2], sort_order: 0 },
    { asset_id: ids[0], sort_order: 1 },
    { asset_id: ids[1], sort_order: 2 },
  ]);

  assert.equal(q.getPost(posts[1]), undefined, "emptied drafts are deleted");
  assert.equal(q.getPost(posts[2]), undefined);
});

test("no asset is deleted or orphaned", async () => {
  const { q, db, mkAsset, mkDraft } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const posts = ids.map((a) => mkDraft([a]));
  const before = db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number };

  q.mergePostsIntoCarousel(posts, ids, null);

  const after = db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number };
  assert.equal(after.c, before.c, "merging must never delete a photo");
});

test("merging INTO an existing carousel survives the sort_order collision", async () => {
  const { q, db, mkAsset, mkDraft } = await setup();
  const a = [mkAsset(1), mkAsset(2)];
  const carousel = mkDraft(a);                 // occupies sort_order 0 and 1
  const extra = mkAsset(3);
  const single = mkDraft([extra]);

  // Interleave: the new photo lands between the carousel's existing slides.
  const res = q.mergePostsIntoCarousel([carousel, single], [a[0], extra, a[1]], null);
  assert.equal(res.ok, true);
  const rows = db.prepare(
    "SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order"
  ).all(carousel) as { asset_id: number }[];
  assert.deepEqual(rows.map((r) => r.asset_id), [a[0], extra, a[1]]);
});

test("caption is written to BOTH posts.caption and caption_variants", async () => {
  const { q, db, mkAsset, mkDraft } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const posts = ids.map((a) => mkDraft([a]));

  const res = q.mergePostsIntoCarousel(posts, ids, "Grand Teton");
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(q.getPost(res.post_id)?.caption, "Grand Teton");
  const vars = db.prepare(
    "SELECT body FROM caption_variants WHERE post_id = ?"
  ).all(res.post_id) as { body: string }[];
  assert.deepEqual(vars.map((v) => v.body), ["Grand Teton"],
    "the worker prefers variants over posts.caption");
});

test("targets and tags are unioned from every merged post", async () => {
  const { q, db, mkAsset, mkDraft } = await setup();
  const ch = (n: string) => Number(db.prepare(
    "INSERT INTO channels (platform, account_name) VALUES ('instagram', ?)"
  ).run(n).lastInsertRowid);
  const c1 = ch("a"), c2 = ch("b");
  const ids = [mkAsset(1), mkAsset(2)];
  const posts = ids.map((a) => mkDraft([a]));
  q.setPostTargets(posts[0], [c1]);
  q.setPostTargets(posts[1], [c2]);

  const res = q.mergePostsIntoCarousel(posts, ids, null);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(q.getPostTargets(res.post_id).sort(), [c1, c2].sort());
});

test("a rejected merge writes nothing at all", async () => {
  const { q, mkAsset, mkDraft } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const posts = ids.map((a) => mkDraft([a]));

  const res = q.mergePostsIntoCarousel(posts, [ids[0]], null);  // omits a slide
  assert.equal(res.ok, false);
  assert.equal(q.getPost(posts[0])?.post_type, "single", "untouched");
  assert.ok(q.getPost(posts[1]), "the other draft still exists");
});

// ---- The three cases the brief's list didn't cover ---------------------------------

test("the size cap still applies when no post has a target channel", async () => {
  const { q, mkAsset, mkDraft } = await setup();
  // 11 drafts, zero post_targets between them — the platform list we hand planMerge would
  // be empty, and Math.min() of an empty array is Infinity, which would silently disable
  // the cap entirely and let this through to die at publish time.
  const ids = Array.from({ length: 11 }, (_, i) => mkAsset(i + 1));
  const posts = ids.map((a) => mkDraft([a]));

  const res = q.mergePostsIntoCarousel(posts, ids, null);
  assert.equal(res.ok, false, "11 slides must be rejected even with no target platform");
  if (res.ok) return;
  assert.equal(res.problem.code, "carousel_too_large");
  assert.ok(q.getPost(posts[0]), "nothing was written");
});

test("post_type follows the surviving asset count, not the word 'carousel'", async () => {
  const { q, mkAsset, mkDraft } = await setup();
  // A text post carries no assets, so merging it into a single-image draft leaves exactly
  // one slide. Calling that a 'carousel' is the exact mismatch the worker refuses to publish.
  const only = mkAsset(1);
  const single = mkDraft([only]);
  const text = mkDraft([], "text");

  const res = q.mergePostsIntoCarousel([single, text], [only], null);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(q.getPost(res.post_id)?.post_type, "single");
});

test("a merge that would leave zero slides is rejected", async () => {
  const { q, mkDraft } = await setup();
  const a = mkDraft([], "text");
  const b = mkDraft([], "text");

  const res = q.mergePostsIntoCarousel([a, b], [], null);
  assert.equal(res.ok, false, "no post_type is valid for a post with no assets");
  assert.ok(q.getPost(a), "both posts are untouched");
  assert.ok(q.getPost(b));
});

test("a null caption leaves the survivor's own caption alone", async () => {
  const { q, db, mkAsset } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const survivor = q.createDraftPost({
    caption: "keep me",
    first_comment: "",
    asset_ids: [ids[0]],
    caption_variants: [{ platform: null, body: "keep me", sort_order: 0 }],
  });
  const other = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [ids[1]] });

  const res = q.mergePostsIntoCarousel([survivor, other], ids, null);
  assert.equal(res.ok, true);
  assert.equal(q.getPost(survivor)?.caption, "keep me");
  const vars = db.prepare("SELECT body FROM caption_variants WHERE post_id = ?")
    .all(survivor) as { body: string }[];
  assert.deepEqual(vars.map((v) => v.body), ["keep me"]);
});
