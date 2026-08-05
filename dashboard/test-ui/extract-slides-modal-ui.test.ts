import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSummary } from "../components/extract-slides-modal.tsx";

test("with nothing ticked it asks you to pick", () => {
  assert.match(extractSummary(4, 0), /tick/i);
});

test("one photo out of four names both sides of the split", () => {
  const s = extractSummary(4, 1);
  assert.match(s, /1 photo/, "what leaves");
  assert.match(s, /1 new post/, "what it becomes");
  assert.match(s, /other 3 photos/, "what stays");
  assert.match(s, /stays a carousel/);
});

test("two photos out of four is pluralized on both sides", () => {
  const s = extractSummary(4, 2);
  assert.match(s, /2 photos/);
  assert.match(s, /2 new posts/);
  assert.match(s, /other 2 photos/);
});

test("leaving exactly one photo says the post becomes a single", () => {
  // The case the transaction has to retype, so the copy must not still say "carousel".
  const s = extractSummary(3, 2);
  assert.match(s, /remaining photo/);
  assert.match(s, /becomes a single/);
  assert.doesNotMatch(s, /stays a carousel/);
});

test("the smallest real extraction reads correctly", () => {
  // 2-slide carousel, pull 1: the remainder is a single.
  const s = extractSummary(2, 1);
  assert.match(s, /1 new post/);
  assert.match(s, /becomes a single/);
});
