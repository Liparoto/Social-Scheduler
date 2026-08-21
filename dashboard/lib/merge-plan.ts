// Pure decision layer for merging several draft posts into one carousel. Every guard from
// spec §5 lives here and nowhere else, and this file imports nothing but ./platforms and
// ./caption-limits — no database, no server-only, no Node built-ins — so the whole guard
// chain can be exhaustively unit-tested without ever touching SQLite. The caller (a route
// handler running inside a DB transaction) is responsible for loading MergeCandidate[] and
// turning an { ok: true } result into actual writes; this module never mutates anything.
//
// (caption-limits.ts is safe to import here for the same reason: it is pure logic over
// caller-supplied channels, with no DB access and no server-only guard.)

import { PLATFORMS, type ChannelLikeForCompat, type Platform } from "./platforms";
import { captionLimitError } from "./caption-limits";

export interface MergeCandidate {
  post_id: number;
  post_type: string;
  status: string;
  has_live_publication: boolean;
  asset_ids: number[]; // in current sort_order
  media_kinds: string[]; // parallel to asset_ids: "image" | "video"
}

export interface MergeRequest {
  post_ids: number[]; // selection order; [0] is the survivor
  asset_order: number[]; // final slide order
}

/**
 * What the merge is about to WRITE, so guard 8 can measure it before it is written.
 *
 * Required, not optional, and deliberately so: spec §5 always listed this guard, and the
 * reason it shipped without one is that planMerge was simply never handed the caption. An
 * optional argument would let the next caller re-open the same hole by forgetting it.
 */
export interface MergeCaptionCheck {
  /** The caption the merge will set on the survivor. null/""/whitespace = CLEAR it. */
  caption: string | null;
  /**
   * Every channel the MERGED post will target — the union across all selected posts, not
   * just the survivor's own. mergePostsIntoCarousel unions post_targets onto the survivor,
   * so a channel arriving from a sibling is exactly as binding as one already there.
   */
  channels: ChannelLikeForCompat[];
}

export type MergeProblem = { code: string; message: string; status: 400 | 404 | 409 };

type MergeResult =
  | { ok: true; survivorId: number; slides: { asset_id: number; sort_order: number }[] }
  | { ok: false; problem: MergeProblem };

function problem(code: string, message: string, status: 400 | 404 | 409): MergeResult {
  return { ok: false, problem: { code, message, status } };
}

