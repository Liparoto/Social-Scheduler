/**
 * Per-platform, per-surface media limits — the SAME media-limits.json the Python worker
 * reads (worker/media_limits.py). Not a mirror: one file, two readers. That is the whole
 * point — a hand-maintained copy of ~100 numbers drifts, and a drifted number is silent
 * in the worst way (the composer says fine, the worker refuses).
 *
 * ABSENT MEANS NOT ENFORCED. A limit we cannot verify is omitted, never guessed.
 *
 * The file lives at dashboard/media-limits.json — a plain LOCAL import through the
 * existing "@/" alias (tsconfig paths: "@/*" -> "./*", i.e. dashboard/). There is no
 * "@shared/*" alias: Task 1 tried putting this file at the repo root behind one, but
 * Turbopack refuses to bundle anything outside dashboard/ (its project root), and
 * widening turbopack.root pulled the owner's 1.6GB data/ asset store into the build's
 * file-trace manifest. So the file moved INTO dashboard/ instead, and worker/media_limits.py
 * reaches one directory up to read it. See that module's docstring for the full story.
 */
import raw from "@/media-limits.json" with { type: "json" };
import { PLATFORMS, supportsImages, supportsStory, videoSurfaces } from "@/lib/platforms";

export type Violation = {
  kind: "too_short" | "too_long" | "too_small" | "too_large" | "wrong_aspect" | "wrong_format";
  message: string;
  severity: "refuse" | "warn";
};

type Entry = {
  min_duration_ms?: number; max_duration_ms?: number;
  min_width?: number; min_height?: number;
  max_width?: number; max_height?: number;
  min_aspect?: [number, number]; max_aspect?: [number, number];
  max_bytes?: number; formats?: string[];
  note: string; varies?: string;
};

export type AssetLike = {
  media_kind?: string | null;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
  byte_size?: number | null;
};

type RawLimits = {
  schema_version: number;
  platforms: Record<string, Record<string, Record<string, Entry>>>;
};

export type PlatformsData = RawLimits["platforms"];

// Cast through unknown: the imported JSON literal's inferred type (e.g. min_aspect as
// number[]) is narrower in shape than the field-by-field Entry type below, but the
// actual values are validated at load time by worker/media_limits.py's schema check —
// both languages read the identical file.
const REAL_PLATFORMS: PlatformsData = (raw as unknown as RawLimits).platforms ?? {};

// `data` defaults to the real, on-disk media-limits.json for every production call site.
// The parameter exists so anyDestinationAccepts's REFUSAL branch (below) can be proven
// with injected data instead of today's real data — see that function's comment for why
// the real data can never exercise that branch on this install.
export function limitsFor(
  platform: string, surface: string, mediaKind: string, data: PlatformsData = REAL_PLATFORMS,
): Entry | null {
  const p = data?.[platform];
  return p?.[surface]?.[mediaKind] ?? null;
}

/** Cross-multiplied so the comparison is exact. A decimal ratio can exclude 16:9 by
 *  rounding, and 16:9 is a value Meta explicitly permits. Bounds are INCLUSIVE. */
function ratioBelow(w: number, h: number, [aw, ah]: [number, number]): boolean {
  return w * ah < aw * h;
}
function ratioAbove(w: number, h: number, [aw, ah]: [number, number]): boolean {
  return w * ah > aw * h;
}

export function checkMedia(
  platform: string, surface: string, asset: AssetLike, data: PlatformsData = REAL_PLATFORMS,
): Violation[] {
  const entry = limitsFor(platform, surface, asset.media_kind ?? "", data);
  if (!entry) return [];
  // A limit that VARIES by account can never be enforced honestly — warn, never refuse.
  const severity: Violation["severity"] = entry.varies ? "warn" : "refuse";
  const out: Violation[] = [];

  // Every check is guarded on the value being KNOWN. Unknown metadata must never refuse:
  // assets predating the video pipeline carry no duration at all. A `null` must never be
  // coerced to 0 and read as "too short" or "too small" — that is a single `<` away in JS.
  const d = asset.duration_ms;
  if (d != null) {
    if (entry.min_duration_ms != null && d < entry.min_duration_ms) {
      out.push({ kind: "too_short", message: `shorter than ${entry.min_duration_ms / 1000}s`, severity });
    }
    if (entry.max_duration_ms != null && d > entry.max_duration_ms) {
      out.push({ kind: "too_long", message: `longer than ${entry.max_duration_ms / 1000}s`, severity });
    }
  }

  const w = asset.width, h = asset.height;
  if (w != null && h != null) {
    if ((entry.min_width != null && w < entry.min_width) ||
        (entry.min_height != null && h < entry.min_height)) {
      out.push({ kind: "too_small", message: `smaller than ${entry.min_width ?? "?"}x${entry.min_height ?? "?"}`, severity });
    }
    if ((entry.max_width != null && w > entry.max_width) ||
        (entry.max_height != null && h > entry.max_height)) {
      out.push({ kind: "too_large", message: `larger than ${entry.max_width ?? "?"}x${entry.max_height ?? "?"}`, severity });
    }
    if ((entry.min_aspect && ratioBelow(w, h, entry.min_aspect)) ||
        (entry.max_aspect && ratioAbove(w, h, entry.max_aspect))) {
      out.push({ kind: "wrong_aspect", message: `aspect ratio ${w}x${h}`, severity });
    }
  }

  const b = asset.byte_size;
  if (b != null && entry.max_bytes != null && b > entry.max_bytes) {
    out.push({ kind: "too_large", message: `larger than ${entry.max_bytes} bytes`, severity });
  }

  return out;
}

