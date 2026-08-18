/**
 * Can this post's media be changed the way the request asks, and what does that make it?
 *
 * The rules half of adding/removing slides, kept pure and DB-free so every rule below has
 * a unit test rather than a route test. Same split as lib/asset-order.ts.
 *
 * `PATCH /api/posts/[id]/assets` gets to be as simple as it is because a reorder cannot
 * change the slide count, which makes posts.post_type correct by construction. Adding and
 * removing give that up, so post_type has to be re-derived and channel compatibility
 * re-checked on every call — that is the whole reason this is a separate endpoint and a
 * separate module.
 */
import { incompatiblePostError, type ChannelLikeForCompat } from "./platforms";
import type { PostType } from "./types";

export interface Slide {
  asset_id: number;
  media_kind: string;
}

export interface MediaEditContext {
  /** The post's slides right now, in order. */
  slides: Slide[];
  /**
   * Any publication 'posted' or 'publishing'. Same live-send definition deletePost() uses:
   * 'posted' means it exists on the platform, 'publishing' means the worker is mid-flight
   * with it right now. NOT posts.status, which is only the coarse overview hint.
   */
  hasLiveSend: boolean;
  /** Channels this post must still satisfy. See getPostCompatChannels() in queries.ts. */
  channels: ChannelLikeForCompat[];
}

export type MediaEditErrorCode =
  | "bad_body"
  | "live_send"
  | "already_on_post"
  | "video_mix"
  | "not_on_post"
  | "last_slide"
  | "shared_asset"
  | "incompatible";

export type MediaEditCheck =
  | { ok: true; post_type: PostType; slides: Slide[] }
  | { ok: false; code: MediaEditErrorCode; error: string; status: number };

function fail(code: MediaEditErrorCode, error: string, status: number): MediaEditCheck {
  return { ok: false, code, error, status };
}

/**
 * The same rule createDraftPost derives from the database, without the database.
 * queries.ts's derivePostType() delegates here so the two can never drift.
 */
export function derivePostTypeFromKinds(kinds: string[]): PostType {
  // No slides is left as "single" rather than guessed at "text", matching the behaviour
  // this replaced: a text post always states its type explicitly.
  if (kinds.length === 0) return "single";
  if (kinds.length > 1) return "carousel";
  return kinds[0] === "video" ? "reel" : "single";
}

/**
 * The checks every media change shares, run in the order a person would want them: the
 * thing that makes the whole request moot first, the details after.
 */
function settle(ctx: MediaEditContext, next: Slide[]): MediaEditCheck {
  // worker/publisher.py's _publish_carousel builds an IMAGE container for every child, so
  // a video alongside anything else publishes as a broken carousel or dies outright. The
  // composer refuses the same combination when the post is first built.
  if (next.length > 1 && next.some((s) => s.media_kind === "video")) {
    return fail(
      "video_mix",
      "A video has to be on its own. It can't be mixed with images or with another video.",
      400
    );
  }

  const postType = derivePostTypeFromKinds(next.map((s) => s.media_kind));
  const compat = incompatiblePostError(postType, next.length, ctx.channels);
  if (compat) return fail("incompatible", compat, 400);

  return { ok: true, post_type: postType, slides: next };
}

export function checkAddAssets(ctx: MediaEditContext, incoming: Slide[]): MediaEditCheck {
  if (incoming.length === 0) {
    return fail("bad_body", "asset_ids must list at least one asset to add.", 400);
  }
  if (ctx.hasLiveSend) {
    return fail(
      "live_send",
      "This post has already gone out, or is going out right now, so its media can't be changed.",
      409
    );
  }

  const have = new Set(ctx.slides.map((s) => s.asset_id));
  const dupe = incoming.find((s) => have.has(s.asset_id));
  if (dupe) {
    return fail(
      "already_on_post",
      "That file is already on this post. The same photo can only appear once.",
      400
    );
  }
  // Catches the same file listed twice in one request, which the UNIQUE(post_id, asset_id)
  // index would otherwise turn into an opaque SQLITE_CONSTRAINT mid-transaction.
  if (new Set(incoming.map((s) => s.asset_id)).size !== incoming.length) {
    return fail("bad_body", "asset_ids lists the same file more than once.", 400);
  }

  return settle(ctx, [...ctx.slides, ...incoming]);
}

export function checkRemoveAsset(
  ctx: MediaEditContext,
  assetId: number,
  mode: "post" | "everywhere",
  otherPostCount: number
): MediaEditCheck {
  if (ctx.hasLiveSend) {
    return fail(
      "live_send",
      "This post has already gone out, or is going out right now, so its media can't be changed.",
      409
    );
  }
  if (!ctx.slides.some((s) => s.asset_id === assetId)) {
    return fail("not_on_post", "That file isn't on this post.", 404);
  }
  if (ctx.slides.length === 1) {
    return fail(
      "last_slide",
      "A post needs at least one photo. Delete the post itself if you don't want it.",
      400
    );
  }
  if (mode === "everywhere" && otherPostCount > 0) {
    return fail(
      "shared_asset",
      `This file is also used by ${otherPostCount} other post${
        otherPostCount === 1 ? "" : "s"
      }, so it can't be deleted outright. Remove it from this post instead.`,
      409
    );
  }

  return settle(
    ctx,
    ctx.slides.filter((s) => s.asset_id !== assetId)
  );
}
