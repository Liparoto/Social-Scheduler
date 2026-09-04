import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEED_MAX_RATIO,
  FEED_MIN_RATIO,
  feedRatio,
  feedShapesDisagree,
} from "./feed-geometry.ts";

test("a source already inside the feed's range keeps its own shape", () => {
  // 4:5 exactly — the portrait bound, and the most common Instagram shape.
  assert.equal(feedRatio(1080, 1350), FEED_MIN_RATIO);
  // Square, comfortably inside.
  assert.equal(feedRatio(1000, 1000), 1);
  // 4:3 phone landscape (4032x3024) — inside, so untouched.
  assert.equal(feedRatio(4032, 3024), 4032 / 3024);
});

test("a source outside the range is clamped to the bound it overshot", () => {
  // Very tall (0.5, a 9:16-ish shot) conforms up to the portrait bound.
  assert.equal(feedRatio(1000, 2000), FEED_MIN_RATIO);
  // Very wide (3.0, a panorama) conforms down to the landscape bound.
  assert.equal(feedRatio(3000, 1000), FEED_MAX_RATIO);
});

test("the bounds themselves are in range, not clamped past", () => {
  assert.equal(feedRatio(191, 100), FEED_MAX_RATIO);
  assert.equal(feedRatio(800, 1000), FEED_MIN_RATIO);
});

test("missing dimensions return null rather than NaN or a wrong guess", () => {
  // An asset row whose width/height were never recorded must not silently
  // produce a frame shape — the caller has to fall back to measuring.
  assert.equal(feedRatio(null, null), null);
  assert.equal(feedRatio(0, 0), null);
  assert.equal(feedRatio(1000, 0), null);
});

test("slides of the same shape do not raise a mismatch", () => {
  assert.equal(feedShapesDisagree([]), false);
  assert.equal(feedShapesDisagree([0.8]), false);
  assert.equal(feedShapesDisagree([0.8, 0.8, 0.8]), false);
});

test("slides of genuinely different shapes raise a mismatch", () => {
  // A portrait and a landscape in one carousel — the case worth being told about.
  assert.equal(feedShapesDisagree([FEED_MIN_RATIO, FEED_MAX_RATIO]), true);
  assert.equal(feedShapesDisagree([0.8, 0.8, 1.0]), true);
});

test("imperceptibly different shapes do not raise a mismatch", () => {
  // Rounding to whole pixels moves a ratio slightly; that is not a shape change
  // and must not produce a warning the owner cannot act on.
  assert.equal(feedShapesDisagree([0.8, 0.801]), false);
  assert.equal(feedShapesDisagree([1440 / 1800, 1439 / 1799]), false);
});

test("unknown shapes are ignored rather than counted as different", () => {
  // A video slide, or an asset with no recorded dimensions, contributes nothing.
  assert.equal(feedShapesDisagree([0.8, null, 0.8]), false);
  assert.equal(feedShapesDisagree([null, null]), false);
});
