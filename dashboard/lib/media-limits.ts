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

export function limitsFor(platform: string, surface: string, mediaKind: string): Entry | null {
  // Cast through unknown: the imported JSON literal's inferred type (e.g. min_aspect as
  // number[]) is narrower in shape than the field-by-field Entry type below, but the
  // actual values are validated at load time by worker/media_limits.py's schema check —
  // both languages read the identical file.
  const p = (raw as unknown as RawLimits).platforms?.[platform];
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

export function checkMedia(platform: string, surface: string, asset: AssetLike): Violation[] {
  const entry = limitsFor(platform, surface, asset.media_kind ?? "");
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
