/*
  Pure geometry for the 9:16 story canvas — no image library, no Node built-ins.

  This is split from story-canvas.ts deliberately. story-canvas.ts imports `sharp`, which is
  a native Node module and cannot be bundled for the browser; the framing dialog is a CLIENT
  component that needs `needsStoryCanvas` and `cropLossFraction` to decide what to offer and
  what to say a choice costs. Importing those from the sharp module took sharp down the
  client bundle with them and broke the whole page — invisible to the tests, which run in
  Node where sharp resolves fine.

  Rule of thumb: anything a client component needs belongs here; anything that touches
  pixels belongs in story-canvas.ts.
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
