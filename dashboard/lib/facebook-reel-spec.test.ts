import { test } from "node:test";
import assert from "node:assert/strict";
import {
  facebookReelDisabledReason,
  FB_REEL_MIN_DURATION_MS,
  FB_REEL_MAX_DURATION_MS,
  FB_REEL_MIN_WIDTH,
  FB_REEL_MIN_HEIGHT,
} from "./facebook-reel-spec.ts";

// A 1080x1920 (9:16) clip sitting comfortably inside every limit — the baseline every
// boundary test below perturbs exactly one dimension of.
const inSpec = { width: 1080, height: 1920, duration_ms: 10_000 };

test("an in-spec vertical clip is not disabled", () => {
  assert.equal(facebookReelDisabledReason(inSpec), null);
});

// ---- Duration ---------------------------------------------------------------------
test("under the minimum duration is disabled, with the actual and the minimum shown", () => {
  const reason = facebookReelDisabledReason({ ...inSpec, duration_ms: 2_000 });
  assert.match(String(reason), /Too short for Reels/);
  assert.match(String(reason), /2\.0s/);
  assert.match(String(reason), /3\.0s/);
});

test("over the maximum duration is disabled, with the actual and the maximum shown", () => {
  const reason = facebookReelDisabledReason({ ...inSpec, duration_ms: 20 * 60 * 1000 });
  assert.match(String(reason), /Too long for Reels/);
  assert.match(String(reason), /20m00s/);
  assert.match(String(reason), /1m30s/);
});

test("exactly the minimum duration (3000ms) is NOT disabled — inclusive boundary", () => {
  assert.equal(facebookReelDisabledReason({ ...inSpec, duration_ms: FB_REEL_MIN_DURATION_MS }), null);
});

test("exactly the maximum duration (90000ms) is NOT disabled — inclusive boundary", () => {
  assert.equal(facebookReelDisabledReason({ ...inSpec, duration_ms: FB_REEL_MAX_DURATION_MS }), null);
});

test("one millisecond under the minimum IS disabled", () => {
  assert.notEqual(
    facebookReelDisabledReason({ ...inSpec, duration_ms: FB_REEL_MIN_DURATION_MS - 1 }),
    null,
  );
});

test("one millisecond over the maximum IS disabled", () => {
  assert.notEqual(
    facebookReelDisabledReason({ ...inSpec, duration_ms: FB_REEL_MAX_DURATION_MS + 1 }),
    null,
  );
});

// ---- Resolution ---------------------------------------------------------------------
test("below the minimum resolution is disabled, with both sizes shown", () => {
  const reason = facebookReelDisabledReason({ ...inSpec, width: 480, height: 640 });
  assert.match(String(reason), /Too small for Reels/);
  assert.match(String(reason), /480×640/);
  assert.match(String(reason), /540×960/);
});

test("exactly the minimum resolution (540x960) is NOT disabled — inclusive boundary", () => {
  assert.equal(
    facebookReelDisabledReason({ ...inSpec, width: FB_REEL_MIN_WIDTH, height: FB_REEL_MIN_HEIGHT }),
    null,
  );
});

test("one pixel short on width IS disabled", () => {
  assert.notEqual(
    facebookReelDisabledReason({ ...inSpec, width: FB_REEL_MIN_WIDTH - 1, height: FB_REEL_MIN_HEIGHT }),
    null,
  );
});

test("one pixel short on height IS disabled", () => {
  assert.notEqual(
    facebookReelDisabledReason({ ...inSpec, width: FB_REEL_MIN_WIDTH, height: FB_REEL_MIN_HEIGHT - 1 }),
    null,
  );
});

// ---- Aspect ratio ---------------------------------------------------------------------
test("an ultrawide 21:9 clip is disabled as the wrong shape", () => {
  const reason = facebookReelDisabledReason({ width: 2520, height: 1080, duration_ms: 10_000 });
  assert.match(String(reason), /Wrong shape for Reels/);
  assert.match(String(reason), /2520×1080/);
});

test("exactly 16:9 landscape (1920x1080) is NOT disabled — the permitted boundary", () => {
  assert.equal(
    facebookReelDisabledReason({ width: 1920, height: 1080, duration_ms: 10_000 }),
    null,
  );
});

test("exactly 9:16 portrait is NOT disabled", () => {
  assert.equal(
    facebookReelDisabledReason({ width: 1080, height: 1920, duration_ms: 10_000 }),
    null,
  );
});

test("a resolution failure is reported before an aspect-ratio failure", () => {
  // 480x640 is both below the minimum size AND outside 9:16..16:9 (0.75 ratio is fine
  // actually — pick dimensions that are small AND a bad shape to pin precedence).
  const reason = facebookReelDisabledReason({ width: 400, height: 2000, duration_ms: 10_000 });
  assert.match(String(reason), /Too small for Reels/);
});

// ---- Unknown values must never disable ------------------------------------------------
test("a null duration does not disable, even with everything else fine", () => {
  assert.equal(facebookReelDisabledReason({ width: 1080, height: 1920, duration_ms: null }), null);
});

test("an omitted duration_ms (undefined) does not disable", () => {
  assert.equal(facebookReelDisabledReason({ width: 1080, height: 1920 }), null);
});

test("a null width/height does not disable, even with a bad duration elsewhere fine", () => {
  assert.equal(
    facebookReelDisabledReason({ width: null, height: null, duration_ms: 10_000 }),
    null,
  );
});

test("every field unknown does not disable", () => {
  assert.equal(facebookReelDisabledReason({ width: null, height: null, duration_ms: null }), null);
});

test("a genuinely out-of-spec duration still disables even when width/height are unknown", () => {
  assert.notEqual(
    facebookReelDisabledReason({ width: null, height: null, duration_ms: 999_999 }),
    null,
  );
});

test("an undefined asset (no video at all) does not disable", () => {
  assert.equal(facebookReelDisabledReason(undefined), null);
});
