import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// node --test runs each FILE in its own process, but every test in this file shares that
// process — and lib/db.ts memoises its connection, so every setup() here gets the SAME
// database. Hence the per-setup prefix on content_hash/storage_path and on the UNIQUE
// name columns: a literal "hash-1" in two tests would collide.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `x${++setupSeq}`;

  const mkAsset = (n: number, kind: "image" | "video" = "image") =>
    Number(
      db
        .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, ?, ?)")
        .run(`${prefix}-hash-${n}`, kind, `a/${prefix}/${n}.jpg`).lastInsertRowid
    );

  const mkChannel = (name: string) =>
    Number(
      db
        .prepare(
          "INSERT INTO channels (platform, account_name, is_active) VALUES ('instagram', ?, 1)"
        )
        .run(`${prefix}-${name}`).lastInsertRowid
    );

  const mkTag = (name: string) =>
    Number(
      db.prepare("INSERT INTO tags (kind, name) VALUES ('topic', ?)").run(`${prefix}-${name}`)
        .lastInsertRowid
    );

  const mkCarousel = (assetIds: number[]) =>
    q.createDraftPost({
      caption: "",
      first_comment: "",
      asset_ids: assetIds,
      post_type: "carousel",
    });

  /** Slides of a post as [asset_id, sort_order] pairs, ordered. */
  const slidesOf = (postId: number) =>
    db
      .prepare(
        "SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order"
      )
      .all(postId) as { asset_id: number; sort_order: number }[];

  return { q, db, mkAsset, mkChannel, mkTag, mkCarousel, slidesOf };
}

test("pulling one slide out leaves the rest a carousel, renumbered from zero", async () => {
  const { q, mkAsset, mkCarousel, slidesOf } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4)];
  const original = mkCarousel(a);

  const res = q.extractSlidesFromCarousel(original, [a[1]]);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.post_ids.length, 2, "the original plus one new post");
  assert.equal(res.post_ids[0], original);

  // THE renumbering invariant: pulling index 1 out of [0,1,2,3] must leave 0,1,2 — not a
  // gap at 1, and not a UNIQUE collision partway through.
  assert.deepEqual(slidesOf(original), [
    { asset_id: a[0], sort_order: 0 },
    { asset_id: a[2], sort_order: 1 },
    { asset_id: a[3], sort_order: 2 },
  ]);
  assert.equal(q.getPost(original)?.post_type, "carousel");

  assert.deepEqual(slidesOf(res.post_ids[1]), [{ asset_id: a[1], sort_order: 0 }]);
  assert.equal(q.getPost(res.post_ids[1])?.post_type, "single");
});

test("pulling several slides yields one post each, in carousel order", async () => {
  const { q, mkAsset, mkCarousel, slidesOf } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4)];
  const original = mkCarousel(a);

  // Ticked last-first on purpose: the result must follow carousel order, not click order.
  const res = q.extractSlidesFromCarousel(original, [a[3], a[1]]);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.post_ids.length, 3);
  assert.deepEqual(slidesOf(res.post_ids[1]), [{ asset_id: a[1], sort_order: 0 }]);
  assert.deepEqual(slidesOf(res.post_ids[2]), [{ asset_id: a[3], sort_order: 0 }]);
  assert.deepEqual(slidesOf(original), [
    { asset_id: a[0], sort_order: 0 },
    { asset_id: a[2], sort_order: 1 },
  ]);
});

test("leaving exactly one slide retypes the original as a single", async () => {
  const { q, mkAsset, mkCarousel, slidesOf } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(a);

  const res = q.extractSlidesFromCarousel(original, [a[1], a[2]]);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // A 1-slide post left as 'carousel' fails NON-retryably at publish with
  // "carousel needs 2-10 assets, has 1".
  assert.equal(q.getPost(original)?.post_type, "single");
  assert.deepEqual(slidesOf(original), [{ asset_id: a[0], sort_order: 0 }]);
});

test("leaving exactly one VIDEO slide retypes the original as a reel", async () => {
  const { q, mkAsset, mkCarousel } = await setup();
  const vid = mkAsset(1, "video");
  const a = [vid, mkAsset(2), mkAsset(3)];
  const original = mkCarousel(a);

  const res = q.extractSlidesFromCarousel(original, [a[1], a[2]]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(q.getPost(original)?.post_type, "reel");
});

test("an extracted video slide becomes a reel, not a single", async () => {
  const { q, mkAsset, mkCarousel } = await setup();
  const a = [mkAsset(1), mkAsset(2, "video"), mkAsset(3)];
  const original = mkCarousel(a);

  const res = q.extractSlidesFromCarousel(original, [a[1]]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(q.getPost(res.post_ids[1])?.post_type, "reel");
});

test("no asset is created, deleted, or orphaned", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(a);
  const before = (db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c;

  q.extractSlidesFromCarousel(original, [a[1]]);

  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c,
    before,
    "assets are SHARED, never copied or deleted"
  );
});

test("the post_assets row count is unchanged, so /media usage stays correct", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4)];
  const original = mkCarousel(a);
  const before = (db.prepare("SELECT COUNT(*) c FROM post_assets").get() as { c: number }).c;

  q.extractSlidesFromCarousel(original, [a[1], a[2]]);

  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM post_assets").get() as { c: number }).c,
    before
  );
});

