import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// A Story is a DESTINATION, not a post type (docs/design-instagram-stories.md). These
// tests are about post_targets.surface and the fan-out into one publication per slide.

let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  const prefix = `s${++setupSeq}`;

  const ig = q.createChannel({
    platform: "instagram",
    account_name: `${prefix}-ig`,
    timezone: "America/Los_Angeles",
  } as Parameters<typeof q.createChannel>[0]);
  const telegram = q.createChannel({
    platform: "telegram",
    account_name: `${prefix}-tg`,
    timezone: "America/Los_Angeles",
  } as Parameters<typeof q.createChannel>[0]);

  const assetIds = [0, 1, 2].map((n) =>
    Number(
      db
        .prepare(
          "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)",
        )
        .run(`${prefix}-h${n}`, `a/${prefix}-${n}.jpg`).lastInsertRowid,
    ),
  );

  const pubs = (postId: number) =>
    db
      .prepare("SELECT surface, asset_id FROM publications WHERE post_id = ? ORDER BY id ASC")
      .all(postId) as { surface: string; asset_id: number | null }[];

  return { q, db, ig, telegram, assetIds, pubs };
}

test("a story target fans out into one publication per slide, in slide order", async () => {
  const { q, ig, assetIds, pubs } = await setup();
  const { postId } = q.createPostWithPublications({
    caption: "hi",
    first_comment: "",
    post_type: "carousel",
    asset_ids: assetIds,
    scheduled_at: "2026-08-10T18:00:00.000Z",
    targets: [{ channel_id: ig, surface: "story" }],
  } as Parameters<typeof q.createPostWithPublications>[0]);

  const rows = pubs(postId);
  assert.equal(rows.length, 3, "3 slides -> 3 Stories");
  assert.deepEqual(
    rows.map((r) => r.surface),
    ["story", "story", "story"],
  );
  assert.deepEqual(
    rows.map((r) => r.asset_id),
    assetIds,
    "slides must be created in sort_order — ascending id IS publish order",
  );
});

test("a feed target stays one publication with a null asset_id", async () => {
  const { q, ig, assetIds, pubs } = await setup();
  const { postId } = q.createPostWithPublications({
    caption: "hi",
    first_comment: "",
    post_type: "carousel",
    asset_ids: assetIds,
    scheduled_at: "2026-08-10T18:00:00.000Z",
    targets: [{ channel_id: ig, surface: "feed" }],
  } as Parameters<typeof q.createPostWithPublications>[0]);

  const rows = pubs(postId);
  assert.equal(rows.length, 1, "a feed carousel is ONE post, not one per slide");
  assert.equal(rows[0].asset_id, null, "null means ALL assets, in order");
});

test("feed and story on one channel produce independent sends", async () => {
  const { q, ig, telegram, assetIds, pubs } = await setup();
  const { postId } = q.createPostWithPublications({
    caption: "hi",
    first_comment: "",
    post_type: "carousel",
    asset_ids: assetIds.slice(0, 2),
    scheduled_at: "2026-08-10T18:00:00.000Z",
    targets: [
      { channel_id: ig, surface: "feed" },
      { channel_id: ig, surface: "story" },
      { channel_id: telegram, surface: "feed" },
    ],
  } as Parameters<typeof q.createPostWithPublications>[0]);

  const rows = pubs(postId);
  assert.equal(rows.filter((r) => r.surface === "feed").length, 2, "IG feed + Telegram");
  assert.equal(rows.filter((r) => r.surface === "story").length, 2, "2 slides -> 2 Stories");
});

test("targets round-trip with their surface", async () => {
  const { q, ig, telegram, assetIds } = await setup();
  const postId = q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
  });

  q.setPostTargets(postId, [
    { channel_id: ig, surface: "story" },
    { channel_id: ig, surface: "feed" },
    { channel_id: telegram, surface: "feed" },
  ]);

  assert.deepEqual(q.getPostTargets(postId), [
    { channel_id: ig, surface: "feed" },
    { channel_id: ig, surface: "story" },
    { channel_id: telegram, surface: "feed" },
  ]);
});

test("removing one surface leaves the other in place", async () => {
  const { q, ig, assetIds } = await setup();
  const postId = q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
  });

  q.setPostTargets(postId, [
    { channel_id: ig, surface: "feed" },
    { channel_id: ig, surface: "story" },
  ]);
  q.setPostTargets(postId, [{ channel_id: ig, surface: "story" }]);

  assert.deepEqual(q.getPostTargets(postId), [{ channel_id: ig, surface: "story" }]);
});
