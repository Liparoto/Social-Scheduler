import sharp, { type Sharp } from "sharp";

export const IG_MAX_BYTES = 8 * 1024 * 1024;
export const IG_MAX_WIDTH = 1440;
export const IG_MIN_WIDTH = 320;
export const IG_MIN_RATIO = 4 / 5; // 0.8 (portrait bound)
export const IG_MAX_RATIO = 1.91; // landscape bound

export type ConformMode = "none" | "crop" | "pad";

export interface ConformResult {
  buffer: Buffer;
  mode: ConformMode;
  needsReview: boolean;
  width: number;
  height: number;
  lowRes: boolean;
}

/** Nearest in-range ratio for an out-of-range image (w/h). */
function targetRatio(ratio: number): number {
  return ratio < IG_MIN_RATIO ? IG_MIN_RATIO : IG_MAX_RATIO;
}

async function encodeUnderLimit(pipe: Sharp): Promise<Buffer> {
  for (const quality of [90, 82, 74, 66, 58, 50]) {
    const out = await pipe.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= IG_MAX_BYTES) return out;
  }
  return pipe.clone().jpeg({ quality: 45, mozjpeg: true }).toBuffer();
}

export async function conformImage(
  input: Buffer,
  mode: ConformMode = "crop",
): Promise<ConformResult> {
  // Normalize: honor EXIF rotation, strip to sRGB, cap width at 1440.
  const base = sharp(input).rotate().toColourspace("srgb");
  const meta = await base.metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;
  const ratio = srcH === 0 ? 1 : srcW / srcH;
  const lowRes = srcW < IG_MIN_WIDTH;

  let pipe = base.clone();
  // Track the working dimensions ourselves: sharp's metadata() reflects the
  // *input* image, not pipeline operations queued via resize()/rotate(), so
  // querying it again after .resize() still reports the pre-resize size.
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
    const tr = targetRatio(ratio);
    // Work from the (possibly downscaled) current dimensions.
    const w = curW;
    const h = curH;
    if (resolvedMode === "crop") {
      // Center-crop to target ratio.
      let cw = w;
      let ch = Math.round(w / tr);
      if (ch > h) {
        ch = h;
        cw = Math.round(h * tr);
      }
      pipe = pipe.extract({
        left: Math.floor((w - cw) / 2),
        top: Math.floor((h - ch) / 2),
        width: cw,
        height: ch,
      });
    } else {
      // Pad (letterbox) to target ratio on a white background.
      let pw = w;
      let ph = Math.round(w / tr);
      if (ph < h) {
        ph = h;
        pw = Math.round(h * tr);
      }
      pipe = pipe.extend({
        top: Math.floor((ph - h) / 2),
        bottom: Math.ceil((ph - h) / 2),
        left: Math.floor((pw - w) / 2),
        right: Math.ceil((pw - w) / 2),
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      });
    }
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
