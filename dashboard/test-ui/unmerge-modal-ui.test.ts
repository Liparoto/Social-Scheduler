import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSummary } from "../components/unmerge-modal.tsx";

test("the summary names the number of posts that will result", () => {
  assert.match(splitSummary(5), /5 separate posts/);
});

test("the smallest real split is not pluralized wrong", () => {
  // Two slides is the minimum the guards allow, so "2 separate posts" is a real sentence a
  // user will see — and the singular form must never appear, since 1 is impossible.
  assert.match(splitSummary(2), /2 separate posts/);
});

test("the summary says the photos survive", () => {
  // The word this modal exists to make unmissable: nothing is deleted.
  assert.match(splitSummary(4), /no photos are deleted/i);
});

test("the summary says the original keeps the first photo", () => {
  assert.match(splitSummary(3), /first photo/i);
});
