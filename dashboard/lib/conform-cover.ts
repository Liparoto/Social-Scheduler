// dashboard/lib/conform-cover.ts
//
// THIS IS NOT THE FEED CONFORM (dashboard/lib/conform.ts). Do not merge the two.
//
// conformImage() exists to force a feed image into Instagram's 0.8-1.91 aspect range —
// that is its entire purpose. A Reels cover is a DIFFERENT target: Instagram recommends
// 9:16 (0.5625) and, if the uploaded image isn't 9:16, Meta itself center-crops to the
// middle 9:16 rectangle server-side. Running a cover through conformImage's crop/pad
// logic would silently mangle the framing the owner deliberately chose down to the feed
// range (0.8) — a completely different, wrong rectangle. So this conform touches ONLY
// colour space and file size. It never resizes or crops for aspect ratio; it only warns
// when the ratio is far from 9:16, naming what Instagram will do to it. If a future
// change makes this function "simplify" into calling conformImage, or into resizing to
// fit COVER_RATIO, it has broken the entire reason this file exists.
import sharp from "sharp";

export const COVER_MAX_BYTES = 8 * 1024 * 1024;
export const COVER_RATIO = 9 / 16; // 0.5625 — Instagram's recommended Reels cover ratio
const COVER_RATIO_TOLERANCE = 0.02; // small slop so a near-exact 9:16 image doesn't warn

export interface ConformCoverResult {
  buffer: Buffer;
  width: number;
  height: number;
  warnings: string[];
}

async function encodeUnderLimit(input: Buffer): Promise<Buffer> {
  // EXIF-rotate and force sRGB — the only pixel-affecting operations this conform
  // performs. No resize, no extract, no extend: dimensions in equal dimensions out.
  const normalized = sharp(input).rotate().toColourspace("srgb");
  for (const quality of [90, 82, 74, 66, 58, 50]) {
    const out = await normalized.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= COVER_MAX_BYTES) return out;
  }
  return normalized.clone().jpeg({ quality: 45, mozjpeg: true }).toBuffer();
}

export async function conformCover(input: Buffer): Promise<ConformCoverResult> {
  // Materialize the rotation before reading metadata — sharp's .metadata() reflects
  // the dimensions of whatever has actually been EXECUTED, not operations merely
  // queued on a pipeline. Reading metadata right after queuing .rotate() (without
  // executing it) returns the source's PRE-rotation width/height for any EXIF
  // orientation tag that requires a 90/270 degree turn (tags 5-8, routine for
  // vertical phone photos) — the same trap conform.ts guards against.
  const rotated = await sharp(input).rotate().toColourspace("srgb").toBuffer();
  const meta = await sharp(rotated).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const ratio = height === 0 ? 1 : width / height;

  const warnings: string[] = [];
  if (Math.abs(ratio - COVER_RATIO) > COVER_RATIO_TOLERANCE) {
    warnings.push(
      `This cover is not 9:16 (it's ${width}x${height}). Instagram will crop it to the ` +
        "middle 9:16 rectangle rather than showing the full image — recompose to 9:16 " +
        "if you want to control the framing yourself."
    );
  }

  const buffer = await encodeUnderLimit(rotated);
  const outMeta = await sharp(buffer).metadata();
  return {
    buffer,
    width: outMeta.width ?? width,
    height: outMeta.height ?? height,
    warnings,
  };
}
