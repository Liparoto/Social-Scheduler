// dashboard/scripts/conform-smoke.mjs — run: node dashboard/scripts/conform-smoke.mjs
import sharp from "sharp";
import { conformImage, IG_MAX_WIDTH, IG_MAX_BYTES, IG_MIN_RATIO, IG_MAX_RATIO } from "../lib/conform.ts";

const mk = (w, h) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 80, b: 40 } } })
    .png()
    .toBuffer();

function assert(name, cond) {
  if (!cond) throw new Error("FAIL: " + name);
  console.log("ok:", name);
}

const ratioOf = (r) => r.width / r.height;

// In-range square: safe fixes only, no review.
let r = await conformImage(await mk(2000, 2000));
assert("square: downscaled to <=1440", r.width <= IG_MAX_WIDTH);
assert("square: mode none", r.mode === "none");
assert("square: no review", r.needsReview === false);
assert("square: under 8MB", r.buffer.length <= IG_MAX_BYTES);

// Too wide (3:1) -> crop by default, flagged, ratio pulled into range.
r = await conformImage(await mk(3000, 1000));
assert("wide: mode crop", r.mode === "crop");
assert("wide: needs review", r.needsReview === true);
assert("wide: ratio <= 1.91", ratioOf(r) <= IG_MAX_RATIO);

// Too tall (9:16) -> pad option keeps full height, ratio pulled up to 0.8.
r = await conformImage(await mk(900, 1600), "pad");
assert("tall pad: mode pad", r.mode === "pad");
assert("tall pad: ratio >= 0.8", ratioOf(r) >= IG_MIN_RATIO);

// EXIF-rotated (portrait phone photo, orientation tag 6 -> 90deg rotate).
// Baked as a 2000x1000 (2:1, too wide) source with orientation 6, so once
// sharp's .rotate() executes the tag the TRUE pixels are 1000x2000 (portrait,
// too tall, ratio 0.5). Before the fix, metadata() read right after queuing
// .rotate() reported the PRE-rotation 2000x1000 dims, so the too-wide branch
// ran against pixels that were actually too-tall -> extract region larger
// than the real buffer -> "extract_area: bad extract area" crash.
const orientedSrc = await sharp({
  create: { width: 2000, height: 1000, channels: 3, background: { r: 30, g: 60, b: 90 } },
})
  .withMetadata({ orientation: 6 })
  .jpeg()
  .toBuffer();
r = await conformImage(orientedSrc);
assert("rotated: does not throw / returns", !!r.buffer);
assert("rotated: ratio in range", ratioOf(r) >= IG_MIN_RATIO && ratioOf(r) <= IG_MAX_RATIO);
assert("rotated: under 8MB", r.buffer.length <= IG_MAX_BYTES);

console.log("\nALL CONFORM SMOKE CHECKS PASSED");
