import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// node --test runs each FILE in its own process, but every test in this file shares that
// process — and lib/db.ts memoises its connection in a module-level `_db`, so the second
// setup() here gets the SAME database as the first no matter how many temp files
// makeTestDb() creates. Hence the per-setup prefix on content_hash/storage_path: assets are
// deduped by content hash (UNIQUE), so a literal "hash-1" in two tests would collide.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `u${++setupSeq}`;

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

  // tags.name is UNIQUE COLLATE NOCASE and periods.name is UNIQUE — both need the prefix for
  // the same reason the asset hashes do: every setup() in this file shares one database.
  const mkTag = (name: string) =>
    Number(
      db
        .prepare("INSERT INTO tags (kind, name) VALUES ('topic', ?)")
        .run(`${prefix}-${name}`).lastInsertRowid
    );

  const mkPeriod = (name: string) =>
    Number(
      db
        .prepare(
          "INSERT INTO periods (name, start_month, start_day, end_month, end_day) VALUES (?, 6, 1, 8, 31)"
        )
        .run(`${prefix}-${name}`).lastInsertRowid
    );

  /** A carousel with N slides, created directly so post_type is exactly what we say. */
  const mkCarousel = (assetIds: number[]) =>
    q.createDraftPost({
      caption: "",
      first_comment: "",
      asset_ids: assetIds,
      post_type: "carousel",
    });

  return { q, db, mkAsset, mkChannel, mkTag, mkPeriod, mkCarousel };
}

test("a three-slide carousel becomes three posts, original first", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const assets = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(assets);

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(res.post_ids.length, 3);
  assert.equal(res.post_ids[0], original, "the original post survives and comes first");

  // Each resulting post holds exactly one slide, at sort_order 0, in the original order.
  res.post_ids.forEach((pid, i) => {
    const rows = db
      .prepare("SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order")
      .all(pid);
    assert.deepEqual(rows, [{ asset_id: assets[i], sort_order: 0 }], `post ${i} holds slide ${i}`);
  });
});

test("every resulting post is retyped — none is left as a carousel", async () => {
  // THE invariant from spec §3. A post left as 'carousel' with one asset looks fine in the
  // dashboard and then fails NON-retryably at send with "carousel needs 2-10 assets, has 1".
  const { q, mkAsset, mkCarousel } = await setup();
  const res = q.unmergeCarousel(mkCarousel([mkAsset(1), mkAsset(2)]));
  assert.equal(res.ok, true);
  if (!res.ok) return;

  for (const pid of res.post_ids) {
    assert.equal(q.getPost(pid)?.post_type, "single");
  }
});

test("a video slide becomes a reel, including when it is slide one", async () => {
  const { q, mkAsset, mkCarousel } = await setup();
  const vid = mkAsset(1, "video");
  const img = mkAsset(2);
  const res = q.unmergeCarousel(mkCarousel([vid, img]));
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(q.getPost(res.post_ids[0])?.post_type, "reel", "the ORIGINAL was retyped");
  assert.equal(q.getPost(res.post_ids[1])?.post_type, "single");
});

test("no asset is created, deleted, or orphaned", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2), mkAsset(3)]);
  const before = (db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c;

  q.unmergeCarousel(original);

  const after = (db.prepare("SELECT COUNT(*) c FROM assets").get() as { c: number }).c;
  assert.equal(after, before, "assets are SHARED, never copied or deleted");
});

test("the post_assets row count is unchanged, so /media usage stays correct", async () => {
  // listAssetsWithUsage() counts usage via post_assets. N rows on one post must become
  // N rows across N posts — if this drifts, the "unused" figure and the reclaim total on
  // /media start lying.
  const { q, db, mkAsset, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2), mkAsset(3)]);
  const before = (db.prepare("SELECT COUNT(*) c FROM post_assets").get() as { c: number }).c;

  q.unmergeCarousel(original);

  const after = (db.prepare("SELECT COUNT(*) c FROM post_assets").get() as { c: number }).c;
  assert.equal(after, before);
});

