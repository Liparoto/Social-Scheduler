import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  conformImage,
  IG_MAX_WIDTH,
  IG_MIN_WIDTH,
  IG_MIN_RATIO,
  IG_MAX_RATIO,
  IG_MAX_BYTES,
} from "./conform.ts";

/*
  Characterization tests for the FEED conform pipeline.

  This code reshapes every image uploaded to the app and had no tests at all. These encode
  what it does today, so a failure here is a real regression rather than a disagreement
  about intent.

  The contract worth defending: whatever goes in, what comes out is inside Instagram's
  accepted range (4:5 .. 1.91:1) and no wider than 1440px. Everything else is detail.
*/

/** A solid-colour JPEG of the given size — geometry is what's under test, not content. */
async function image(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 90, g: 120, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

function assertInRange(ratio: number, label: string) {
  assert.ok(
    ratio >= IG_MIN_RATIO && ratio <= IG_MAX_RATIO,
    `${label}: ratio ${ratio.toFixed(4)} is outside [${IG_MIN_RATIO}, ${IG_MAX_RATIO}]`
  );
}

// ---- In-range sources are left alone ---------------------------------------------
test("a square image is already in range and is not reframed", async () => {
  const out = await conformImage(await image(1080, 1080));
  assert.equal(out.mode, "none");
  assert.equal(out.needsReview, false);
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1080);
});

test("4:5 and 1.91:1 are the bounds themselves, and count as in range", async () => {
  const portrait = await conformImage(await image(1080, 1350)); // exactly 0.8
  assert.equal(portrait.mode, "none", "4:5 is the portrait bound, not past it");

  const landscape = await conformImage(await image(1910, 1000)); // exactly 1.91
  assert.equal(landscape.mode, "none", "1.91:1 is the landscape bound, not past it");
});

// ---- Downscaling ------------------------------------------------------------------
test("a source wider than 1440 is downscaled, keeping its ratio", async () => {
  const out = await conformImage(await image(2880, 2880));
  assert.equal(out.width, IG_MAX_WIDTH);
  assert.equal(out.height, IG_MAX_WIDTH, "a square stays square");
  assert.equal(out.mode, "none", "downscaling alone is not a reframe");
});

test("nothing ever comes out wider than 1440", async () => {
  for (const [w, h] of [[4032, 3024], [3000, 1000], [1000, 3000], [3000, 4000], [8000, 200]]) {
    for (const mode of ["crop", "pad"] as const) {
      const out = await conformImage(await image(w, h), mode);
      assert.ok(out.width <= IG_MAX_WIDTH, `${w}x${h} ${mode} -> ${out.width}px wide`);
    }
  }
});

// ---- The core contract: output is always in range ---------------------------------
// Genuinely outside 0.8..1.91. Note 4:3 (1.333) is NOT here: an ordinary phone photo is
// perfectly valid for the FEED and only needs reframing for a 9:16 STORY. Conflating the
// two ranges is the mistake this whole surface split exists to prevent.
const OUT_OF_RANGE: [number, number][] = [
  [3000, 1000], // 3.00  — far too wide
  [1000, 3000], // 0.33  — far too tall
  [8000, 200],  // 40.0  — panorama
  [200, 8000],  // 0.025 — skyscraper
  [1080, 1500], // 0.72  — just past the 4:5 portrait bound
];

test("crop brings every out-of-range source back inside the bounds", async () => {
  for (const [w, h] of OUT_OF_RANGE) {
    const out = await conformImage(await image(w, h), "crop");
    assertInRange(out.width / out.height, `crop ${w}x${h}`);
    assert.equal(out.mode, "crop");
  }
});

test("pad brings every out-of-range source back inside the bounds", async () => {
  for (const [w, h] of OUT_OF_RANGE) {
    const out = await conformImage(await image(w, h), "pad");
    assertInRange(out.width / out.height, `pad ${w}x${h}`);
    assert.equal(out.mode, "pad");
  }
});

