import { test } from "node:test";
import assert from "node:assert/strict";
import { planUnmerge, derivePostType, type UnmergeCandidate } from "./unmerge-plan.ts";

function cand(over: Partial<UnmergeCandidate> = {}): UnmergeCandidate {
  return {
    post_id: 1,
    post_type: "carousel",
    status: "draft",
    has_live_publication: false,
    has_queued_publication: false,
    slides: [
      { asset_id: 10, media_kind: "image" },
      { asset_id: 20, media_kind: "image" },
    ],
    ...over,
  };
}

test("a three-image carousel splits into three single-image parts", () => {
  const r = planUnmerge(
    cand({
      slides: [
        { asset_id: 10, media_kind: "image" },
        { asset_id: 20, media_kind: "image" },
        { asset_id: 30, media_kind: "image" },
      ],
    })
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.parts, [
    { asset_id: 10, post_type: "single" },
    { asset_id: 20, post_type: "single" },
    { asset_id: 30, post_type: "single" },
  ]);
});

test("parts stay in the carousel's existing slide order", () => {
  const r = planUnmerge(
    cand({
      slides: [
        { asset_id: 99, media_kind: "image" },
        { asset_id: 11, media_kind: "image" },
      ],
    })
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    r.parts.map((p) => p.asset_id),
    [99, 11],
    "order is preserved verbatim — there is no reorder step"
  );
});

test("a video slide becomes a reel, not a single", () => {
  // THE invariant from spec §3. Wrong here means the child looks fine in the dashboard and
  // then fails NON-retryably at publish, which is the failure mode this guard exists for.
  const r = planUnmerge(
    cand({
      slides: [
        { asset_id: 10, media_kind: "image" },
        { asset_id: 20, media_kind: "video" },
        { asset_id: 30, media_kind: "image" },
      ],
    })
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    r.parts.map((p) => p.post_type),
    ["single", "reel", "single"]
  );
});

test("a video in slot ONE retypes the original post, not a new one", () => {
  const r = planUnmerge(
    cand({
      slides: [
        { asset_id: 10, media_kind: "video" },
        { asset_id: 20, media_kind: "image" },
      ],
    })
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parts[0].post_type, "reel", "parts[0] is the ORIGINAL post's new type");
});

test("a ten-slide carousel splits into ten parts", () => {
  const slides = Array.from({ length: 10 }, (_, i) => ({
    asset_id: (i + 1) * 10,
    media_kind: "image",
  }));
  const r = planUnmerge(cand({ slides }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.parts.length, 10);
});

test("a missing post is 404, not a crash", () => {
  const r = planUnmerge(undefined);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 404);
  assert.equal(r.problem.code, "post_not_found");
});

test("a single-image post cannot be split", () => {
  const r = planUnmerge(cand({ post_type: "single", slides: [{ asset_id: 10, media_kind: "image" }] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 400);
  assert.equal(r.problem.code, "not_a_carousel");
});

test("a reel cannot be split", () => {
  const r = planUnmerge(cand({ post_type: "reel", slides: [{ asset_id: 10, media_kind: "video" }] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.code, "not_a_carousel");
});

test("a carousel with one slide has nothing to split", () => {
  const r = planUnmerge(cand({ slides: [{ asset_id: 10, media_kind: "image" }] }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 400);
  assert.equal(r.problem.code, "too_few_slides");
});

test("a carousel with a live publication is refused", () => {
  const r = planUnmerge(cand({ has_live_publication: true }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 409);
  assert.equal(r.problem.code, "already_published");
});

test("a post whose own status is 'posted' is refused even with no publication rows", () => {
  const r = planUnmerge(cand({ status: "posted" }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.code, "already_published");
});

test("a carousel with a queued send is refused, with its OWN message", () => {
  const r = planUnmerge(cand({ has_queued_publication: true }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.status, 409);
  assert.equal(r.problem.code, "send_queued");
  assert.match(r.problem.message, /queue/i, "must point the owner at queue control");
});

test("published beats queued — the unresolvable problem is the one reported", () => {
  const r = planUnmerge(cand({ has_live_publication: true, has_queued_publication: true }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.code, "already_published");
});

test("guards run before type derivation — a bad post is rejected, not described", () => {
  // A 'posted' carousel containing a video must report already_published. If derivation ran
  // first this would still pass, so the point is the ORDER, checked via the failure code.
  const r = planUnmerge(
    cand({ status: "posted", slides: [{ asset_id: 10, media_kind: "video" }, { asset_id: 20, media_kind: "image" }] })
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.problem.code, "already_published");
});

test("derivePostType maps media_kind, never asset count", () => {
  assert.equal(derivePostType("video"), "reel");
  assert.equal(derivePostType("image"), "single");
});

test("derivePostType never produces 'story' — a Story is a target surface, not a type", () => {
  assert.equal(derivePostType("story"), "single");
  assert.equal(derivePostType(""), "single");
});