test("each new post gets its own COPY of caption, variants, targets, tags and seasons", async () => {
  const { q, db, mkAsset, mkChannel, mkTag, mkPeriod } = await setup();
  const channel = mkChannel("ig");
  const tag = mkTag("beach");
  const periodId = mkPeriod("summer");
  const original = q.createDraftPost({
    caption: "sunset",
    first_comment: "#tags",
    asset_ids: [mkAsset(1), mkAsset(2)],
    post_type: "carousel",
    content_kind: "evergreen",
    content_status: "ready",
    cooldown_days: 45,
    targets: [{ channel_id: channel, surface: "story" }],
    tag_ids: [tag],
    period_links: [{ periodId, mode: "green" }],
    caption_variants: [{ platform: null, body: "sunset", sort_order: 0 }],
  });

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const child = res.post_ids[1];

  const post = q.getPost(child);
  assert.equal(post?.caption, "sunset");
  assert.equal(post?.first_comment, "#tags");
  assert.equal(post?.content_kind, "evergreen");
  assert.equal(post?.content_status, "ready");
  assert.equal(post?.cooldown_days, 45);
  assert.equal(post?.status, "draft", "a post with no publications is a draft");

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
  assert.deepEqual(
    db.prepare("SELECT period_id, mode FROM post_periods WHERE post_id = ?").all(child),
    [{ period_id: periodId, mode: "green" }]
  );
});

test("the original keeps everything it had — only its slides and type change", async () => {
  const { q, db, mkAsset, mkChannel } = await setup();
  const channel = mkChannel("ig");
  const original = q.createDraftPost({
    caption: "kept",
    first_comment: "",
    asset_ids: [mkAsset(1), mkAsset(2)],
    post_type: "carousel",
    targets: [{ channel_id: channel, surface: "feed" }],
    caption_variants: [{ platform: null, body: "kept", sort_order: 0 }],
  });

  q.unmergeCarousel(original);

  assert.equal(q.getPost(original)?.caption, "kept");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM caption_variants WHERE post_id = ?").get(original) as { c: number }).c,
    1,
    "the original's variants are not moved to the children — they are copied"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM post_targets WHERE post_id = ?").get(original) as { c: number }).c,
    1
  );
});

test("editing a child's caption afterwards does not change the original", async () => {
  // The copy-not-share contract from §4. If this fails, the modal's "each keeps" is a lie.
  const { q, db, mkAsset } = await setup();
  const original = q.createDraftPost({
    caption: "shared?",
    first_comment: "",
    asset_ids: [mkAsset(1), mkAsset(2)],
    post_type: "carousel",
  });
  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  db.prepare("UPDATE posts SET caption = 'changed' WHERE id = ?").run(res.post_ids[1]);
  assert.equal(q.getPost(original)?.caption, "shared?");
});

test("non-contiguous sort_order is rebuilt from zero", async () => {
  const { q, db, mkAsset, mkCarousel } = await setup();
  const assets = [mkAsset(1), mkAsset(2), mkAsset(3)];
  const original = mkCarousel(assets);
  // Force a gap-y order. Descending, so no intermediate UPDATE collides with an existing row.
  db.prepare("UPDATE post_assets SET sort_order = 7 WHERE post_id = ? AND asset_id = ?").run(original, assets[2]);
  db.prepare("UPDATE post_assets SET sort_order = 3 WHERE post_id = ? AND asset_id = ?").run(original, assets[1]);

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  for (const pid of res.post_ids) {
    const rows = db.prepare("SELECT sort_order FROM post_assets WHERE post_id = ?").all(pid);
    assert.deepEqual(rows, [{ sort_order: 0 }], "every post's single slide sits at 0");
  }
});

test("a carousel with a 'posted' publication is refused and nothing is written", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(original, mkChannel("ig"));
  const postsBefore = (db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c;

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.status, 409);
  assert.equal(res.problem.code, "already_published");

  assert.equal((db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c, postsBefore);
  assert.equal(q.getPost(original)?.post_type, "carousel", "a refused split changes nothing");
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM post_assets WHERE post_id = ?").get(original) as { c: number }).c,
    2,
    "its slides are intact"
  );
});

test("a 'publishing' publication is refused too — the worker is mid-flight", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'publishing')"
  ).run(original, mkChannel("ig"));

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "already_published");
});

