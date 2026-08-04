import sharp from "sharp";
import { STORY_WIDTH, STORY_HEIGHT, type StoryMode } from "./story-geometry";

/*
  Rendering the 9:16 canvas an Instagram Story is published on. SERVER ONLY — this imports
  sharp, a native Node module that cannot be bundled for the browser. Client components must
  import from ./story-geometry instead, which is why the pure maths lives there.

  This is a SEPARATE pipeline from lib/conform.ts on purpose: conform.ts forces an image into
  the FEED's 4:5..1.91:1 range, while a story canvas is deliberately 0.5625. Running a canvas
  through conformImage() would undo it entirely.
*/

// Re-exported so server-side callers (the routes) have one import rather than two.
export {
  STORY_WIDTH,
  STORY_HEIGHT,
  STORY_RATIO,
  STORY_RATIO_TOLERANCE,
  needsStoryCanvas,
  cropLossFraction,
  type StoryMode,
} from "./story-geometry";

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
