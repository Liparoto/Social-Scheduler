// Pure decision layer for splitting one carousel back into separate posts. Every guard from
// docs/design-unmerge-carousel.md §5 lives here and nowhere else, and this file imports only
// a TYPE — no database, no server-only, no Node built-ins, not even ./platforms — so the
// whole guard chain can be exhaustively unit-tested without ever touching SQLite. The caller
// (unmergeCarousel, running inside a DB transaction) is responsible for loading an
// UnmergeCandidate and turning an { ok: true } result into actual writes; this module never
// mutates anything.
//
// Unlike merge, there is no per-platform cap to consult: splitting only ever produces posts
// with ONE asset, and no platform caps that. Hence no ./platforms import.

import type { PostType } from "./types";

export interface UnmergeSlide {
  asset_id: number;
  media_kind: string; // "image" | "video"
}

export interface UnmergeCandidate {
  post_id: number;
  post_type: string;
  status: string;
  /** Any publication 'posted' or 'publishing' — it exists on the platform, or is mid-flight. */
  has_live_publication: boolean;
  /** Any publication 'scheduled' or 'pending_approval' — waiting, and the owner can cancel it. */
  has_queued_publication: boolean;
  slides: UnmergeSlide[]; // in current sort_order
}

/**
 * One resulting post. `parts[0]` describes the ORIGINAL post's new state — it keeps slide 1,
 * its id, its publications, and the metrics hanging off them. `parts[1..]` each become a NEW
 * draft post. Not called "children": that name would imply all of them are new, and the
 * caller would write one post too many.
 */
export interface UnmergePart {
  asset_id: number;
  post_type: PostType;
}

export type UnmergeProblem = { code: string; message: string; status: 400 | 404 | 409 };

type UnmergeResult =
  | { ok: true; parts: UnmergePart[] }
  | { ok: false; problem: UnmergeProblem };

function problem(code: string, message: string, status: 400 | 404 | 409): UnmergeResult {
  return { ok: false, problem: { code, message, status } };
}

/**
 * A post's type comes from its ONE asset's media_kind, never from asset count.
 * worker/publisher.py re-validates post_type against the real assets at publish time and
 * fails NON-retryably on a mismatch, so a video slide left as 'single' looks perfect in the
 * dashboard and then dies at send.
 *
 * 'story' is never produced here: an Instagram Story is a per-target SURFACE
 * (post_targets.surface), not a post_type. See docs/design-instagram-stories.md.
 */
export function derivePostType(mediaKind: string): PostType {
  return mediaKind === "video" ? "reel" : "single";
}

export function planUnmerge(candidate: UnmergeCandidate | undefined): UnmergeResult {
  // Guard 1: a stale link or a post deleted between page load and submit fails here, as a
  // 404, rather than later as a confusing undefined.
  if (!candidate) {
    return problem("post_not_found", "That post no longer exists.", 404);
  }

  // Guard 2: only a carousel has slides to separate. A single, reel, story or text post has
  // nothing to split, and silently succeeding on one would be a no-op the owner can't see.
  if (candidate.post_type !== "carousel") {
    return problem("not_a_carousel", "Only a carousel can be split into separate posts.", 400);
  }

  // Guard 3: a one-slide "carousel" is already inconsistent data. Splitting it would produce
  // exactly one post — a no-op dressed up as an operation.
  if (candidate.slides.length < 2) {
    return problem(
      "too_few_slides",
      "That carousel only has one photo — there's nothing to split.",
      400,
    );
  }

  // Guard 4: a published carousel has real Instagram media attached and metrics accumulating
  // against it. It is a record of something that actually happened, and rewriting its slides
  // would make the record describe something other than what was posted.
  //
  // Checked BEFORE guard 5 deliberately: a carousel that is both published and re-queued
  // reports THIS problem, which is the one the owner can never resolve.
  if (candidate.has_live_publication || candidate.status === "posted") {
    return problem(
      "already_published",
      "That carousel has already been published — splitting it would break the record of what went out.",
      409,
    );
  }

  // Guard 5: one carousel with a queued send becomes N posts, and there is no non-surprising
  // answer to where that send should land. Canceling it silently kills something the owner
  // scheduled; letting it follow the original silently changes what publishes. So the
  // decision goes back to the owner, who already has cancel and hold in queue control.
  if (candidate.has_queued_publication) {
    return problem(
      "send_queued",
      "That carousel has a send in the queue. Cancel or hold that send first, then split.",
      409,
    );
  }

  return {
    ok: true,
    parts: candidate.slides.map((s) => ({
      asset_id: s.asset_id,
      post_type: derivePostType(s.media_kind),
    })),
  };
}
