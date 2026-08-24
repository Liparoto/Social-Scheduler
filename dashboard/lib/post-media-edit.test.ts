import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAddAssets,
  checkCanAddMedia,
  checkRemoveAsset,
  derivePostTypeFromKinds,
  LIVE_SEND_MESSAGE,
  type MediaEditContext,
  type Slide,
} from "./post-media-edit.ts";

const IG = { id: 1, platform: "instagram", account_name: "liparoto" };
/** No publications row and no cover reference — the ordinary case. */
const NO_REFS = { sends: 0, covers: 0 };

function img(id: number): Slide {
  return { asset_id: id, media_kind: "image" };
}
function vid(id: number): Slide {
  return { asset_id: id, media_kind: "video" };
}
function ctx(over: Partial<MediaEditContext> = {}): MediaEditContext {
  return {
    slides: [img(1), img(2)],
    postType: "carousel",
    hasLiveSend: false,
    channels: [IG],
    ...over,
  };
}

test("derivePostTypeFromKinds matches the rules the composer uses", () => {
  assert.equal(derivePostTypeFromKinds([]), "single");
  assert.equal(derivePostTypeFromKinds(["image"]), "single");
  assert.equal(derivePostTypeFromKinds(["video"]), "video");
  assert.equal(derivePostTypeFromKinds(["image", "image"]), "carousel");
});

test("adding an image to a single makes it a carousel", () => {
  const res = checkAddAssets(ctx({ slides: [img(1)] }), [img(9)], 0);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "carousel");
  assert.deepEqual(res.slides.map((s) => s.asset_id), [1, 9]);
});

test("adding nothing is a bad request", () => {
  const res = checkAddAssets(ctx(), [], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "bad_body");
  assert.equal(res.status, 400);
});

test("a live send blocks adding", () => {
  const res = checkAddAssets(ctx({ hasLiveSend: true }), [img(9)], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "live_send");
  assert.equal(res.status, 409);
});

test("a live send blocks removing", () => {
  const res = checkRemoveAsset(ctx({ hasLiveSend: true }), 1, "post", 0, 0, NO_REFS);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "live_send");
});

test("an asset already on the post is refused", () => {
  const res = checkAddAssets(ctx(), [img(2)], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "already_on_post");
});

test("a video cannot join a post that has other slides", () => {
  const res = checkAddAssets(ctx(), [vid(9)], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("nothing can join a post whose only slide is a video", () => {
  const res = checkAddAssets(ctx({ slides: [vid(1)] }), [img(9)], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("two videos at once are refused", () => {
  const res = checkAddAssets(ctx({ slides: [] }), [vid(8), vid(9)], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "video_mix");
});

test("the same asset listed twice in one request is refused", () => {
  const res = checkAddAssets(ctx({ slides: [img(1)] }), [img(9), img(9)], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "bad_body");
  assert.equal(res.status, 400);
});

test("a lone video on an empty post becomes a reel", () => {
  const res = checkAddAssets(ctx({ slides: [] }), [vid(9)], 0);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "video");
});

test("an 11th slide is refused with Instagram's real limit named", () => {
  const ten = Array.from({ length: 10 }, (_, i) => img(i + 1));
  const res = checkAddAssets(ctx({ slides: ten }), [img(99)], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "incompatible");
  assert.match(res.error, /at most 10/);
});

test("removing a slide from a carousel of two leaves a single", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 0, 0, NO_REFS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.post_type, "single");
  assert.deepEqual(res.slides.map((s) => s.asset_id), [1]);
});

test("the last slide cannot be removed", () => {
  const res = checkRemoveAsset(ctx({ slides: [img(1)] }), 1, "post", 0, 0, NO_REFS);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "last_slide");
});

test("removing a slide the post does not have is a 404", () => {
  const res = checkRemoveAsset(ctx(), 77, "post", 0, 0, NO_REFS);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_on_post");
  assert.equal(res.status, 404);
});

test("delete-entirely is refused when the asset is on other posts", () => {
  const res = checkRemoveAsset(ctx(), 2, "everywhere", 3, 0, NO_REFS);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "shared_asset");
  assert.equal(res.status, 409);
  assert.match(res.error, /3 other posts/);
});

test("remove-from-post is allowed even when the asset is shared", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 3, 0, NO_REFS);
  assert.equal(res.ok, true);
});

test("removing leaves a lone video as a reel, and re-checks video support", () => {
  const noVideo = { id: 2, platform: "threads", account_name: "t" };
  const res = checkRemoveAsset(
    { slides: [vid(1), img(2)], postType: "carousel", hasLiveSend: false, channels: [noVideo] },
    2,
    "post",
    0,
    0,
    NO_REFS
  );
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "incompatible");
});

test("a slide with a queued Story send is refused, in EITHER mode", () => {
  const post = checkRemoveAsset(ctx(), 2, "post", 0, 1, NO_REFS);
  assert.equal(post.ok, false);
  if (post.ok) return;
  assert.equal(post.code, "story_queued");
  assert.equal(post.status, 409);

  const everywhere = checkRemoveAsset(ctx(), 2, "everywhere", 0, 1, NO_REFS);
  assert.equal(everywhere.ok, false);
  if (everywhere.ok) return;
  assert.equal(everywhere.code, "story_queued");
});

