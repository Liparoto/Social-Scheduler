// dashboard/scripts/conform-smoke.mjs — run: node dashboard/scripts/conform-smoke.mjs
import sharp from "sharp";
import { conformImage, IG_MAX_WIDTH, IG_MAX_BYTES } from "../lib/conform.ts";

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
assert("wide: ratio <= 1.91", ratioOf(r) <= 1.92);

// Too tall (9:16) -> pad option keeps full height, ratio pulled up to 0.8.
r = await conformImage(await mk(900, 1600), "pad");
assert("tall pad: mode pad", r.mode === "pad");
assert("tall pad: ratio >= 0.8", ratioOf(r) >= 0.79);

console.log("\nALL CONFORM SMOKE CHECKS PASSED");
