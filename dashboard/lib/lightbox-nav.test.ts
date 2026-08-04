import { test } from "node:test";
import assert from "node:assert/strict";
import { stepIndex } from "./lightbox-nav.ts";

test("stepping moves one slide at a time in both directions", () => {
  assert.equal(stepIndex(0, 1, 5), 1);
  assert.equal(stepIndex(3, 1, 5), 4);
  assert.equal(stepIndex(3, -1, 5), 2);
});

test("the ends clamp rather than wrap — a carousel has a start and an end", () => {
  assert.equal(stepIndex(0, -1, 5), 0);
  assert.equal(stepIndex(4, 1, 5), 4);
});

test("a single slide never moves", () => {
  assert.equal(stepIndex(0, 1, 1), 0);
  assert.equal(stepIndex(0, -1, 1), 0);
});

test("degenerate inputs return a usable index instead of NaN or -1", () => {
  assert.equal(stepIndex(0, 1, 0), 0);
  assert.equal(stepIndex(9, -1, 0), 0);
  // An index left over from a longer list (the post lost a slide under us).
  assert.equal(stepIndex(9, 1, 3), 2);
  assert.equal(stepIndex(-4, 1, 3), 0);
});
