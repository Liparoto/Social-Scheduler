import { test } from "node:test";
import assert from "node:assert/strict";
import { limitsFor, checkMedia, anyDestinationAccepts, type PlatformsData } from "./media-limits.ts";
import matrix from "./media-limits-matrix.json" with { type: "json" };

test("facebook reel limits load from the shared file", () => {
  const lim = limitsFor("facebook", "reel", "video");
  assert.equal(lim?.min_duration_ms, 3000);
  assert.equal(lim?.max_duration_ms, 90000);
});

test("an unknown platform has no limits — absent means NOT ENFORCED", () => {
  assert.equal(limitsFor("myspace", "feed", "video"), null);
});

test("unknown metadata never refuses", () => {
  const asset = { media_kind: "video", duration_ms: null, width: null, height: null };
  assert.deepEqual(checkMedia("facebook", "reel", asset), []);
});

// The whole point of the shared file: this matrix is the SAME file the Python side
// reads in test_media_limits_agreement.py. A case added here is covered on both sides.
for (const [i, c] of matrix.cases.entries()) {
  test(`matrix case ${i}: ${c.platform}/${c.surface}`, () => {
    const got = checkMedia(c.platform, c.surface, c.asset).map((v) => v.kind).sort();
    assert.deepEqual(got, [...c.expect].sort());
  });
}

// ---- anyDestinationAccepts ---------------------------------------------------------
//
// Two DIFFERENT tests, proving two different things (see anyDestinationAccepts's own
// comment in media-limits.ts for the full reasoning):
//
// 1. Against REAL data (dashboard/media-limits.json, via the function's default `data`
//    argument): an 18-minute video is accepted, because it's under Facebook's 20-minute
//    feed cap even though it's over Instagram's 15-minute cap. This pins the owner-visible
//    behaviour this task exists to fix.
//
// 2. Against INJECTED, synthetic data: a 30-minute video IS refused, once every
//    video-capable destination (instagram, facebook, tiktok — the only platforms with a
//    non-empty videoSurfaces()) is given a known, low duration cap. This proves the
//    refusal branch actually works. It can't be proven against real data: TikTok can
//    publish video and has no recorded limits at all (they're fetched per-creator at
//    runtime), so against real data anyDestinationAccepts never refuses ANY video
//    duration on this install — see the long comment on the function for why that's the
//    correct behaviour, not a bug, and why a test asserting "a 30-minute video is refused"
//    against real data would be asserting something false.

test("an 18-minute video uploads — over Instagram's 15-minute cap, under Facebook feed's 20-minute cap [real data]", () => {
  const asset = { media_kind: "video", duration_ms: 18 * 60 * 1000, width: 1920, height: 1080 };
  assert.equal(anyDestinationAccepts(asset), true);
});

test("REFUSAL BRANCH (synthetic data): a 30-minute video is refused once every video-capable destination has a known, low cap", () => {
  // Every platform with a non-empty videoSurfaces() (instagram, facebook, tiktok) gets an
  // explicit, low max_duration_ms on every one of its video surfaces. Real data can never
  // produce this outcome (see the comment above) — this is the synthetic stand-in that
  // proves anyDestinationAccepts's refusal branch is reachable and correct when a
  // destination's limits ARE known.
  const stub: PlatformsData = {
    instagram: {
      feed: { video: { max_duration_ms: 15 * 60 * 1000, note: "stub" } },
      story: { video: { max_duration_ms: 60 * 1000, note: "stub" } },
    },
    facebook: {
      feed: { video: { max_duration_ms: 20 * 60 * 1000, note: "stub" } },
      reel: { video: { max_duration_ms: 90 * 1000, note: "stub" } },
    },
    tiktok: {
      feed: { video: { max_duration_ms: 5 * 60 * 1000, note: "stub" } },
    },
  };
  const asset = { media_kind: "video", duration_ms: 30 * 60 * 1000, width: 1920, height: 1080 };
  assert.equal(anyDestinationAccepts(asset, stub), false);
});

test("REFUSAL BRANCH (synthetic data): a video under every stub cap is accepted", () => {
  // Sanity check on the stub itself — proves the low caps above don't refuse everything
  // unconditionally (which would make the refusal test above vacuous).
  const stub: PlatformsData = {
    instagram: { feed: { video: { max_duration_ms: 15 * 60 * 1000, note: "stub" } } },
  };
  const asset = { media_kind: "video", duration_ms: 60 * 1000, width: 1080, height: 1920 };
  assert.equal(anyDestinationAccepts(asset, stub), true);
});