export function planMerge(
  candidates: MergeCandidate[],
  req: MergeRequest,
  platforms: Platform[],
  captionCheck: MergeCaptionCheck,
): MergeResult {
  // Guard 1: a merge is meaningless below two posts — catch it before any lookup work.
  if (req.post_ids.length < 2) {
    return problem("too_few_posts", "Select at least two posts to merge.", 400);
  }

  // Guard 2: every selected id must resolve to a candidate the caller actually loaded.
  // A stale selection (post deleted between page load and submit) fails here, not later
  // as a confusing undefined.
  const byId = new Map(candidates.map((c) => [c.post_id, c]));
  const selected: MergeCandidate[] = [];
  for (const id of req.post_ids) {
    const c = byId.get(id);
    if (!c) {
      return problem("post_not_found", "One of those posts no longer exists.", 404);
    }
    selected.push(c);
  }

  // Guard 3: a post that already published (or is mid-publish) has a live record elsewhere
  // (the platform, the metrics table). Merging it would delete that record out from under
  // the thing it documents, so it's blocked outright rather than silently orphaned.
  for (const c of selected) {
    if (c.has_live_publication || c.status === "posted" || c.status === "publishing") {
      return problem(
        "already_published",
        "That post has already been published — merging would delete its record.",
        409,
      );
    }
  }

  // Guard 4: a carousel is images only — Instagram (and every other platform here) has no
  // mixed image/video carousel type, so a video slide has to be rejected before it can even
  // be counted toward duplicates or the size cap.
  for (const c of selected) {
    if (c.media_kinds.includes("video")) {
      return problem(
        "video_not_allowed",
        "A carousel can only contain images. Remove the video and try again.",
        400,
      );
    }
  }

  // Guard 5: asset_order must be exactly the multiset of every selected post's asset_ids —
  // same length, same members. Deliberately compared by Set (not by counting duplicates in
  // asset_order itself): if a source post's asset_ids already contain a duplicate, that's
  // guard 6's more specific 409, not this 400. A duplicate the client introduced on top of a
  // duplicate-free source is still caught here, because manufacturing one duplicate entry
  // forces omitting a real member, which always shows up as a Set-size mismatch below.
  const expected = selected.flatMap((c) => c.asset_ids);
  const expectedSet = new Set(expected);
  const orderSet = new Set(req.asset_order);
  const sameLength = req.asset_order.length === expected.length;
  const sameMembers =
    orderSet.size === expectedSet.size && [...orderSet].every((id) => expectedSet.has(id));
  if (!sameLength || !sameMembers) {
    return problem(
      "asset_order_mismatch",
      "Every photo in the selected posts must appear exactly once.",
      400,
    );
  }

  // Guard 6: the same asset_id showing up in two different source posts (before asset_order
  // is even considered) means the underlying data is inconsistent — an asset can't belong to
  // two posts at once. This is distinct from guard 5, which only sees asset_order.
  if (expected.length !== expectedSet.size) {
    return problem(
      "duplicate_asset",
      "The same photo appears in more than one of those posts.",
      409,
    );
  }

  // Guard 7: enforce the strictest cap among the target platforms, never a hardcoded number —
  // Threads allows 20 but Instagram caps at 10, so a selection valid for one can still be
  // invalid for another in the same request.
  const cap = Math.min(
    ...platforms.map((p) => PLATFORMS.find((entry) => entry.value === p)?.maxCarousel ?? 10),
  );
  if (req.asset_order.length > cap) {
    return problem(
      "carousel_too_large",
      `Instagram allows at most 10 photos in a carousel; you selected ${req.asset_order.length}.`,
      400,
    );
  }

  // Guard 8 (spec §5, last row): the caption the merge is about to write must fit every
  // platform the merged post will target.
  //
  // This is the guard the merge shipped without, and the gap was not theoretical. Targets
  // are UNIONED onto the survivor, so a post targeting only Instagram — which enforces no
  // caption limit here — can acquire a Threads channel (500) from a sibling and keep its
  // 1,500-character caption. Nothing about the caption changed; the audience did. Without
  // this check nothing warns, the publication is created and scheduled, and it dies at the
  // worker. That is precisely the "failed publishes must be visibly failed, never silent"
  // rule being satisfied too late to be useful.
  //
  // Measured against the post type the merge PRODUCES, never the type the survivor had:
  // the limit is per-post-type (Telegram is 4096 for text but 1024 once media is attached),
  // and changing the post type is the entire point of merging.
  //
  // A cleared caption is skipped rather than measured. null/""/whitespace all mean CLEAR
  // (see mergePostsIntoCarousel's caption contract), and an absent caption has no length to
  // exceed — measuring it would reject a merge for text it is deleting.
  const body = (captionCheck.caption ?? "").trim();
  if (body) {
    const mergedPostType =
      req.asset_order.length === 0 ? "text" : req.asset_order.length > 1 ? "carousel" : "single";
    // No variants: the merge REPLACES the survivor's caption_variants with this single body,
    // so this text is what every platform publishes. Passing it as the fallback with an empty
    // variant list models that exactly.
    const captionError = captionLimitError(captionCheck.channels, [], body, mergedPostType);
    if (captionError) {
      return problem("caption_too_long", captionError, 400);
    }
  }

  // The survivor is the first SELECTED post, not the first slide in the final order — the
  // caller picked which post's row (caption, schedule, etc.) to keep by picking it first.
  return {
    ok: true,
    survivorId: req.post_ids[0],
    slides: req.asset_order.map((asset_id, i) => ({ asset_id, sort_order: i })),
  };
}
