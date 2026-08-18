import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAddAssets,
  checkRemoveAsset,
  derivePostTypeFromKinds,
  type MediaEditContext,
  type Slide,
} from "./post-media-edit.ts";

const IG = { id: 1, platform: "instagram", account_name: "liparoto" };

function img(id: number): Slide {
  return { asset_id: id, media_kind: "image" };
}
function vid(id: number): Slide {
  return { asset_id: id, media_kind: "video" };
}
function ctx(over: Partial<MediaEditContext> = {}): MediaEditContext {
  return { slides: [img(1), img(2)], hasLiveSend: false, channels: [IG], ...over };
}

test("derivePostTypeFromKinds matches the rules the composer uses", () => {
  assert.equal(derivePostTypeFromKinds([]), "single");
  assert.equal(derivePostTypeFromKinds(["image"]), "single");
  assert.equal(derivePostTypeFromKinds(["video"]), "reel");
  assert.equal(derivePostTypeFromKinds(["image", "image"]), "carousel");
});

test("adding an image to a single makes it a carousel", () => {
  const res = checkAddAssets(ctx({ slides: [img(1)] }), [img(9)]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "carousel");
  assert.deepEqual(res.slides.map((s) => s.asset_id), [1, 9]);
});

test("adding nothing is a bad request", () => {
  const res = checkAddAssets(ctx(), []);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "bad_body");
  assert.equal(res.status, 400);
});

test("a live send blocks adding", () => {
  const res = checkAddAssets(ctx({ hasLiveSend: true }), [img(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "live_send");
  assert.equal(res.status, 409);
});

test("a live send blocks removing", () => {
  const res = checkRemoveAsset(ctx({ hasLiveSend: true }), 1, "post", 0, 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "live_send");
});

test("an asset already on the post is refused", () => {
  const res = checkAddAssets(ctx(), [img(2)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "already_on_post");
});

test("a video cannot join a post that has other slides", () => {
  const res = checkAddAssets(ctx(), [vid(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("nothing can join a post whose only slide is a video", () => {
  const res = checkAddAssets(ctx({ slides: [vid(1)] }), [img(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("two videos at once are refused", () => {
  const res = checkAddAssets(ctx({ slides: [] }), [vid(8), vid(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("the same asset listed twice in one request is refused", () => {
  const res = checkAddAssets(ctx({ slides: [img(1)] }), [img(9), img(9)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "bad_body");
  assert.equal(res.status, 400);
});

test("a lone video on an empty post becomes a reel", () => {
  const res = checkAddAssets(ctx({ slides: [] }), [vid(9)]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "reel");
});

test("an 11th slide is refused with Instagram's real limit named", () => {
  const ten = Array.from({ length: 10 }, (_, i) => img(i + 1));
  const res = checkAddAssets(ctx({ slides: ten }), [img(99)]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "incompatible");
  assert.match(res.error, /at most 10/);
});

test("removing a slide from a carousel of two leaves a single", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 0, 0);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "single");
  assert.deepEqual(res.slides.map((s) => s.asset_id), [1]);
});

test("the last slide cannot be removed", () => {
  const res = checkRemoveAsset(ctx({ slides: [img(1)] }), 1, "post", 0, 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "last_slide");
});

test("removing a slide the post does not have is a 404", () => {
  const res = checkRemoveAsset(ctx(), 77, "post", 0, 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_on_post");
  assert.equal(res.status, 404);
});

test("delete-entirely is refused when the asset is on other posts", () => {
  const res = checkRemoveAsset(ctx(), 2, "everywhere", 3, 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "shared_asset");
  assert.equal(res.status, 409);
  assert.match(res.error, /3 other posts/);
});

test("remove-from-post is allowed even when the asset is shared", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 3, 0);
  assert.equal(res.ok, true);
});

test("removing leaves a lone video as a reel, and re-checks video support", () => {
  const noVideo = { id: 2, platform: "threads", account_name: "t" };
  const res = checkRemoveAsset(
    { slides: [vid(1), img(2)], hasLiveSend: false, channels: [noVideo] },
    2,
    "post",
    0,
    0
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "incompatible");
});

test("a slide with a queued Story send is refused, in EITHER mode", () => {
  const post = checkRemoveAsset(ctx(), 2, "post", 0, 1);
  assert.equal(post.ok, false);
  if (post.ok) return;
  assert.equal(post.code, "story_queued");
  assert.equal(post.status, 409);

  const everywhere = checkRemoveAsset(ctx(), 2, "everywhere", 0, 1);
  assert.equal(everywhere.ok, false);
  if (everywhere.ok) return;
  assert.equal(everywhere.code, "story_queued");
});

test("a queued Story send on a DIFFERENT slide does not block this one", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 0, 0);
  assert.equal(res.ok, true);
});
