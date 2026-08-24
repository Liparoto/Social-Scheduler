import { humanDuration } from "./video-spec";

/**
 * Facebook Reels' publish limits, mirrored BY HAND from worker/publisher.py's `_validate`
 * (search `platform == "facebook" and surface == "reel"`) — that function is the authority
 * and re-validates every publish against its own copy; this copy exists only to grey out
 * the Reel chip before scheduling ever gets there. Unlike the nine worker registries, this
 * copy has no assert guarding it against drifting out of sync — a future change to the
 * worker's numbers has to be brought over here by hand too.
 *
 * NOT `video-spec.ts`'s REEL_SPEC — that one is INSTAGRAM Reels (15-minute max, its own
 * aspect rules) and its own header warns against "correcting" it from memory. Facebook
 * Reels is a different product with different limits.
 */
export const FB_REEL_MIN_DURATION_MS = 3_000;
export const FB_REEL_MAX_DURATION_MS = 90_000;
export const FB_REEL_MIN_WIDTH = 540;
export const FB_REEL_MIN_HEIGHT = 960;

export interface ReelSpecAsset {
  width: number | null;
  height: number | null;
  duration_ms?: number | null;
}

/**
 * Why (if at all) the attached video can't be a Facebook Reel — mirrors the worker's
 * inclusive boundaries and its "unknown values don't block the send" rule exactly: a null
 * duration/width/height skips that check rather than disabling the chip, because Meta is
 * the backstop and a clip predating duration/dimension tracking shouldn't be blocked here
 * on a guess. Returns null when the video is fine, or there's nothing to gate on.
 *
 * Exported so any caller holding a saved (not just in-progress) `{platform:"facebook",
 * surface:"reel"}` target can derive whether it's still live-eligible — e.g. an existing
 * post whose video predates this gate — without duplicating the limits a second time.
 */
export function facebookReelDisabledReason(asset: ReelSpecAsset | undefined): string | null {
  if (!asset) return null;
  const { width, height, duration_ms = null } = asset;

  if (duration_ms != null) {
    if (duration_ms < FB_REEL_MIN_DURATION_MS) {
      return `Too short for Reels (${humanDuration(duration_ms, "floor")} — min ${humanDuration(FB_REEL_MIN_DURATION_MS)})`;
    }
    if (duration_ms > FB_REEL_MAX_DURATION_MS) {
      return `Too long for Reels (${humanDuration(duration_ms, "ceil")} — max ${humanDuration(FB_REEL_MAX_DURATION_MS)})`;
    }
  }
  if (width && height) {
    if (width < FB_REEL_MIN_WIDTH || height < FB_REEL_MIN_HEIGHT) {
      return `Too small for Reels (${width}×${height} — min ${FB_REEL_MIN_WIDTH}×${FB_REEL_MIN_HEIGHT})`;
    }
    // Cross-multiplied, not divided, so the 16:9/9:16 boundary itself can't be nudged
    // outside the allowed range by float rounding — same reasoning as the worker's
    // Fraction comparison.
    if (!(16 * width >= 9 * height && 9 * width <= 16 * height)) {
      return `Wrong shape for Reels (${width}×${height})`;
    }
  }
  return null;
}
