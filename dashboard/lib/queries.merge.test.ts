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

// ---- The caption contract: null and "" both CLEAR, identically ----------------------
// The merge modal's "No caption" option has to actually remove the text. posts.caption and
// caption_variants must always be cleared together — the worker prefers the variants, so a
// leftover variant is what would really go out.

for (const [label, caption] of [
  ["null", null],
  ["an empty string", ""],
] as const) {
  test(`a caption of ${label} clears both posts.caption and caption_variants`, async () => {
    const { q, db, mkAsset } = await setup();
    const ids = [mkAsset(1), mkAsset(2)];
    const survivor = q.createDraftPost({
      caption: "old text",
      first_comment: "",
      asset_ids: [ids[0]],
      caption_variants: [{ platform: null, body: "old text", sort_order: 0 }],
    });
    const other = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [ids[1]] });

    const res = q.mergePostsIntoCarousel([survivor, other], ids, caption);
    assert.equal(res.ok, true);
    assert.equal(q.getPost(survivor)?.caption, null, "posts.caption is cleared");
    const vars = db.prepare("SELECT body FROM caption_variants WHERE post_id = ?")
      .all(survivor) as { body: string }[];
    assert.deepEqual(vars, [], "and every variant goes with it");
  });
}

test("a real caption replaces the survivor's existing caption and variants", async () => {
  const { q, db, mkAsset } = await setup();
  const ids = [mkAsset(1), mkAsset(2)];
  const survivor = q.createDraftPost({
    caption: "old text",
    first_comment: "",
    asset_ids: [ids[0]],
    caption_variants: [{ platform: null, body: "old text", sort_order: 0 }],
  });
  const other = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [ids[1]] });

  const res = q.mergePostsIntoCarousel([survivor, other], ids, "new text");
  assert.equal(res.ok, true);
  assert.equal(q.getPost(survivor)?.caption, "new text");
  const vars = db.prepare("SELECT body, platform, sort_order FROM caption_variants WHERE post_id = ?")
    .all(survivor);
  assert.deepEqual(vars, [{ body: "new text", platform: null, sort_order: 0 }],
    "replaced, not appended — the old variant describes the pre-merge post");
});

// ---- The cap comes from the real target channels, not the fallback -------------------

test("the cap is read from the merged posts' own target channels", async () => {
  const { q, db, mkAsset, mkDraft } = await setup();
  const ch = (platform: string, name: string) => Number(db.prepare(
    "INSERT INTO channels (platform, account_name) VALUES (?, ?)"
  ).run(platform, name).lastInsertRowid);

  // Threads allows 20 per carousel, so 11 slides is fine here — and only fine because the
  // cap came from the channel rows. The untargeted fallback (Instagram, 10) would reject it.
  const threads = ch("threads", "threads-only");
  const ids = Array.from({ length: 11 }, (_, i) => mkAsset(i + 1));
  const posts = ids.map((a) => mkDraft([a]));
  for (const p of posts) q.setPostTargets(p, [threads]);

  const res = q.mergePostsIntoCarousel(posts, ids, null);
  assert.equal(res.ok, true, "11 slides is within Threads' cap of 20");
  if (!res.ok) return;
  assert.equal(q.getPost(res.post_id)?.post_type, "carousel");
});

test("one strict target channel caps the whole merge", async () => {
  const { q, db, mkAsset, mkDraft } = await setup();
  const ch = (platform: string, name: string) => Number(db.prepare(
    "INSERT INTO channels (platform, account_name) VALUES (?, ?)"
  ).run(platform, name).lastInsertRowid);

  // Same 11 slides, but one of the posts also goes to Instagram. planMerge takes the
  // STRICTEST cap across the union, so Instagram's 10 has to win over Threads' 20.
  const threads = ch("threads", "th");
  const insta = ch("instagram", "ig");
  const ids = Array.from({ length: 11 }, (_, i) => mkAsset(i + 1));
  const posts = ids.map((a) => mkDraft([a]));
  for (const p of posts) q.setPostTargets(p, [threads]);
  q.setPostTargets(posts[3], [insta]);

  const res = q.mergePostsIntoCarousel(posts, ids, null);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "carousel_too_large");
});
