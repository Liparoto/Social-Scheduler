import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

makeTestDb();
const q = await import("./queries.ts");
const db = (await import("./db.ts")).getDb();

/*
  post_type derivation when the caller does not state one.

  Asset COUNT alone was the old rule, and it made a lone video a "single". /api/posts/draft
  had already worked around that by passing post_type explicitly, but createDraftPostsBulk
  does not — so a bulk-imported video reached the database as a post the publisher cannot
  send as a Reel.
*/

let seq = 0;

function asset(mediaKind: "image" | "video"): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO assets (content_hash, media_kind, original_filename, storage_path,
                             mime_type)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        `hash-${seq}`,
        mediaKind,
        `file-${seq}.${mediaKind === "video" ? "mp4" : "jpg"}`,
        `store/${seq}`,
        mediaKind === "video" ? "video/mp4" : "image/jpeg"
      ).lastInsertRowid
  );
}

function postTypeOf(postId: number): string {
  return (
    db.prepare("SELECT post_type FROM posts WHERE id = ?").get(postId) as {
      post_type: string;
    }
  ).post_type;
}

function draft(assetIds: number[], postType?: string): number {
  return q.createDraftPost({
    caption: `derive-${++seq}`,
    first_comment: "",
    asset_ids: assetIds,
    ...(postType ? { post_type: postType as never } : {}),
  });
}

test("a lone video becomes a reel, not a single", () => {
  assert.equal(postTypeOf(draft([asset("video")])), "reel");
});

test("a lone image is still a single", () => {
  assert.equal(postTypeOf(draft([asset("image")])), "single");
});

test("several assets are still a carousel", () => {
  assert.equal(postTypeOf(draft([asset("image"), asset("image")])), "carousel");
});

test("a carousel containing a video is still a carousel", () => {
  // Instagram carousels may hold video children; more than one asset means carousel
  // whatever the media kinds are.
  assert.equal(postTypeOf(draft([asset("image"), asset("video")])), "carousel");
});

test("an explicit post_type always wins over the derivation", () => {
  // /api/posts/draft passes 'text' and 'reel' explicitly; the derivation must never
  // second-guess a caller that stated its intent.
  assert.equal(postTypeOf(draft([asset("video")], "single")), "single");
  assert.equal(postTypeOf(draft([], "text")), "text");
});

test("no assets still derives single", () => {
  // Left deliberately unchanged: a text post always states its type, so a draft that
  // reaches here with no assets is incomplete, and retyping it is a separate decision.
  assert.equal(postTypeOf(draft([])), "single");
});

test("bulk import gives a video the right type without being told", () => {
  // The path that actually carried the bug — it passes no post_type at all.
  const videoAsset = asset("video");
  const imageAsset = asset("image");

  const ids = q.createDraftPostsBulk(
    [
      { asset_id: videoAsset, caption: "a clip" },
      { asset_id: imageAsset, caption: "a photo" },
    ],
    { targets: [], content_kind: "evergreen", content_status: "ready" } as never
  );

  assert.equal(postTypeOf(ids[0]), "reel");
  assert.equal(postTypeOf(ids[1]), "single");
});