/** The reason this destination cannot take this asset, or null when it can.
 *  Only "refuse" violations disable a chip — a "warn" (a limit that varies by account,
 *  like Discord's) is shown but never blocks the send. Generalizes what used to be
 *  facebook-reel-spec.ts's facebookReelDisabledReason to every platform/surface this
 *  file has an entry for — Facebook Reels is now one case of the general rule, not a
 *  special one. */
export function destinationDisabledReason(
  platform: string, surface: string, asset: AssetLike,
): string | null {
  const refusals = checkMedia(platform, surface, asset).filter((v) => v.severity === "refuse");
  if (refusals.length === 0) return null;
  const surfaceLabel = surface === "reel" ? "Reels" : surface === "story" ? "Stories" : "the feed";
  const v = refusals[0];
  const lead = v.kind === "too_long" ? "Too long for"
    : v.kind === "too_short" ? "Too short for"
    : v.kind === "too_small" ? "Too small for"
    : v.kind === "too_large" ? "Too large for"
    : "Wrong shape for";
  return `${lead} ${surfaceLabel} (${v.message})`;
}

/**
 * True when SOME destination that can actually PUBLISH this media kind would accept it.
 * The upload gate's only job: refuse what nothing can take. Which destination a post
 * actually goes to is the composer's question, and it is the only place the app knows
 * the answer.
 *
 * This only asks a destination about a surface it can genuinely publish that media kind
 * to — `videoSurfaces(platform)` for video, `supportsImages(platform)` (+ the feed/story
 * surfaces a platform actually offers) for images. An earlier version of this function
 * iterated every platform/surface *recorded in media-limits.json* and accepted if any had
 * zero refusals. That is wrong: Threads has an image entry recorded for "feed" but NO
 * video publish path at all (`videoSurfaces("threads")` is `[]`, mirroring
 * `worker/clients.py`'s `PLATFORM_CAPS["threads"].video_surfaces`, an empty frozenset).
 * Asking `checkMedia("threads", "feed", videoAsset)` about a media kind Threads has no
 * entry for returns "no violations" — because `limitsFor` found nothing to check, not
 * because Threads would take the video. A 30-minute video was "accepted via threads/feed"
 * under that logic, which is nonsense: Threads cannot publish video at all. "No limit
 * recorded" and "this destination accepts anything" are different claims, and only the
 * per-platform capability flags (not presence in the JSON file) can tell them apart.
 *
 * WHY THIS NEVER REFUSES A VIDEO ON THIS INSTALL TODAY: TikTok can publish video
 * (`videoSurfaces("tiktok")` is `["feed"]`), but TikTok's limits are deliberately absent
 * from media-limits.json — they are per-creator and fetched at runtime from TikTok's
 * `creator_info` endpoint, not a static fact anyone can write down here (verified in an
 * earlier task; see reference.md). With TikTok in the platform list and its limits
 * unknown, `checkMedia("tiktok", "feed", asset)` can never report a refusal for ANY
 * duration — so this function can never prove that *nothing* accepts a given video, and
 * refuses none. That is the honest consequence of "only refuse what we can verify," not a
 * bug: it will look like a broken gate to the next reader until they read this comment.
 * An install without a TikTok channel configured would still see this function refuse an
 * over-long video normally — TikTok's mere presence in the *platform list* (not a
 * channel) is what keeps this permissive, since the gate has no way to know at upload
 * time which platforms the owner has actually connected.
 *
 * `data` defaults to the real media-limits.json for every production call. Tests pass a
 * synthetic `data` to exercise the refusal branch, which today's real data cannot reach.
 */
