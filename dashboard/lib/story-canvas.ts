import sharp from "sharp";

/*
  The 9:16 canvas an Instagram Story is published on.

  This is a SEPARATE pipeline from lib/conform.ts on purpose. conform.ts forces an image
  into the FEED's 4:5..1.91:1 range; a story canvas is deliberately 0.5625, which is outside
  that range. Running a canvas through conformImage() would undo it entirely — never do that.
*/

export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;
export const STORY_RATIO = STORY_WIDTH / STORY_HEIGHT; // 0.5625

// A source this close to 9:16 is already the right shape: a canvas would add nothing and
// cost a re-encode, so the untouched original is published instead. 2% is wide enough to
// cover real phone photos (a 1320x2346 shot is 0.5627) and narrow enough that anything
// Instagram would visibly letterbox still gets a deliberate frame.
export const STORY_RATIO_TOLERANCE = 0.02;

export type StoryMode = "blurred" | "crop";

/** True when the source is NOT already story-shaped and deserves a canvas. */
export function needsStoryCanvas(width: number, height: number): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  return Math.abs(ratio - STORY_RATIO) > STORY_RATIO * STORY_RATIO_TOLERANCE;
}

/**
 * How much of the source is thrown away by crop-to-fill, as a fraction of its longer axis.
 *
 * Drives the framing dialog's honest label ("loses 58% of the width"). A generic "some
 * cropping may occur" is exactly the vagueness that made the old 40px preview useless —
 * the owner should be told what a choice costs, in numbers, before making it.
 */
export function cropLossFraction(width: number, height: number): number {
  if (!width || !height) return 0;
  const ratio = width / height;
  // Cover scales by whichever axis falls short, then crops the other. A wider-than-9:16
  // source loses width; a narrower (very tall) one loses height.
  const kept = ratio > STORY_RATIO ? STORY_RATIO / ratio : ratio / STORY_RATIO;
  return Math.max(0, 1 - kept);
}

/**
 * Render a 1080x1920 story canvas.
 *
 *  * blurred — the photo is fitted whole, and an enlarged, blurred, slightly darkened copy
 *    of the SAME photo fills the space behind it. Nothing is lost.
 *  * crop    — scaled to cover and cropped. sharp's `attention` strategy picks the region,
 *    which is a guess; cropLossFraction() is how the owner is told what it costs.
 */
export async function renderStoryCanvas(input: Buffer, mode: StoryMode): Promise<Buffer> {
  // Honor EXIF rotation and normalize colour before measuring or compositing. This MUST be
  // materialized into a real buffer first — same reasoning as conform.ts: sharp's
  // metadata() reflects what has actually been EXECUTED, not operations merely queued, so
  // reading it straight after .rotate() returns the PRE-rotation dimensions, which are
  // swapped for any EXIF orientation needing a 90/270 turn (routine for phone photos).
  const base = await sharp(input).rotate().toColourspace("srgb").toBuffer();

  if (mode === "crop") {
    return sharp(base)
      .resize({
        width: STORY_WIDTH,
        height: STORY_HEIGHT,
        fit: "cover",
        position: "attention",
      })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
  }

  const fitted = await sharp(base)
    .resize({ width: STORY_WIDTH, height: STORY_HEIGHT, fit: "inside" })
    .toBuffer();
  // The backdrop is the same photo, blown up to cover and blurred. Darkening it slightly
  // keeps the fitted copy in front readable rather than blending into its own background.
  const background = await sharp(base)
    .resize({ width: STORY_WIDTH, height: STORY_HEIGHT, fit: "cover" })
    .blur(40)
    .modulate({ brightness: 0.8 })
    .toBuffer();

  return sharp(background)
    .composite([{ input: fitted, gravity: "centre" }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}