test("an ordinary 4:3 phone photo is left alone by the FEED pipeline", async () => {
  // 1.333 is inside 0.8..1.91, so nothing is reframed — even though the same photo DOES
  // need a canvas for a 9:16 Story. The two surfaces have different ranges on purpose.
  const out = await conformImage(await image(4032, 3024), "crop");
  assert.equal(out.mode, "none");
  assert.equal(out.needsReview, false);
});

test("a 3000x1000 crop lands inside 1.91, not a hair past it", async () => {
  // The comment on the floor() in conform.ts names this case: Math.round would land at
  // ~1.9104, just over the bound it exists to satisfy.
  const out = await conformImage(await image(3000, 1000), "crop");
  assert.ok(out.width / out.height <= IG_MAX_RATIO);
});

// ---- The pad-overflow path the code comments warn about ---------------------------
test("a tall source padded past 1440 is resized back down, not left oversized", async () => {
  // 3000x4000 downscales to 1440x1920, then pad widens it to ceil(1920*0.8) = 1536 —
  // past the width contract. The safeguard resizes back to 1440, and it only works
  // because the pipeline is materialized first (sharp would otherwise merge the two
  // resizes and recompute from the ORIGINAL, ignoring the pad's growth).
  const out = await conformImage(await image(3000, 4000), "pad");
  assert.equal(out.width, IG_MAX_WIDTH, "must be clamped to the width contract");
  assert.equal(out.height, 1800, "and keep the padded 4:5 ratio, not the source's 3:4");
  assertInRange(out.width / out.height, "padded tall source");
});

test("crop never triggers the width safeguard — it only shrinks", async () => {
  const out = await conformImage(await image(3000, 4000), "crop");
  assert.ok(out.width <= IG_MAX_WIDTH);
  assertInRange(out.width / out.height, "cropped tall source");
});

// ---- Reported flags ----------------------------------------------------------------
test("needsReview is set exactly when the source was out of range", async () => {
  assert.equal((await conformImage(await image(1080, 1080))).needsReview, false);
  assert.equal((await conformImage(await image(3000, 1000))).needsReview, true);
});

test("lowRes reflects the SOURCE width, not the output", async () => {
  const small = await conformImage(await image(IG_MIN_WIDTH - 1, 400), "pad");
  assert.equal(small.lowRes, true);
  const fine = await conformImage(await image(IG_MIN_WIDTH, 400), "pad");
  assert.equal(fine.lowRes, false, "320 is the floor, not below it");
});

test("an unrecognised mode falls back to crop rather than passing through", async () => {
  // 'none' and 'downscale' are valid ConformMode values but not valid REFRAMING choices;
  // only an explicit 'pad' selects padding.
  const out = await conformImage(await image(3000, 1000), "none");
  assert.equal(out.mode, "crop");
});

// ---- Encoding ------------------------------------------------------------------------
test("the encoded buffer stays under Instagram's byte limit", async () => {
  const out = await conformImage(await image(1440, 1440));
  assert.ok(out.buffer.length <= IG_MAX_BYTES, `${out.buffer.length} bytes`);
});

test("transparency is flattened to white rather than encoded as black", async () => {
  const transparent = await sharp({
    create: { width: 1000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();

  const out = await conformImage(transparent);
  const { data, info } = await sharp(out.buffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3, "output is opaque JPEG, no alpha channel");
  // Sample the centre pixel; flattening uses white, matching the pad background.
  const mid = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
  assert.ok(data[mid] > 240 && data[mid + 1] > 240 && data[mid + 2] > 240,
    `expected near-white, got rgb(${data[mid]},${data[mid + 1]},${data[mid + 2]})`);
});

// ---- EXIF orientation ------------------------------------------------------------------
test("EXIF rotation is applied before dimensions are measured", async () => {
  // Orientation 6 means "rotate 90° CW to display". A 400x1000 stored image therefore
  // DISPLAYS as 1000x400 — and the pipeline must reason about the displayed pixels, or
  // every ratio decision below it is made on swapped dimensions.
  const rotated = await sharp({
    create: { width: 400, height: 1000, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

  const out = await conformImage(rotated, "pad");
  assert.ok(out.width > out.height, "the 90-degree turn must be honoured, not ignored");
  assertInRange(out.width / out.height, "EXIF-rotated source");
});
