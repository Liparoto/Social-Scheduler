/*
  Pure geometry for the FEED's aspect-ratio range — no image library, no Node built-ins.

  Split from conform.ts for exactly the reason story-geometry.ts is split from
  story-canvas.ts: conform.ts imports `sharp`, a native module that cannot be bundled for
  the browser, and the post preview is a CLIENT component that needs to know what shape a
  conformed image will come back as. Importing the bounds from conform.ts would drag sharp
  into the client bundle and break the page — a failure the tests cannot see, since they
  run in Node where sharp resolves fine.

  conform.ts imports its bounds FROM here, so there is one definition. Two copies of
  "what shape does Instagram accept" that drift apart is how a preview starts lying.
*/

export const FEED_MIN_RATIO = 4 / 5; // 0.8 — portrait bound
export const FEED_MAX_RATIO = 1.91; // landscape bound

// Two conformed slides whose ratios differ by less than this are the same shape as far as
// anyone looking at them is concerned. Whole-pixel rounding moves a ratio slightly and
// must not produce a warning nobody can act on. Mirrors STORY_RATIO_TOLERANCE's 2%.
export const FEED_RATIO_TOLERANCE = 0.02;

/**
 * The aspect ratio the conformed derivative will have — width / height.
 *
 * conformImage() clamps an out-of-range source to the nearest bound, and does so for BOTH
 * crop and pad (they differ in what they do with the pixels, not in the shape they produce),
 * so the mode is not a parameter here. A source already in range is left alone.
 *
 * Returns null when the dimensions are unknown, so a caller falls back to measuring the
 * real image rather than rendering a confidently wrong frame.
 */
export function feedRatio(width: number | null, height: number | null): number | null {
  if (!width || !height) return null;
  const ratio = width / height;
  if (ratio < FEED_MIN_RATIO) return FEED_MIN_RATIO;
  if (ratio > FEED_MAX_RATIO) return FEED_MAX_RATIO;
  return ratio;
}

/**
 * True when a carousel's slides will not all be the same shape.
 *
 * Worth surfacing because conformance treats each asset independently: a portrait and a
 * landscape shot in one carousel produce differently-shaped derivatives. What Instagram
 * then does with a mixed-shape carousel is NOT verified anywhere in this project's
 * reference.md, so the preview states the mismatch rather than predicting the outcome —
 * the actionable part is that the owner can re-frame to match.
 *
 * Unknown shapes (a video slide, an asset with no recorded dimensions) are ignored rather
 * than counted as different: absence of information is not evidence of a mismatch.
 */
export function feedShapesDisagree(ratios: (number | null)[]): boolean {
  const known = ratios.filter((r): r is number => typeof r === "number" && r > 0);
  if (known.length < 2) return false;
  const min = Math.min(...known);
  const max = Math.max(...known);
  return max - min > min * FEED_RATIO_TOLERANCE;
}

/**
 * True when the source is NOT already inside the feed's range and therefore gets reshaped.
 *
 * When this is false, conformImage() resolves mode "none" and leaves the shape untouched —
 * so Crop and Pad produce byte-identical framing and offering them as a choice is a lie.
 * Mirrors needsStoryCanvas(), which the Story column already uses for the same purpose.
 *
 * Returns false on unknown dimensions: absence of information is not evidence that the
 * image needs work, and a caller must not print "nothing to choose" off a guess.
 */
export function needsFeedConform(width: number | null, height: number | null): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio < FEED_MIN_RATIO || ratio > FEED_MAX_RATIO;
}
