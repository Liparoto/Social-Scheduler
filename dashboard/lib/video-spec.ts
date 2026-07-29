/**
 * Instagram Reels publishing limits, re-verified against Meta's IG User Media reference
 * on 2026-07-28 (the `#reels-specs` section).
 *
 * These numbers contradict widely-circulated third-party "2026 guides" that claim a 4GB
 * cap and a 90-second maximum. Both are wrong. Do not "correct" these from memory —
 * re-read the live docs if they look surprising.
 */
import type { VideoMeta } from "./video-meta";

const MB = 1024 * 1024;

export const REEL_SPEC = {
  maxBytes: 300 * MB,
  minDurationMs: 3_000,
  maxDurationMs: 15 * 60 * 1000,
  maxWidth: 1920,
  // Instagram accepts 0.01:1 to 10:1. We warn — not refuse — outside a sensible vertical
  // band, because a landscape Reel is a valid post that simply letterboxes (Decision 4).
  warnBelowRatio: 0.5,   // width/height; 9:16 is 0.5625
  warnAboveRatio: 0.8,
} as const;

export const REEL_MIME_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export interface ReelCheck {
  errors: string[];
  warnings: string[];
}

/**
 * Splits Reels validation failures into three buckets:
 * - `fatal` — trimming (duration) is an editorial decision the app must never make, and no
 *   amount of re-encoding adds footage back. These can never be fixed by conversion.
 * - `convertible` — too wide, too large, the wrong container, 'moov' trailing 'mdat', or
 *   an HEVC codec. Downscaling/re-encoding genuinely fixes all of these, so a caller may
 *   offer to convert and retry.
 * - `warnings` — never block a post; Instagram accepts and letterboxes/publishes anyway.
 *
 * This reports every bucket's problems honestly and independently — it does not suppress
 * `convertible` when `fatal` is non-empty. "Don't waste time converting a video that's going
 * to be refused for length anyway" is the upload route's job (check `fatal` first, return
 * before considering conversion), not this classifier's. A classifier describes the video;
 * it doesn't encode a policy about what the caller should do next.
 */
export interface ReelClassification {
  fatal: string[];
  convertible: string[];
  warnings: string[];
}

export function classifyReelErrors(meta: VideoMeta, byteSize: number, mime: string): ReelClassification {
  const fatal: string[] = [];
  const convertible: string[] = [];
  const warnings: string[] = [];

  if (!REEL_MIME_TYPES[mime]) {
    convertible.push(
      `Reels must be MP4 or MOV. This file is ${mime || "of an unknown type"}.`
    );
  }
  if (byteSize > REEL_SPEC.maxBytes) {
    convertible.push(
      `This file is ${humanBytes(byteSize)}. Instagram caps Reels at 300 MB. ` +
        `Export it at a lower quality, or trim it.`
    );
  }
  if (meta.duration_ms < REEL_SPEC.minDurationMs) {
    fatal.push(
      `This is ${humanDuration(meta.duration_ms, "floor")}. Reels must be at least 3 seconds.`
    );
  }
  if (meta.duration_ms > REEL_SPEC.maxDurationMs) {
    fatal.push(
      `This is ${humanDuration(meta.duration_ms, "ceil")}. Reels cap at 15 minutes. ` +
        `Trim it in Photos and upload again.`
    );
  }
  if (meta.width > REEL_SPEC.maxWidth) {
    convertible.push(
      `This video is ${meta.width} pixels wide. Instagram caps Reels at 1920. ` +
        `Export it at 1080p and upload again.`
    );
  }
  if (!meta.moov_before_mdat) {
    convertible.push(
      `This video's index ('moov') is stored at the end of the file — common for iPhone ` +
        `camera originals. Instagram's servers require it at the front. Converting relocates it.`
    );
  }
  if (meta.is_hevc) {
    convertible.push(
      `This video uses HEVC (H.265) encoding. Many browsers — including this app's own ` +
        `previews — can't decode it. Converting to H.264 fixes previews, the cover picker, ` +
        `and Instagram's own compatibility.`
    );
  }

  const ratio = meta.width / meta.height;
  if (ratio < REEL_SPEC.warnBelowRatio || ratio > REEL_SPEC.warnAboveRatio) {
    warnings.push(
      `This video is ${meta.width}×${meta.height}. Reels are vertical (9:16), so this ` +
        `will letterbox — Instagram will still publish it.`
    );
  }
  if (!meta.has_audio) {
    warnings.push("This video has no audio track.");
  }

  return { fatal, convertible, warnings };
}

/**
 * Formats a duration for display. `direction` controls which way partial units round:
 * - "floor" (default): round down. Used when reporting a value that is BELOW a minimum,
 *   so the displayed number can never reach the minimum it's being rejected for.
 * - "ceil": round up. Used when reporting a value that is ABOVE a maximum, so the
 *   displayed number can never drop back down to the maximum it's being rejected for.
 *
 * Rounding happens at one-decisecond precision (not whole seconds) so a value just past
 * a minute boundary (e.g. 59,900ms) can't get carried into "1m00s" by the rounding itself —
 * only an actual >=60s duration displays as a whole minute.
 */
export function humanDuration(ms: number, direction: "floor" | "ceil" = "floor"): string {
  const roundFn = direction === "ceil" ? Math.ceil : Math.floor;
  const deciseconds = roundFn(ms / 100);
  const wholeSeconds = Math.floor(deciseconds / 10);
  const tenth = deciseconds - wholeSeconds * 10;

  if (wholeSeconds < 60) {
    return `${wholeSeconds}.${tenth}s`;
  }

  // The "Xm00s" format has no room for a decimal, so a "ceil" duration with any leftover
  // fraction must carry into the next whole second — otherwise an over-the-limit value
  // could still print as exactly the limit (e.g. 900,001ms must not print as "15m00s").
  const roundedSeconds = tenth > 0 && direction === "ceil" ? wholeSeconds + 1 : wholeSeconds;
  const m = Math.floor(roundedSeconds / 60);
  const s = roundedSeconds % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/**
 * Formats a byte size for display, always rounding UP to the next tenth of a MB. This is
 * only ever used to report a size that already failed the max-size check, so rounding
 * to-nearest would let a file 1 byte over the cap print as e.g. "300.0 MB" — indistinguishable
 * from the cap itself. Rounding up guarantees the printed number is always strictly greater
 * than the cap whenever the actual size is.
 */
export function humanBytes(bytes: number): string {
  const rounded = Math.ceil((bytes / MB) * 10) / 10;
  return `${rounded.toFixed(1)} MB`;
}

/**
 * Check a video against the Reels spec. Every problem is reported, not just the first —
 * being told "too long" then "too big" then "too wide" across three upload attempts is a
 * miserable way to find out.
 */
export function validateReel(meta: VideoMeta, byteSize: number, mime: string): ReelCheck {
  const c = classifyReelErrors(meta, byteSize, mime);
  return { errors: [...c.fatal, ...c.convertible], warnings: c.warnings };
}
