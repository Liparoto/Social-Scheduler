import { test } from "node:test";
import assert from "node:assert/strict";
import { planMerge, type MergeCandidate } from "./merge-plan.ts";
import type { ChannelLikeForCompat } from "./platforms.ts";

// These pre-date guard 8 and are about slide mechanics, not text. An explicit "nothing to
// measure" argument keeps them honest: the guard is required, they simply have no caption.
const NO_CAPTION = { caption: null, channels: [] };

function cand(over: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    post_id: 1, post_type: "single", status: "draft",
    has_live_publication: false, asset_ids: [10], media_kinds: ["image"],
    ...over,
  };
}

test("merges two singles into contiguous slides", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [20, 10] },
    ["instagram"],
    NO_CAPTION,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.survivorId, 1, "survivor is first SELECTED, not first slide");
  assert.deepEqual(r.slides, [
    { asset_id: 20, sort_order: 0 },
    { asset_id: 10, sort_order: 1 },
  ]);
});

test("rejects a single post", () => {
  const r = planMerge([cand()], { post_ids: [1], asset_order: [10] }, ["instagram"], NO_CAPTION);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 400);
});

test("rejects a post with a live publication", () => {
  const r = planMerge(
    [cand({ post_id: 1 }), cand({ post_id: 2, asset_ids: [20], has_live_publication: true })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram"],
    NO_CAPTION,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 409);
  assert.match(r.problem.message, /already/i);
});

test("rejects video assets — a carousel is images only", () => {
  const r = planMerge(
    [cand({ post_id: 1 }), cand({ post_id: 2, asset_ids: [20], media_kinds: ["video"] })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram"],
    NO_CAPTION,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.problem.message, /video/i);
});

test("enforces the smallest platform cap, not a hardcoded 10", () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    cand({ post_id: i + 1, asset_ids: [100 + i] }));
  const req = { post_ids: many.map((c) => c.post_id), asset_order: many.map((c) => c.asset_ids[0]) };
  assert.equal(planMerge(many, req, ["threads"], NO_CAPTION).ok, true, "threads allows 20");
  const r = planMerge(many, req, ["threads", "instagram"], NO_CAPTION);
  assert.equal(r.ok, false, "instagram caps at 10");
  if (r.ok) return;
  assert.match(r.problem.message, /10/);
});

test("rejects the same asset appearing twice", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [10] })],
    { post_ids: [1, 2], asset_order: [10, 10] },
    ["instagram"],
    NO_CAPTION,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 409);
});

test("rejects asset_order that omits a slide", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10] },
    ["instagram"],
    NO_CAPTION,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.problem.message, /every photo/i);
});

test("absorbing into an existing carousel keeps it a carousel", () => {
  const r = planMerge(
    [cand({ post_id: 1, post_type: "carousel", asset_ids: [10, 11], media_kinds: ["image", "image"] }),
     cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10, 20, 11] },
    ["instagram"],
    NO_CAPTION,
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.slides.map((s) => s.asset_id), [10, 20, 11]);
});

// --- Guard 8: the chosen caption must fit every platform the merged post will target ------
// Spec §5's last row. It went unimplemented because planMerge was never handed the caption
// at all; these pin the shape so it cannot quietly fall out again.

const ch = (platform: string, id = 1): ChannelLikeForCompat => ({
  id, platform, account_name: `acct-${id}`,
});

test("rejects a caption over a targeted platform's limit", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram", "threads"],
    { caption: "x".repeat(600), channels: [ch("instagram", 1), ch("threads", 2)] },
  );
  assert.equal(r.ok, false, "600 chars is over Threads' 500");
  if (r.ok) return;
  assert.equal(r.problem.status, 400);
  assert.equal(r.problem.code, "caption_too_long");
  assert.match(r.problem.message, /Threads \(600\/500\)/);
});

test("accepts a caption that fits every targeted platform", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram", "threads"],
    { caption: "x".repeat(499), channels: [ch("instagram", 1), ch("threads", 2)] },
  );
  assert.equal(r.ok, true);
});

// THE case this whole guard exists for: the survivor targets only Instagram (no enforced
// caption limit), so its long caption was always legal — until the merge unions the OTHER
// post's Threads channel onto it. Nothing about the survivor changed; its audience did.
test("checks the UNION of targets, not just the survivor's own", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram", "threads"],
    { caption: "x".repeat(1500), channels: [ch("instagram", 1), ch("threads", 2)] },
  );
  assert.equal(r.ok, false, "legal on IG alone, illegal once Threads is unioned in");
  if (r.ok) return;
  assert.match(r.problem.message, /Threads/);
});

test("a cleared caption never trips the limit guard", () => {
  const targets = [ch("instagram", 1), ch("threads", 2)];
  for (const caption of [null, "", "   "]) {
    const r = planMerge(
      [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
      { post_ids: [1, 2], asset_order: [10, 20] },
      ["instagram", "threads"],
      { caption, channels: targets },
    );
    assert.equal(r.ok, true, `cleared caption ${JSON.stringify(caption)} has no length to exceed`);
  }
});

// Instagram and Facebook enforce no caption limit in platforms.ts (captionChars: {}), so a
// caption that would be rejected for Threads has to sail through when only IG is targeted.
test("an Instagram-only merge accepts a caption Threads would reject", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram"],
    { caption: "x".repeat(5000), channels: [ch("instagram", 1)] },
  );
  assert.equal(r.ok, true);
});

// The limit is looked up per post_type, and merging is exactly what CHANGES the post_type.
// Telegram is the platform where that matters (4096 for text, 1024 with media attached);
// the merged post always carries slides, so it must be measured as media, never as text.
test("measures the caption against the post type the merge will produce", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [20] })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["telegram"],
    { caption: "x".repeat(2000), channels: [ch("telegram", 1)] },
  );
  assert.equal(r.ok, false, "2000 fits Telegram's text limit but not its 1024 media limit");
  if (r.ok) return;
  assert.match(r.problem.message, /1024/);
});
