import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteBlockReasons, deleteBlockState, type UsageCounts } from "./media-delete-confirm.ts";

const NONE: UsageCounts = { otherPosts: 0, sends: 0, covers: 0 };

test("all three counts zero → no reasons, delete offered", () => {
  assert.deepEqual(deleteBlockReasons(NONE), []);
  const state = deleteBlockState(NONE, false);
  assert.equal(state.blocked, false);
  assert.equal(state.message, null);
});

test("otherPosts alone → exactly one reason, naming the post count", () => {
  const reasons = deleteBlockReasons({ ...NONE, otherPosts: 1 });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /post/);

  const many = deleteBlockReasons({ ...NONE, otherPosts: 3 });
  assert.equal(many.length, 1);
  assert.match(many[0], /3/);
  assert.match(many[0], /posts/);
});

test("sends alone → exactly one reason, naming a send", () => {
  const reasons = deleteBlockReasons({ ...NONE, sends: 1 });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /send/);
});

test("covers alone → exactly one reason, naming a Reel cover", () => {
  const reasons = deleteBlockReasons({ ...NONE, covers: 1 });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /Reel/);
  assert.match(reasons[0], /cover/);
});

test("more than one non-zero → all applicable reasons, sensibly worded", () => {
  const reasons = deleteBlockReasons({ otherPosts: 2, sends: 1, covers: 1 });
  assert.equal(reasons.length, 3);
  assert.match(reasons[0], /2 other posts/);
  assert.match(reasons[1], /send/);
  assert.match(reasons[2], /Reel/);

  const state = deleteBlockState({ otherPosts: 2, sends: 1, covers: 1 }, false);
  assert.equal(state.blocked, true);
  // The message names every reason, joined into one sentence — not just the first one.
  assert.match(state.message ?? "", /2 other posts/);
  assert.match(state.message ?? "", /send/);
  assert.match(state.message ?? "", /Reel/);
});

test("each single-reason case names ONLY that reason in the combined message", () => {
  const postsOnly = deleteBlockState({ ...NONE, otherPosts: 1 }, false).message ?? "";
  assert.doesNotMatch(postsOnly, /send/);
  assert.doesNotMatch(postsOnly, /Reel/);

  const sendsOnly = deleteBlockState({ ...NONE, sends: 1 }, false).message ?? "";
  assert.doesNotMatch(sendsOnly, /post/);
  assert.doesNotMatch(sendsOnly, /Reel/);

  const coversOnly = deleteBlockState({ ...NONE, covers: 1 }, false).message ?? "";
  assert.doesNotMatch(coversOnly, /post/);
  assert.doesNotMatch(coversOnly, /send/);
});

test("usage lookup still in flight (usage === null) → blocked, with a stated cause", () => {
  const state = deleteBlockState(null, false);
  assert.equal(state.blocked, true);
  assert.ok(state.message && state.message.length > 0);
  // Distinct wording from the error and from a reasons-based refusal, so the UI never shows
  // a dead button with no explanation while the lookup is outstanding.
  assert.match(state.message ?? "", /checking/i);
});

test("usage lookup failed → blocked (fail-closed), not defaulted to available", () => {
  // Even with counts that would otherwise clear it (or none loaded at all), a failed
  // lookup must still block — an unknown answer is never treated as "nothing else uses this".
  const state = deleteBlockState(null, true);
  assert.equal(state.blocked, true);
  assert.ok(state.message && state.message.length > 0);
  assert.doesNotMatch(state.message ?? "", /checking/i);
});