test("each extracted post gets its own COPY of the content model", async () => {
  const { q, db, mkAsset, mkChannel, mkTag } = await setup();
  const channel = mkChannel("ig");
  const tag = mkTag("beach");
  const a = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = q.createDraftPost({
    caption: "sunset",
    first_comment: "#tags",
    asset_ids: a,
    post_type: "carousel",
    content_kind: "evergreen",
    content_status: "ready",
    cooldown_days: 45,
    targets: [{ channel_id: channel, surface: "story" }],
    tag_ids: [tag],
    caption_variants: [{ platform: null, body: "sunset", sort_order: 0 }],
  });

  const res = q.extractSlidesFromCarousel(original, [a[2]]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const child = res.post_ids[1];

  const post = q.getPost(child);
  assert.equal(post?.caption, "sunset");
  assert.equal(post?.first_comment, "#tags");
  assert.equal(post?.content_kind, "evergreen");
  assert.equal(post?.content_status, "ready");
  assert.equal(post?.cooldown_days, 45);
  assert.equal(post?.status, "draft");

  assert.deepEqual(
    db.prepare("SELECT body FROM caption_variants WHERE post_id = ?").all(child),
    [{ body: "sunset" }],
    "the worker prefers caption_variants over posts.caption — both must come across"
  );
  assert.deepEqual(
    db.prepare("SELECT channel_id, surface FROM post_targets WHERE post_id = ?").all(child),
    [{ channel_id: channel, surface: "story" }],
    "surface must survive — a Story target is not a plain channel target"
  );
  assert.deepEqual(db.prepare("SELECT tag_id FROM post_tags WHERE post_id = ?").all(child), [
    { tag_id: tag },
  ]);
});

test("the original keeps its own publications and caption", async () => {
  const { q, db, mkAsset, mkChannel } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = q.createDraftPost({
    caption: "kept",
    first_comment: "",
    asset_ids: a,
    post_type: "carousel",
  });
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'failed')"
  ).run(original, mkChannel("ig"));

  const res = q.extractSlidesFromCarousel(original, [a[1]]);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(q.getPost(original)?.caption, "kept");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM publications WHERE post_id = ?").get(original) as {
      c: number;
    }).c,
    1,
    "the original keeps its history"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM publications WHERE post_id = ?").get(
      res.post_ids[1]
    ) as { c: number }).c,
    0,
    "a new post has never been sent anywhere"
  );
});

// ---- rejections must write NOTHING -------------------------------------------------

test("selecting every slide is refused and nothing is written", async () => {
  const { q, db, mkAsset, mkCarousel, slidesOf } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(a);
  const postsBefore = (db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c;

  const res = q.extractSlidesFromCarousel(original, a);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "extracts_everything");
  assert.equal(res.problem.status, 400);

  assert.equal((db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c, postsBefore);
  assert.equal(q.getPost(original)?.post_type, "carousel");
  assert.equal(slidesOf(original).length, 3, "its slides are intact");
});

test("selecting nothing is refused", async () => {
  const { q, mkAsset, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  const res = q.extractSlidesFromCarousel(original, []);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "no_slides_selected");
});

test("a slide from another post is refused", async () => {
  const { q, mkAsset, mkCarousel, slidesOf } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(a);
  const stranger = mkAsset(9);

  const res = q.extractSlidesFromCarousel(original, [stranger]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "slide_not_in_post");
  assert.equal(slidesOf(original).length, 3);
});

test("a published carousel is refused", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(a);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(original, mkChannel("ig"));

  const res = q.extractSlidesFromCarousel(original, [a[1]]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "already_published");
  assert.equal(res.problem.status, 409);
});

test("a queued send is refused", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(a);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2030-01-01T00:00:00Z', 'scheduled')"
  ).run(original, mkChannel("ig"));

  const res = q.extractSlidesFromCarousel(original, [a[1]]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "send_queued");
});

test("a missing post is 404", async () => {
  const { q } = await setup();
  const res = q.extractSlidesFromCarousel(999999, [1]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.status, 404);
});

test("a failure partway through rolls back — the original keeps every slide", async () => {
  // The transaction DESTROYS before it creates: it deletes the original's post_assets rows
  // and rebuilds the keepers BEFORE any new post exists. Nothing else pins that a throw in
  // the creation loop puts them back, and a future "skip a bad one" try/catch would silently
  // leave a carousel holding only its keepers with no extracted posts and no error.
  const { q, db, mkAsset, mkCarousel, slidesOf } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4)];
  const original = mkCarousel(a);
  const postsBefore = (db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c;

  db.exec("CREATE TEMP TRIGGER extract_boom AFTER INSERT ON posts BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  try {
    assert.throws(() => q.extractSlidesFromCarousel(original, [a[1]]), /boom/);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS extract_boom;");
  }

  assert.deepEqual(
    slidesOf(original),
    [
      { asset_id: a[0], sort_order: 0 },
      { asset_id: a[1], sort_order: 1 },
      { asset_id: a[2], sort_order: 2 },
      { asset_id: a[3], sort_order: 3 },
    ],
    "every slide is back, in its original order"
  );
  assert.equal(q.getPost(original)?.post_type, "carousel");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c, postsBefore);
});

test("the database has no broken references afterwards", async () => {
  const { q, db, mkAsset, mkChannel, mkTag } = await setup();
  const a = [mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4)];
  const original = q.createDraftPost({
    caption: "fk",
    first_comment: "",
    asset_ids: a,
    post_type: "carousel",
    targets: [{ channel_id: mkChannel("ig"), surface: "feed" }],
    tag_ids: [mkTag("t")],
  });

  q.extractSlidesFromCarousel(original, [a[1], a[3]]);

  assert.deepEqual(db.pragma("foreign_key_check"), [], "no dangling references");
});
