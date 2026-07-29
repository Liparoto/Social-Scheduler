import sharp, { type Sharp } from "sharp";

export const IG_MAX_BYTES = 8 * 1024 * 1024;
export const IG_MAX_WIDTH = 1440;
export const IG_MIN_WIDTH = 320;
export const IG_MIN_RATIO = 4 / 5; // 0.8 (portrait bound)
export const IG_MAX_RATIO = 1.91; // landscape bound

// "downscale" is never produced by conformImage() below (image-only) — it's included
// here because it's the video-upload equivalent of this same "how was this asset
// reframed for publishing" concept, and Asset.conform_mode (lib/types.ts) is one
// shared column/type across both media kinds.
export type ConformMode = "none" | "crop" | "pad" | "downscale";

export interface ConformResult {
  buffer: Buffer;
  mode: ConformMode;
  needsReview: boolean;
  width: number;
  height: number;
  lowRes: boolean;
}

async function encodeUnderLimit(pipe: Sharp): Promise<Buffer> {
  // Flatten transparency to white before encoding — a no-op on images without
  // an alpha channel, and consistent with the white pad background above.
  const flattened = pipe.flatten({ background: { r: 255, g: 255, b: 255, alpha: 1 } });
  for (const quality of [90, 82, 74, 66, 58, 50]) {
    const out = await flattened.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= IG_MAX_BYTES) return out;
  }
  return flattened.clone().jpeg({ quality: 45, mozjpeg: true }).toBuffer();
}

export async function conformImage(
  input: Buffer,
  mode: ConformMode = "crop",
): Promise<ConformResult> {
  // Normalize: honor EXIF rotation, strip to sRGB. This MUST be materialized
  // into a real buffer before we read metadata — sharp's .metadata() reflects
  // the dimensions of whatever has actually been *executed*, not operations
  // merely queued on a pipeline (.rotate(), .resize(), etc). Reading metadata
  // right after queuing .rotate() (without executing it) returns the source's
  // PRE-rotation width/height, which are swapped for any EXIF orientation tag
  // that requires a 90°/270° turn (tags 5-8 — routine for vertical phone
  // photos). Executing first guarantees srcW/srcH below are the true,
  // post-rotation pixel dimensions that every downstream calculation depends on.
  const rotated = await sharp(input).rotate().toColourspace("srgb").toBuffer();
  const meta = await sharp(rotated).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  const ratio = srcH === 0 ? 1 : srcW / srcH;
  const lowRes = srcW < IG_MIN_WIDTH;

  let pipe = sharp(rotated);
  // Track the working dimensions ourselves: sharp's metadata() reflects the
  // *input* image, not pipeline operations queued via resize(), so querying
  // it again after .resize() still reports the pre-resize size.
  let curW = srcW;
  let curH = srcH;
  if (srcW > IG_MAX_WIDTH) {
    pipe = pipe.resize({ width: IG_MAX_WIDTH });
    curW = IG_MAX_WIDTH;
    curH = Math.round((srcH * IG_MAX_WIDTH) / srcW);
  }

  const inRange = ratio >= IG_MIN_RATIO && ratio <= IG_MAX_RATIO;
  let resolvedMode: ConformMode = "none";

  if (!inRange) {
    resolvedMode = mode === "pad" ? "pad" : "crop";
    // Work from the (possibly downscaled) current dimensions.
    const w = curW;
    const h = curH;
    const tooWide = ratio > IG_MAX_RATIO;
    if (resolvedMode === "crop") {
      // Center-crop toward the target bound, shrinking only one dimension.
      // Math.floor on the constrained dimension guarantees the resulting
      // ratio lands strictly within [MIN, MAX] even after integer rounding
      // (Math.round can push a ratio a hair past the bound it's supposed to
      // satisfy, e.g. 3000x1000 landing at ~1.9104 > 1.91).
      let cw = w;
      let ch = h;
      if (tooWide) {
        cw = Math.floor(h * IG_MAX_RATIO);
      } else {
        ch = Math.floor(w / IG_MIN_RATIO);
      }
      pipe = pipe.extract({
        left: Math.floor((w - cw) / 2),
        top: Math.floor((h - ch) / 2),
        width: cw,
        height: ch,
      });
      curW = cw;
      curH = ch;
    } else {
      // Pad (letterbox) toward the target bound, growing only one dimension.
      // Math.ceil guarantees the resulting ratio lands within [MIN, MAX].
      let pw = w;
      let ph = h;
      if (tooWide) {
        ph = Math.ceil(w / IG_MAX_RATIO);
      } else {
        pw = Math.ceil(h * IG_MIN_RATIO);
      }
      pipe = pipe.extend({
        top: Math.floor((ph - h) / 2),
        bottom: Math.ceil((ph - h) / 2),
        left: Math.floor((pw - w) / 2),
        right: Math.ceil((pw - w) / 2),
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      });
      curW = pw;
      curH = ph;
    }
  }

  // Final safeguard: the pad branch can grow width past IG_MAX_WIDTH for
  // extreme-tall sources (e.g. a 3000x4000 source downscales to 1440x1920,
  // then pads to pw = ceil(1920*0.8) = 1536). Never let the encoded buffer
  // exceed the engine's own width contract — resize preserves the (in-range)
  // ratio. Crop mode only shrinks dimensions, so this is a no-op for it.
  //
  // Materialize before re-resizing: sharp merges multiple queued .resize()
  // calls into a single op applied against the ORIGINAL input (not against
  // the intermediate extract/extend result), so calling .resize() again on
  // a pipe that already queued one from the initial downscale (line ~55)
  // would silently recompute from srcW/srcH and ignore the pad's growth.
  // Executing to a buffer first forces the queued ops to run, so the
  // fresh sharp() below resizes the ACTUAL current pixels.
  if (curW > IG_MAX_WIDTH) {
    const materialized = await pipe.toBuffer();
    pipe = sharp(materialized).resize({ width: IG_MAX_WIDTH });
  }

  const buffer = await encodeUnderLimit(pipe);
  const outMeta = await sharp(buffer).metadata();
  return {
    buffer,
    mode: resolvedMode,
    needsReview: !inRange,
    width: outMeta.width ?? 0,
    height: outMeta.height ?? 0,
    lowRes,
  };
}