test("a 'scheduled' publication is refused, pointing at queue control", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2030-01-01T00:00:00Z', 'scheduled')"
  ).run(original, mkChannel("ig"));

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.status, 409);
  assert.equal(res.problem.code, "send_queued");
});

test("a 'pending_approval' publication is refused — it is a real pending send", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2030-01-01T00:00:00Z', 'pending_approval')"
  ).run(original, mkChannel("ig"));

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.code, "send_queued");
});

test("'failed' and 'canceled' publications do NOT block a split", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  const ch = mkChannel("ig");
  const ins = db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', ?)"
  );
  ins.run(original, ch, "failed");
  ins.run(original, ch, "canceled");

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true, "neither is live and neither is waiting to go out");
});

test("a dead publication stays on the ORIGINAL and is not copied to a child", async () => {
  const { q, db, mkAsset, mkChannel, mkCarousel } = await setup();
  const original = mkCarousel([mkAsset(1), mkAsset(2)]);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'failed')"
  ).run(original, mkChannel("ig"));

  const res = q.unmergeCarousel(original);
  assert.equal(res.ok, true);
  if (!res.ok) return;

  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM publications WHERE post_id = ?").get(original) as { c: number }).c,
    1,
    "the original keeps its own history"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM publications WHERE post_id = ?").get(res.post_ids[1]) as { c: number }).c,
    0,
    "a new post has never been sent anywhere"
  );
});

test("a missing post is 404", async () => {
  const { q } = await setup();
  const res = q.unmergeCarousel(999999);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.problem.status, 404);
});

test("a failure partway through child creation rolls back — the original keeps every slide", async () => {
  // unmergeCarousel destroys before it creates: it deletes ALL of the original's post_assets
  // rows and rebuilds slide 1 before the loop that inserts the children even starts. Every
  // other test here exercises the all-succeed path, so nothing pins the fact that a failure
  // during that loop actually rolls the destructive part back too. Today that holds only
  // because better-sqlite3's db.transaction() issues ROLLBACK when the wrapped function
  // throws — an invariant a future "skip a bad child" try/catch could silently break.
  const { q, db, mkAsset, mkCarousel } = await setup();
  const assets = [mkAsset(1), mkAsset(2), mkAsset(3), mkAsset(4)];
  const original = mkCarousel(assets);
  const before = db
    .prepare("SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order")
    .all(original);
  const postsBefore = (db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c;

  // Fires on the very first INSERT into posts — which is the first child the loop tries to
  // create — and aborts it. A TEMP trigger lives only on this connection, but every test in
  // this file shares that one connection (see the module comment at the top), so it must be
  // dropped before this test returns or it would blow up every later INSERT INTO posts.
  db.exec(
    "CREATE TEMP TRIGGER unmerge_boom AFTER INSERT ON posts BEGIN SELECT RAISE(ABORT, 'boom'); END;"
  );
  try {
    assert.throws(() => q.unmergeCarousel(original));
  } finally {
    db.exec("DROP TRIGGER unmerge_boom");
  }

  assert.deepEqual(
    db
      .prepare(
        "SELECT asset_id, sort_order FROM post_assets WHERE post_id = ? ORDER BY sort_order"
      )
      .all(original),
    before,
    "every slide is back, in its original sort_order — not just one"
  );
  assert.equal(
    q.getPost(original)?.post_type,
    "carousel",
    "the retype to the derived single/reel type was rolled back too"
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c,
    postsBefore,
    "no child post survived the rollback"
  );
});

test("the database has no broken references afterwards", async () => {
  const { q, db, mkAsset, mkChannel, mkTag } = await setup();
  const original = q.createDraftPost({
    caption: "fk",
    first_comment: "",
    asset_ids: [mkAsset(1), mkAsset(2), mkAsset(3)],
    post_type: "carousel",
    targets: [{ channel_id: mkChannel("ig"), surface: "feed" }],
    tag_ids: [mkTag("t")],
  });
  q.unmergeCarousel(original);

  assert.deepEqual(db.pragma("foreign_key_check"), [], "no dangling references");
});
