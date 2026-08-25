import { test } from "node:test";
import assert from "node:assert/strict";
import {
  limitsFor, checkMedia, anyDestinationAccepts, needsConformedDerivative, type PlatformsData,
} from "./media-limits.ts";
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

test("REGRESSION GUARD (real data): a 3-hour video is still accepted — proves platforms are enumerated from PLATFORMS (capability), not from the JSON's own keys", () => {
  // This is NOT really a test about 3-hour videos. Every platform that has ANY recorded
  // video limit refuses this outright — Instagram at 15 minutes, Facebook at 20 — so this
  // asset is accepted ONLY because TikTok is walked as a candidate destination even though
  // it has NO key at all in dashboard/media-limits.json (its limits are per-creator,
  // fetched at runtime — see anyDestinationAccepts's comment). anyDestinationAccepts
  // enumerates candidates from lib/platforms.ts's PLATFORMS list, gated by
  // videoSurfaces()/supportsImages(), specifically SO THAT a platform with no JSON entry
  // (TikTok) still gets asked. If that loop were "simplified" back to
  // Object.keys(raw.platforms) — walking only platforms the JSON happens to mention —
  // TikTok would silently drop out of the union and this assertion would flip to `false`.
  // Neither of the other two tests above would catch that regression: the 18-minute case
  // is decided by Facebook alone (TikTok irrelevant), and the synthetic 30-minute stub
  // deliberately gives TikTok its own key, so JSON-key iteration and PLATFORMS iteration
  // agree on it. This is the one case where they diverge. Do not delete this as a
  // redundant/silly edge case — it is the only regression guard for that specific,
  // previously-reviewed design decision.
  const asset = { media_kind: "video", duration_ms: 3 * 60 * 60 * 1000, width: 1920, height: 1080 };
  assert.equal(anyDestinationAccepts(asset), true);
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

// ---- needsConformedDerivative -------------------------------------------------------
//
// Three cases, matching the ones reasoned through before this task was dispatched:
//
// 1. An 18-minute clip fails BOTH conform-requiring destinations (Instagram feed,
//    Facebook Reels) for `too_long` — a duration problem, which no re-encode can fix
//    (this app never trims footage). No derivative is worth building.
// 2. A 30-second 4K VERTICAL clip (2160x3840) is refused by Instagram's feed only for
//    being `too_large` (width 2160 > max_width 1920) — exactly what downscaling fixes —
//    and is accepted outright by Facebook Reels (540x960 min, 9:16..16:9 inclusive, and
//    2160:3840 is exactly 9:16). This is the case an "accepts it AS-IS" predicate gets
//    wrong: the everyday 4K-shooting-iPhone case this pipeline exists for.
// 3. A 30-second 1080x1920 clip is accepted outright by both — trivially worth building.

test("an 18-minute video gets no conformed derivative — too_long isn't fixable by conversion", () => {
  const asset = { media_kind: "video", duration_ms: 18 * 60 * 1000, width: 3840, height: 2160 };
  assert.equal(needsConformedDerivative(asset), false);
});

test("a 30-second 4K vertical clip still gets one — its only refusal (too_large/width) IS fixable", () => {
  const asset = { media_kind: "video", duration_ms: 30_000, width: 2160, height: 3840 };
  assert.equal(needsConformedDerivative(asset), true);
});

test("a 30-second 1080x1920 clip gets one — accepted outright by both conform-requiring destinations", () => {
  const asset = { media_kind: "video", duration_ms: 30_000, width: 1080, height: 1920 };
  assert.equal(needsConformedDerivative(asset), true);
});

test("a video refused only by a non-conform-requiring surface (Instagram story) still gets a derivative", () => {
  // instagram/story is deliberately excluded from CONFORM_REQUIRING (nothing consumes
  // the feed-shaped derivative there — see the function's comment) — a 61-second clip
  // busts story's 60s cap but is well within Instagram feed's 15-minute cap and Facebook
  // Reels' shape, so this must stay true regardless of what story thinks.
  const asset = { media_kind: "video", duration_ms: 61_000, width: 1080, height: 1920 };
  assert.equal(needsConformedDerivative(asset), true);
});

// The two cases above (2160x3840 4K vertical, and the 61s story-only refusal) both pass
// whether or not the corrections behind this function were actually applied: the 4K case
// is accepted OUTRIGHT by facebook/reel (that entry has no max_width/max_height, only
// minimums), so a WRONG "accepts as-is" predicate returns true too — Instagram's
// "accepts after conversion" path is never exercised. And the 61s case is accepted
// outright by instagram/feed alone, so it passes whether instagram/story is correctly
// excluded from CONFORM_REQUIRING or wrongly re-added. Both tests below exist
// specifically to close those two gaps — do not read them as arbitrary and delete them.

test("DISCRIMINATING CASE: a 120s 2560x1440 clip needs the 'accepts AFTER conversion' predicate, not 'accepts as-is'", () => {
  // instagram/feed: duration 120s is well under its 15-minute cap, but width 2560 >
  // max_width 1920 — refused ONLY for too_large, which downscaling fixes. So this
  // destination counts as "worth converting for" under the corrected predicate.
  // facebook/reel: duration 120s > its 90s cap — refused for too_long, NOT fixable by
  // any re-encode (width/height/aspect are all in range: 2560x1440 is exactly 16:9,
  // the inclusive upper edge of facebook/reel's aspect band). So this destination alone
  // could never justify building a derivative.
  // A correct predicate returns true (instagram/feed alone is enough). A predicate that
  // asks "does some conform-requiring destination accept this AS-IS" (the brief's
  // original, backward version) returns false here — neither destination accepts the
  // asset unconverted. The two predicates finally disagree on this input, which is why
  // it's the regression guard for correction 2, not the 4K-vertical case above.
  const asset = { media_kind: "video", duration_ms: 120_000, width: 2560, height: 1440 };
  assert.equal(needsConformedDerivative(asset), true);
});

test("DISCRIMINATING CASE (synthetic data): instagram/story must stay excluded from CONFORM_REQUIRING", () => {
  // Stub where BOTH conform-requiring destinations (instagram/feed, facebook/reel)
  // refuse the asset non-fixably (too_long, low caps), but instagram/story — which is
  // NOT conform-requiring, because _resolve_rel never reads the feed-shaped derivative
  // for stories — would happily accept it (a generous cap). With the correct
  // CONFORM_REQUIRING list this must be false: story's willingness to accept is
  // irrelevant to whether building the derivative is worth it. If instagram/story were
  // ever mistakenly added back to CONFORM_REQUIRING, this flips to true, which is
  // exactly the regression this test exists to catch.
  const stub: PlatformsData = {
    instagram: {
      feed: { video: { max_duration_ms: 10_000, note: "stub: low cap, non-fixable refusal" } },
      story: { video: { max_duration_ms: 999_999, note: "stub: generous cap — would accept" } },
    },
    facebook: {
      reel: { video: { max_duration_ms: 10_000, note: "stub: low cap, non-fixable refusal" } },
    },
  };
  const asset = { media_kind: "video", duration_ms: 20_000, width: 1080, height: 1920 };
  assert.equal(needsConformedDerivative(asset, stub), false);
});