test("a queued Story send on a DIFFERENT slide does not block this one", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 0, 0, NO_REFS);
  assert.equal(res.ok, true);
});

test("a post with a queued per-slide (Story) send refuses new slides", () => {
  const res = checkAddAssets(ctx(), [img(9)], 2);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "story_queued");
  assert.equal(res.status, 409);
  assert.match(res.error, /Cancel or hold/);
});

test("a queued FEED send does not block adding — it publishes whatever slides exist", () => {
  // countQueuedPerSlideSendsForPost() excludes asset_id IS NULL, so a feed send arrives
  // here as 0. Blocking on one would refuse an edit that is exactly what feed sends are for.
  const res = checkAddAssets(ctx(), [img(9)], 0);
  assert.equal(res.ok, true);
});

test("a text post cannot be turned into a media post", () => {
  const res = checkAddAssets(ctx({ slides: [], postType: "text" }), [img(9)], 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "text_post");
  assert.equal(res.status, 400);
});

test("delete-entirely is refused when a send of any status still names the asset", () => {
  const res = checkRemoveAsset(ctx(), 2, "everywhere", 0, 0, { sends: 1, covers: 0 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "referenced_asset");
  assert.equal(res.status, 409);
  assert.match(res.error, /Story send names the exact slide/);
  // The wording must NOT claim another post grabbed it — that was the false message.
  assert.doesNotMatch(res.error, /other post/);
});

test("delete-entirely is refused when the asset is some video's cover image", () => {
  const res = checkRemoveAsset(ctx(), 2, "everywhere", 0, 0, { sends: 0, covers: 1 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "referenced_asset");
  assert.match(res.error, /cover image/);
});

test("remove-from-post is allowed even when other references exist", () => {
  const res = checkRemoveAsset(ctx(), 2, "post", 0, 0, { sends: 4, covers: 2 });
  assert.equal(res.ok, true);
});

// ---- checkCanAddMedia: the pre-flight the strip runs BEFORE uploading a byte ----------
// The point of splitting these three rules out is that a refusal must not cost an
// orphaned conformed copy in /data. If any of them stopped being answerable from the post
// alone, or stopped matching what checkAddAssets says, the pre-flight would be lying.

test("checkCanAddMedia says yes for an ordinary editable post", () => {
  assert.deepEqual(checkCanAddMedia({ postType: "carousel", hasLiveSend: false }, 0), {
    ok: true,
  });
});

test("checkCanAddMedia refuses a live send, with the shared sentence", () => {
  const res = checkCanAddMedia({ postType: "carousel", hasLiveSend: true }, 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "live_send");
  assert.equal(res.status, 409);
  assert.equal(res.error, LIVE_SEND_MESSAGE);
});

test("checkCanAddMedia refuses a text post", () => {
  const res = checkCanAddMedia({ postType: "text", hasLiveSend: false }, 0);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "text_post");
  assert.equal(res.status, 400);
});

test("checkCanAddMedia refuses a post with a queued per-slide Story send", () => {
  const res = checkCanAddMedia({ postType: "carousel", hasLiveSend: false }, 1);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "story_queued");
  assert.equal(res.status, 409);
});

// The whole reason checkAddAssets delegates: the pre-flight's answer must be the SAME
// answer, worded identically, or the browser would show one refusal and the server another.
test("every rule the pre-flight knows gives checkAddAssets the identical refusal", () => {
  const cases: { postType: MediaEditContext["postType"]; hasLiveSend: boolean; queued: number }[] =
    [
      { postType: "carousel", hasLiveSend: true, queued: 0 },
      { postType: "text", hasLiveSend: false, queued: 0 },
      { postType: "carousel", hasLiveSend: false, queued: 2 },
    ];
  for (const c of cases) {
    const gate = checkCanAddMedia({ postType: c.postType, hasLiveSend: c.hasLiveSend }, c.queued);
    const full = checkAddAssets(
      ctx({ postType: c.postType, hasLiveSend: c.hasLiveSend, slides: [img(1)] }),
      [img(9)],
      c.queued
    );
    assert.equal(gate.ok, false);
    assert.equal(full.ok, false);
    if (gate.ok || full.ok) return;
    assert.equal(gate.code, full.code);
    assert.equal(gate.status, full.status);
    assert.equal(gate.error, full.error);
  }
});

// The rules that genuinely need the asset must NOT have migrated into the pre-flight —
// answering them without an asset id would mean guessing.
test("checkCanAddMedia does not pretend to judge the asset-dependent rules", () => {
  // A post that already holds a video: adding anything to it is a video_mix refusal, but
  // that is only knowable once you know what is being added.
  assert.deepEqual(checkCanAddMedia({ postType: "video", hasLiveSend: false }, 0), { ok: true });
  const full = checkAddAssets(ctx({ slides: [vid(1)], postType: "video" }), [img(9)], 0);
  assert.equal(full.ok, false);
  if (full.ok) return;
  assert.equal(full.code, "video_mix");
});
