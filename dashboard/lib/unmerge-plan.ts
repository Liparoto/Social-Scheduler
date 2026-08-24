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
  return mediaKind === "video" ? "video" : "single";
}

/**
 * Guards 1-5: may this carousel's slides be restructured at all? Shared by every operation
 * that rewrites `post_assets` on an existing carousel — the full split and slide extraction —
 * so a guard added here applies to both by construction rather than by anyone remembering.
 *
 * Returns the problem to report, or null if the carousel may be restructured.
 *
 * The messages are worded to fit either operation. They used to say "split" throughout, from
 * when the full split was the only caller; guards 4 and 5 are the two genuinely reachable
 * from both entry points (a published or queued carousel still renders its buttons), so
 * their wording is now operation-neutral.
 */
function checkRestructurable(candidate: UnmergeCandidate | undefined): UnmergeProblem | null {
  // Guard 1: a stale link or a post deleted between page load and submit fails here, as a
  // 404, rather than later as a confusing undefined.
  if (!candidate) {
    return { code: "post_not_found", message: "That post no longer exists.", status: 404 };
  }

  // Guard 2: only a carousel has slides to separate. A single, reel, story or text post has
  // nothing to split, and silently succeeding on one would be a no-op the owner can't see.
  if (candidate.post_type !== "carousel") {
    return {
      code: "not_a_carousel",
      message: "Only a carousel can be split up.",
      status: 400,
    };
  }

  // Guard 3: a one-slide "carousel" is already inconsistent data. Splitting it would produce
  // exactly one post — a no-op dressed up as an operation.
  if (candidate.slides.length < 2) {
    return {
      code: "too_few_slides",
      message: "That carousel only has one photo — there's nothing to split.",
      status: 400,
    };
  }

  // Guard 4: a published carousel has real Instagram media attached and metrics accumulating
  // against it. It is a record of something that actually happened, and rewriting its slides
  // would make the record describe something other than what was posted.
  //
  // Checked BEFORE guard 5 deliberately: a carousel that is both published and re-queued
  // reports THIS problem, which is the one the owner can never resolve.
  if (candidate.has_live_publication || candidate.status === "posted") {
    return {
      code: "already_published",
      message:
        "That carousel has already been published — changing its photos would break the record of what went out.",
      status: 409,
    };
  }

  // Guard 5: restructuring a carousel with a queued send has no non-surprising answer for
  // where that send should land. Canceling it silently kills something the owner scheduled;
  // letting it follow the original silently changes what publishes. So the decision goes back
  // to the owner, who already has cancel and hold in queue control.
  if (candidate.has_queued_publication) {
    return {
      code: "send_queued",
      message: "That carousel has a send in the queue. Cancel or hold that send first.",
      status: 409,
    };
  }

  return null;
}

type ExtractResult =
  | {
      ok: true;
      /** One new post each, in CAROUSEL order — not the order the owner ticked them. */
      extracted: UnmergePart[];
      /** What the original keeps, in its existing relative order. Caller writes 0..K-1. */
      keeperAssetIds: number[];
      /** What the original becomes once it holds only the keepers. */
      originalType: PostType;
    }
  | { ok: false; problem: UnmergeProblem };

/**
 * Pull selected slides out of a carousel as their own posts, leaving the rest a carousel.
 *
 * The narrower half of planUnmerge: same shared guards (see checkRestructurable), plus three
 * of its own about the selection itself.
 *
 * `keeperAssetIds` comes back in the original's existing relative order because the caller
 * has to renumber them contiguously — `post_assets` has `UNIQUE (post_id, sort_order)`
 * checked per-row and immediately, so the surviving slides can't just keep their old numbers
 * with a gap where the extracted one was.
 */
export function planExtractSlides(
  candidate: UnmergeCandidate | undefined,
  assetIds: number[],
): ExtractResult {
  // Shared guards first: a problem the owner cannot resolve (already published) outranks one
  // they can (nothing ticked).
  const blocked = checkRestructurable(candidate);
  if (blocked) return { ok: false, problem: blocked };
  if (!candidate) {
    return {
      ok: false,
      problem: { code: "post_not_found", message: "That post no longer exists.", status: 404 },
    };
  }

  // Collapse duplicates up front: the same id twice would otherwise produce two posts holding
  // the same asset, and would throw off guard 8's count.
  const selected = [...new Set(assetIds)];

  // Guard 6: extracting nothing is a no-op dressed up as an operation.
  if (selected.length === 0) {
    return {
      ok: false,
      problem: {
        code: "no_slides_selected",
        message: "Pick at least one photo to pull out.",
        status: 400,
      },
    };
  }

  // Guard 7: a stale picker — the post's slides changed in another tab between opening the
  // modal and confirming. Fail loudly rather than quietly extracting fewer than were ticked.
  const own = new Set(candidate.slides.map((s) => s.asset_id));
  if (selected.some((id) => !own.has(id))) {
    return {
      ok: false,
      problem: {
        code: "slide_not_in_post",
        message: "One of those photos is no longer in this carousel. Reload and try again.",
        status: 400,
      },
    };
  }

  // Guard 8: taking every slide would leave the original with zero photos — a post that
  // exists, is reachable, and can never publish. The other action does exactly this job
  // properly, so name it rather than silently redirecting a differently-labelled button.
  if (selected.length === candidate.slides.length) {
    return {
      ok: false,
      problem: {
        code: "extracts_everything",
        message:
          "That's every photo. Use Split into separate posts instead — it does exactly this.",
        status: 400,
      },
    };
  }

  const taking = new Set(selected);
  // Both lists are derived by walking candidate.slides, which is already in sort_order — so
  // extracted posts are created in carousel order and keepers preserve their relative order,
  // regardless of what order the ids arrived in.
  const extracted = candidate.slides
    .filter((s) => taking.has(s.asset_id))
    .map((s) => ({ asset_id: s.asset_id, post_type: derivePostType(s.media_kind) }));
  const keepers = candidate.slides.filter((s) => !taking.has(s.asset_id));

  return {
    ok: true,
    extracted,
    keeperAssetIds: keepers.map((s) => s.asset_id),
    // Guard 8 guarantees at least one keeper. Two or more stay a carousel; a lone survivor is
    // retyped from its own media_kind, because a 1-slide 'carousel' fails NON-retryably at
    // publish with "carousel needs 2-10 assets, has 1".
    originalType: keepers.length >= 2 ? "carousel" : derivePostType(keepers[0].media_kind),
  };
}

export function planUnmerge(candidate: UnmergeCandidate | undefined): UnmergeResult {
  const blocked = checkRestructurable(candidate);
  if (blocked) return { ok: false, problem: blocked };
  // checkRestructurable returning null proves candidate is defined; TypeScript can't see
  // through the helper, so this narrows it back for the body below.
  if (!candidate) return problem("post_not_found", "That post no longer exists.", 404);

  return {
    ok: true,
    parts: candidate.slides.map((s) => ({
      asset_id: s.asset_id,
      post_type: derivePostType(s.media_kind),
    })),
  };
}