export function anyDestinationAccepts(asset: AssetLike, data: PlatformsData = REAL_PLATFORMS): boolean {
  const kind = asset.media_kind ?? "";
  for (const { value: platform } of PLATFORMS) {
    const surfaces: string[] =
      kind === "video" ? videoSurfaces(platform)
      : kind === "image" && supportsImages(platform) ? (supportsStory(platform) ? ["feed", "story"] : ["feed"])
      : [];
    for (const surface of surfaces) {
      const refusals = checkMedia(platform, surface, asset, data).filter((v) => v.severity === "refuse");
      if (refusals.length === 0) return true;
    }
  }
  return false;
}

/**
 * Which video destinations the conformed derivative (the Instagram-shaped, downscaled/
 * re-encoded copy built at upload time) actually gets USED by, once built —
 * i.e. which surfaces' `_resolve_rel` (worker/publisher.py) would ever read publish_path
 * for video. NOT every platform/surface that happens to have a video entry in
 * media-limits.json:
 *
 *   - instagram/feed  — needs_conformed_media=True (worker/clients.py), and _resolve_rel
 *     prefers publish_path here. Included.
 *   - instagram/story — ALSO needs_conformed_media=True, but _resolve_rel's story branch
 *     is `canvas or original or conformed`: it reads story_path (a separate 9:16 canvas
 *     built by a different pipeline, migration 0015), falling back to the untouched
 *     original, and only reaches the feed-shaped conformed derivative as a last-ditch
 *     fallback nothing in normal operation exercises. Building a feed-conform derivative
 *     for a surface that never wants it is exactly the waste this function exists to
 *     avoid. Excluded.
 *   - facebook/feed   — feed_video_is_constrained=False: the endpoint accepts any aspect
 *     ratio, so _resolve_rel prefers the untouched original. Excluded.
 *   - facebook/reel   — feed_video_is_constrained has no effect here (that flag only
 *     covers the *feed* surface); Reels ARE aspect/size constrained, so _resolve_rel
 *     prefers publish_path. Included.
 *   - tiktok/feed     — needs_conformed_media=False (TikTok's own upload API handles
 *     transcoding). Excluded.
 */
const CONFORM_REQUIRING: Array<[platform: string, surface: string]> = [
  ["instagram", "feed"],
  ["facebook", "reel"],
];

// Violation kinds a re-encode/downscale can actually repair. Mirrors video-spec.ts's
// fatal/convertible split (same reasoning, same naming intent, different data source):
// this app never trims or crops footage — that is an editorial decision it must not
// make — so a duration or framing problem is never fixable by conversion. A resolution,
// byte-size, or container/codec problem genuinely is.
const FIXABLE_BY_CONVERSION: ReadonlySet<Violation["kind"]> = new Set(["too_large", "wrong_format"]);

/**
 * Whether building the conformed derivative is worth it for this VIDEO asset: true only
 * when some destination that actually USES a conformed derivative (see
 * CONFORM_REQUIRING's comment) either already accepts this asset as-is, or refuses it
 * only for reasons conversion can fix.
 *
 * This is deliberately NOT "would a conform-requiring destination accept this asset
 * today" — that phrasing gets the everyday case backwards. A 4K vertical clip
 * (2160x3840) is refused by Instagram's feed for being too wide (max_width 1920), and
 * downscaling to 1920 is exactly what conforming does. Asking "does it already fit"
 * would skip the transcode in precisely the case the transcode exists to fix — this is
 * not hypothetical, it is the owner's iPhone's default 4K recording. So each
 * conform-requiring destination is asked "after conversion could fix what conversion CAN
 * fix, would this still be refused?" — i.e. do only NON-fixable ("refuse") violations
 * remain? If every conform-requiring destination has at least one non-fixable refusal
 * (too_short/too_long/too_small/wrong_aspect — trimming/reframing, which this app never
 * does), there is nothing conversion could achieve for any of them, and building the
 * derivative would be pure waste (e.g. an 18-minute clip: too_long for both Instagram's
 * feed and Facebook's Reels, and no re-encode adds time back).
 *
 * `data` defaults to the real media-limits.json for every production call, same pattern
 * as `anyDestinationAccepts` above — tests pass a synthetic `data` to pin the
 * CONFORM_REQUIRING exclusion list itself (e.g. proving instagram/story staying excluded
 * actually matters), which real data cannot exercise on demand.
 */
export function needsConformedDerivative(asset: AssetLike, data: PlatformsData = REAL_PLATFORMS): boolean {
  return CONFORM_REQUIRING.some(([platform, surface]) => {
    const refusals = checkMedia(platform, surface, asset, data).filter((v) => v.severity === "refuse");
    return refusals.every((v) => FIXABLE_BY_CONVERSION.has(v.kind));
  });
}
