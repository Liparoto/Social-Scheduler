import type Database from "better-sqlite3";
import type { PostTarget, Surface } from "./types";

/**
 * Treat a bare list of channel ids as feed targets.
 *
 * A transitional shim for the API routes and callers that still speak in channel ids
 * while the surface picker is being built. Feed is the correct reading of a request that
 * predates surfaces: every target that existed before migration 0014 was a feed target.
 */
export function feedTargets(channelIds: number[]): PostTarget[] {
  return channelIds.map((channel_id) => ({ channel_id, surface: "feed" as const }));
}

/**
 * The asset ids of a post, in slide order.
 *
 * Ordering matters beyond tidiness: story slides are inserted in this order, which makes
 * ascending publication id the publish order that worker/db.py's
 * `ORDER BY scheduled_at, id` relies on to send them out in sequence.
 */
export function storySlideAssetIds(db: Database.Database, postId: number): number[] {
  return (
    db
      .prepare("SELECT asset_id FROM post_assets WHERE post_id = ? ORDER BY sort_order ASC")
      .all(postId) as { asset_id: number }[]
  ).map((r) => r.asset_id);
}

/**
 * Expand one target into the `asset_id` values its publication rows should carry.
 *
 * A FEED target is one row covering ALL of the post's assets, so it yields a single
 * `null` — null means "all assets, in order". A STORY target is one row PER slide,
 * because there is no such thing as a carousel Story in the API: a 4-slide post becomes
 * 4 consecutive Stories, each an independent publication that retries, fails, and
 * reports metrics on its own.
 *
 * This is the ONLY place the "one Story per slide" rule is expressed on the TypeScript
 * side. Its Python counterpart is worker/autofill.py's scheduling path — the two
 * languages share a database, not code (CLAUDE.md), so the rule is deliberately
 * duplicated and tested on both sides. See docs/design-instagram-stories.md §4.
 */
export function expandTarget(
  db: Database.Database,
  postId: number,
  surface: Surface,
): (number | null)[] {
  return surface === "story" ? storySlideAssetIds(db, postId) : [null];
}
