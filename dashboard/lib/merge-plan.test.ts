import { test } from "node:test";
import assert from "node:assert/strict";
import { planMerge, type MergeCandidate } from "./merge-plan.ts";

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
  const r = planMerge([cand()], { post_ids: [1], asset_order: [10] }, ["instagram"]);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 400);
});

test("rejects a post with a live publication", () => {
  const r = planMerge(
    [cand({ post_id: 1 }), cand({ post_id: 2, asset_ids: [20], has_live_publication: true })],
    { post_ids: [1, 2], asset_order: [10, 20] },
    ["instagram"],
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
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.problem.message, /video/i);
});

test("enforces the smallest platform cap, not a hardcoded 10", () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    cand({ post_id: i + 1, asset_ids: [100 + i] }));
  const req = { post_ids: many.map((c) => c.post_id), asset_order: many.map((c) => c.asset_ids[0]) };
  assert.equal(planMerge(many, req, ["threads"]).ok, true, "threads allows 20");
  const r = planMerge(many, req, ["threads", "instagram"]);
  assert.equal(r.ok, false, "instagram caps at 10");
  if (r.ok) return;
  assert.match(r.problem.message, /10/);
});

test("rejects the same asset appearing twice", () => {
  const r = planMerge(
    [cand({ post_id: 1, asset_ids: [10] }), cand({ post_id: 2, asset_ids: [10] })],
    { post_ids: [1, 2], asset_order: [10, 10] },
    ["instagram"],
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
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.slides.map((s) => s.asset_id), [10, 20, 11]);
});
