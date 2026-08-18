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

/** Non-post_assets references to an asset row — what blocks deleting the file outright. */
export interface OtherAssetReferences {
  /** publications.asset_id rows, any status. A Story send names its slide directly. */
  sends: number;
  /** assets.cover_asset_id rows — this image is some video's custom cover. */
  covers: number;
}

export interface MediaEditContext {
  /** The post's slides right now, in order. */
  slides: Slide[];
  /**
   * posts.post_type as it stands right now — NOT the type this edit would produce. Only
   * 'text' is acted on (see checkAddAssets): a text post has no slides by design, and
   * turning one into a media post is out of scope for this feature, the same way removing
   * a media post's last slide to make it text is (see the `last_slide` rule).
   */
  postType: PostType;
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
  | "story_queued"
  | "shared_asset"
  | "referenced_asset"
  | "text_post"
  | "incompatible";

export type MediaEditCheck =
  | { ok: true; post_type: PostType; slides: Slide[] }
  | { ok: false; code: MediaEditErrorCode; error: string; status: number };

function fail(code: MediaEditErrorCode, error: string, status: number): MediaEditCheck {
  return { ok: false, code, error, status };
}

/**
 * The one sentence every live-send refusal uses, in every layer.
 *
 * Exported because the strip in components/post-media-editor.tsx disables its own controls
 * with it: a button whose reason is worded differently from the error the server would have
 * returned reads as two different rules. This module is pure and DB-free (see the header),
 * so a client component can import it.
 */
export const LIVE_SEND_MESSAGE =
  "This post has already gone out, or is going out right now, so its media can't be changed.";

/** Same shape as MediaEditCheck's failure arm, for a question with no slide list to return. */
export type MediaEditGate =
  | { ok: true }
  | { ok: false; code: MediaEditErrorCode; error: string; status: number };

/**
 * Can this post take ANY new slide at all — asked without knowing which file it would be.
 *
 * The subset of checkAddAssets' rules that depend only on the post: a live send, a queued
 * per-slide Story send, and a text post. Split out so `GET /api/posts/[id]/assets/can-add`
 * can answer it BEFORE the browser uploads a single byte. POST /api/assets/upload writes
 * the original, a conformed derivative and a thumbnail to /data before this route ever sees
 * the file, so without a pre-flight every refused attempt left another orphaned copy in the
 * library with nothing to say where it came from.
 *
 * The asset-dependent rules (video mixing, already-on-post, carousel size) deliberately
 * stay in checkAddAssets: they cannot be judged without the asset row, and content-hash
 * dedup means re-uploading the same file after such a refusal costs one row, not a new one.
 *
 * checkAddAssets calls this rather than repeating it, so the pre-flight and the write can
 * never disagree about either the rule or its wording.
 */
export function checkCanAddMedia(
  ctx: Pick<MediaEditContext, "postType" | "hasLiveSend">,
  /** See checkAddAssets' queuedPerSlideCount — the identical question, same query. */
  queuedPerSlideCount: number
): MediaEditGate {
  if (ctx.hasLiveSend) {
    return { ok: false, code: "live_send", error: LIVE_SEND_MESSAGE, status: 409 };
  }
  // A text post has zero slides on purpose. The reverse conversion (removing a media
  // post's last slide to leave a text post) is refused by `last_slide`; this is the same
  // boundary from the other side, so the two directions stay consistent.
  if (ctx.postType === "text") {
    return {
      ok: false,
      code: "text_post",
      error:
        "This is a text-only post, so it can't become a photo or video post. Make a new post instead.",
      status: 400,
    };
  }
  // Refuse rather than fan out a new publication, for the same reason checkRemoveAsset
  // refuses rather than canceling one: this feature never writes to the owner's queue
  // behind their back. A FEED send (asset_id IS NULL) is excluded by the query and must
  // stay excluded — it publishes whatever slides the post holds at publish time, so
  // adding a slide is exactly what it is supposed to pick up.
  if (queuedPerSlideCount > 0) {
    return {
      ok: false,
      code: "story_queued",
      error:
        "This post has a Story send queued, and a Story send is fixed to the slides it was " +
        "scheduled with. Cancel or hold that send first, then add the slide.",
      status: 409,
    };
  }
  return { ok: true };
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

export function checkAddAssets(
  ctx: MediaEditContext,
  incoming: Slide[],
  /**
   * Scheduled or pending-approval sends on this post that name a slide directly —
   * publications.asset_id IS NOT NULL, i.e. an Instagram Story fan-out (see
   * countQueuedPerSlideSendsForPost() in queries.ts).
   *
   * The mirror image of checkRemoveAsset's queuedStoryCount, and deliberately a DIFFERENT
   * question. Remove asks "does a queued send name THIS slide"; add has to ask "does this
   * post have ANY queued per-slide send", because the slide being added is precisely the
   * one with no publications row. The Story fan-out happens once, at scheduling time, and
   * there is no resync — so a slide added afterwards would silently never go out as a
   * Story while the queue happily renders it as "Story 4 of 4".
   */
  queuedPerSlideCount: number
): MediaEditCheck {
  if (incoming.length === 0) {
    return fail("bad_body", "asset_ids must list at least one asset to add.", 400);
  }
  // Live send, text post and queued Story send — the rules that need nothing but the post,
  // which is exactly why they also live behind GET .../assets/can-add as a pre-flight. Same
  // function, same order, same wording, so the two answers cannot drift.
  const gate = checkCanAddMedia(ctx, queuedPerSlideCount);
  if (!gate.ok) return fail(gate.code, gate.error, gate.status);

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
  otherPostCount: number,
  /**
   * Scheduled or pending-approval Story sends pinned to THIS slide specifically —
   * publications.asset_id = assetId (see countQueuedDirectSendsForSlide() in queries.ts).
   * Unrelated to otherPostCount/mode: unlinking the slide (mode=post) would leave that
   * send pointing at a slide no longer on this post just as surely as deleting the file
   * outright would, so this check runs for BOTH modes.
   */
  queuedStoryCount: number,
  /**
   * Everything OTHER than post_assets that points at this asset row and would make the
   * `mode=everywhere` DELETE fail on a foreign key: publications.asset_id in ANY status
   * (ON DELETE RESTRICT, migration 0014) and assets.cover_asset_id (migration 0016). See
   * countOtherAssetReferences() in queries.ts.
   *
   * Counted up front so the refusal is honest. Left to SQLite, the FK error surfaced as a
   * generic constraint failure the route then reported as "another post picked this file
   * up while you were editing" — a race that never happened. The case that hits it most is
   * the one this feature exists for: a FAILED Story send, whose media you are fixing
   * before retrying, is not 'scheduled'/'pending_approval' so queuedStoryCount misses it.
   */
  otherRefs: OtherAssetReferences
): MediaEditCheck {
  if (ctx.hasLiveSend) {
    return fail("live_send", LIVE_SEND_MESSAGE, 409);
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
  // Refuse rather than auto-cancel the send: the queue is the owner's record of what is
  // about to go out, and silently deleting a row from it is exactly the kind of invisible
  // action this project avoids. Canceling or holding the send is one click away already.
  if (queuedStoryCount > 0) {
    return fail(
      "story_queued",
      "This slide has a Story send queued. Cancel or hold that send first, then remove it.",
      409
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
  if (mode === "everywhere" && (otherRefs.sends > 0 || otherRefs.covers > 0)) {
    const what =
      otherRefs.sends > 0 && otherRefs.covers > 0
        ? "A send in the queue and a video's cover image both still point at this file"
        : otherRefs.sends > 0
          ? "A send still points at this file — a Story send names the exact slide it goes out with"
          : "This file is a video's cover image";
    return fail(
      "referenced_asset",
      `${what}, so it can't be deleted outright. Remove it from this post instead.`,
      409
    );
  }

  return settle(
    ctx,
    ctx.slides.filter((s) => s.asset_id !== assetId)
  );
}
