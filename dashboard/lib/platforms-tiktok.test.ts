import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLATFORMS,
  captionLimit,
  incompatiblePostError,
  isPlatform,
  platformBadge,
  platformLabel,
  supportsImages,
  supportsMetrics,
  supportsText,
  supportsVideo,
} from "./platforms";

test("tiktok is a known platform with its own label and badge", () => {
  assert.ok(isPlatform("tiktok"));
  assert.equal(platformLabel("tiktok"), "TikTok");
  assert.equal(platformBadge("tiktok"), "TT");
});

test("tiktok takes video and refuses images and text", () => {
  assert.equal(supportsVideo("tiktok"), true);
  assert.equal(supportsImages("tiktok"), false);
  assert.equal(supportsText("tiktok"), false);
});

test("every other platform still accepts images", () => {
  for (const p of PLATFORMS) {
    if (p.value !== "tiktok") {
      assert.equal(supportsImages(p.value), true, `${p.value} lost image support`);
    }
  }
});

test("an unknown platform is assumed to accept images", () => {
  // The safe direction here is the opposite of supportsVideo's: worst case the composer
  // offers an image post to something that refuses it, rather than hiding image posting
  // from a platform that supports it — which is nearly all of them.
  assert.equal(supportsImages("myspace"), true);
});

test("tiktok enforces no caption limit because it sends no caption", () => {
  assert.equal(captionLimit("tiktok", "reel"), null);
});

test("an image post targeted at tiktok is refused, naming the channel", () => {
  const err = incompatiblePostError("single", 1, [
    { id: 1, platform: "tiktok", account_name: "Liparoto" },
  ]);
  assert.match(err ?? "", /Liparoto \(TikTok\)/);
  assert.match(err ?? "", /video only/i);
});

test("a carousel targeted at tiktok is refused as images, not as too many images", () => {
  // The reason matters: "at most 0 images per carousel" would be a nonsense message.
  const err = incompatiblePostError("carousel", 3, [
    { id: 1, platform: "tiktok", account_name: "Liparoto" },
  ]);
  assert.match(err ?? "", /video only/i);
  assert.doesNotMatch(err ?? "", /at most/i);
});

test("a reel targeted at tiktok is allowed", () => {
  assert.equal(
    incompatiblePostError("reel", 1, [{ id: 1, platform: "tiktok", account_name: "L" }]),
    null,
  );
});

test("a text post targeted at tiktok is still refused as text", () => {
  const err = incompatiblePostError("text", 0, [
    { id: 1, platform: "tiktok", account_name: "L" },
  ]);
  assert.match(err ?? "", /text post/i);
});

test("tiktok reports metrics as a platform capability", () => {
  // supportsMetrics stays true: TikTok DOES have a metrics API. Whether a given send has
  // numbers yet is a per-send question answered by delivery_state, not by the platform.
  assert.equal(supportsMetrics("tiktok"), true);
});

test("an image post to every other platform is still allowed", () => {
  for (const p of PLATFORMS) {
    if (p.value === "tiktok") continue;
    assert.equal(
      incompatiblePostError("single", 1, [{ id: 1, platform: p.value, account_name: "x" }]),
      null,
      `${p.value} started refusing image posts`,
    );
  }
});
