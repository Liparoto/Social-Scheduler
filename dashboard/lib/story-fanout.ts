import type Database from "better-sqlite3";
import type { PostTarget, Surface } from "./types";

// Kept as a runtime mirror of the Surface union in ./types — an unlisted value must fail
// loudly here rather than be guessed on a route that publishes (see parseTargets below).
const VALID_SURFACES: readonly Surface[] = ["feed", "story", "reel"];
function isSurface(value: unknown): value is Surface {
  return VALID_SURFACES.includes(value as Surface);
}

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
 * Read a request's destinations, accepting either shape.
 *
 * `targets` is what the surface picker sends. `channel_ids` / `target_channel_ids` is the
 * older shape, still used by callers that have no surface concept (bulk import, the
 * library editor) — and correctly read as feed targets, since that is all they could ever
 * have meant. Returns "invalid" rather than throwing, matching the other parse* helpers
 * in the route layer.
 */
export function parseTargets(
  targets: unknown,
  channelIds: unknown,
): PostTarget[] | "invalid" {
  if (targets !== undefined) {
    if (!Array.isArray(targets)) return "invalid";
    const out: PostTarget[] = [];
    for (const t of targets) {
      if (!t || typeof t !== "object") return "invalid";
      const { channel_id, surface } = t as { channel_id?: unknown; surface?: unknown };
      if (!Number.isInteger(channel_id)) return "invalid";
      if (!isSurface(surface)) return "invalid";
      out.push({ channel_id: channel_id as number, surface });
    }
    return out;
  }
  if (channelIds !== undefined) {
    if (!Array.isArray(channelIds) || !channelIds.every((c) => Number.isInteger(c))) {
      return "invalid";
    }
    return feedTargets(channelIds as number[]);
  }
  return [];
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
