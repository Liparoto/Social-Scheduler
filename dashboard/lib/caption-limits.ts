// No "server-only" guard here (unlike content-model-validation.ts): this is pure logic
// over caller-supplied channels/variants with no DB access, and the composer (a client
// component) needs captionsForPlatform to keep its live counter's rotation-awareness in
// sync with what the create routes and content/route.ts actually enforce.
import { maxCaptionChars, platformLabel, type ChannelLikeForCompat } from "./platforms";

export interface CaptionVariantLike {
  platform: string | null;
  body: string;
}

/**
 * Mirrors worker/publisher.py's _select_caption's matching rules — platform-specific
 * variant(s) if present, else the generic ("Any") one(s), else the post's base caption —
 * but returns EVERY matching variant's body, not just the first. The worker rotates
 * through all of a platform's variants by post count, so a second (or third) variant
 * that a `.find()` would never reach can still get selected on a later publish and fail
 * terminally. Any caller checking a caption length against a platform's limit needs to
 * check the worst of these, not just the first.
 */
export function captionsForPlatform(
  platform: string,
  variants: CaptionVariantLike[],
  fallback: string | null
): string[] {
  const specific = variants.filter((v) => v.platform === platform && v.body).map((v) => v.body);
  if (specific.length > 0) return specific;
  const generic = variants.filter((v) => v.platform === null && v.body).map((v) => v.body);
  if (generic.length > 0) return generic;
  return [fallback ?? ""];
}

export interface CaptionOverLimit {
  platform: string;
  length: number;
  limit: number;
}

/**
 * For each distinct platform among the given channels, finds the longest caption that
 * platform would actually publish (see captionsForPlatform) and reports it if it's over
 * that platform's maxCaptionChars. One entry per offending platform, worst variant only.
 */
export function overLimitCaptionsForChannels<T extends ChannelLikeForCompat>(
  channels: T[],
  variants: CaptionVariantLike[],
  fallback: string | null
): CaptionOverLimit[] {
  const platforms = Array.from(new Set(channels.map((c) => c.platform)));
  const out: CaptionOverLimit[] = [];
  for (const platform of platforms) {
    const limit = maxCaptionChars(platform);
    if (limit === null) continue;
    const candidates = captionsForPlatform(platform, variants, fallback);
    const worstLength = Math.max(...candidates.map((c) => c.length));
    if (worstLength > limit) {
      out.push({ platform, length: worstLength, limit });
    }
  }
  return out;
}

/** The shared 400 message for a caption over a targeted platform's limit, or null if
 *  every targeted platform's actual (worst-case, rotation-aware) caption fits. */
export function captionLimitError<T extends ChannelLikeForCompat>(
  channels: T[],
  variants: CaptionVariantLike[],
  fallback: string | null
): string | null {
  const overLimit = overLimitCaptionsForChannels(channels, variants, fallback);
  if (overLimit.length === 0) return null;
  const names = overLimit
    .map((v) => `${platformLabel(v.platform)} (${v.length}/${v.limit})`)
    .join(", ");
  return `Caption is over the limit for: ${names}.`;
}
