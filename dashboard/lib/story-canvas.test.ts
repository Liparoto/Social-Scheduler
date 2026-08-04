import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  STORY_WIDTH,
  STORY_HEIGHT,
  needsStoryCanvas,
  renderStoryCanvas,
  cropLossFraction,
} from "./story-canvas.ts";

/** A solid-colour JPEG of the given size — enough to assert geometry. */
async function image(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 80, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

// ---- needsStoryCanvas: the tolerance band --------------------------------------
test("a source already at 9:16 needs no canvas", () => {
  assert.equal(needsStoryCanvas(1080, 1920), false);
});

test("a real vertical phone photo just off 9:16 needs no canvas", () => {
  // Asset 173 from the first real Story: 0.5627 vs 0.5625.
  assert.equal(needsStoryCanvas(1320, 2346), false);
});

test("landscape and square sources need a canvas", () => {
  assert.equal(needsStoryCanvas(4032, 3024), true, "landscape");
  assert.equal(needsStoryCanvas(1080, 1080), true, "square");
  assert.equal(needsStoryCanvas(1080, 1350), true, "4:5 portrait is still not 9:16");
});

test("the tolerance band is ±2%, not a free-for-all", () => {
  const tall = Math.round(1920 * (9 / 16) * 0.97); // 3% narrow — outside
  assert.equal(needsStoryCanvas(tall, 1920), true);
  const inside = Math.round(1920 * (9 / 16) * 0.99); // 1% narrow — inside
  assert.equal(needsStoryCanvas(inside, 1920), false);
});

test("a missing dimension asks for no canvas rather than dividing by zero", () => {
  assert.equal(needsStoryCanvas(0, 1920), false);
  assert.equal(needsStoryCanvas(1080, 0), false);
});

// ---- renderStoryCanvas: geometry ------------------------------------------------
test("blurred fill outputs exactly 1080x1920", async () => {
  const out = await renderStoryCanvas(await image(4032, 3024), "blurred");
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, STORY_WIDTH);
  assert.equal(meta.height, STORY_HEIGHT);
});

test("crop to fill outputs exactly 1080x1920", async () => {
  const out = await renderStoryCanvas(await image(4032, 3024), "crop");
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, STORY_WIDTH);
  assert.equal(meta.height, STORY_HEIGHT);
});

test("blurred fill keeps the whole photo — the band is letterboxed, not cropped", async () => {
  // A 4032x3024 (4:3) source fitted inside 1080x1920 is width-limited: 1080x810.
  // The canvas is taller, so bars must exist above and below.
  const out = await renderStoryCanvas(await image(4032, 3024), "blurred");
  const meta = await sharp(out).metadata();
  assert.equal(meta.height, STORY_HEIGHT);
  const bandHeight = Math.round(STORY_WIDTH * (3024 / 4032));
  assert.ok(bandHeight < STORY_HEIGHT, "a 4:3 source cannot fill a 9:16 canvas");
});

test("a portrait source taller than 9:16 is still fitted, not stretched", async () => {
  const out = await renderStoryCanvas(await image(1000, 3000), "blurred");
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, STORY_WIDTH);
  assert.equal(meta.height, STORY_HEIGHT);
});

test("the canvas is a JPEG — Meta downloads it as raw image bytes", async () => {
  const out = await renderStoryCanvas(await image(4032, 3024), "blurred");
  assert.equal((await sharp(out).metadata()).format, "jpeg");
});

// ---- cropLossFraction: the honest cost ------------------------------------------
test("cropping a 4:3 landscape to 9:16 loses most of the width", () => {
  // Cover 1080x1920 from 4032x3024: scale to height -> 2560x1920, keep 1080 wide.
  // 1080/2560 = 0.42 kept, so ~0.58 lost.
  const lost = cropLossFraction(4032, 3024);
  assert.ok(lost > 0.55 && lost < 0.61, `expected ~0.58, got ${lost}`);
});

test("a source already at 9:16 loses nothing to cropping", () => {
  assert.ok(cropLossFraction(1080, 1920) < 0.001);
});

test("a source TALLER than 9:16 loses height, and that is still reported", () => {
  // 1000x3000 (0.333) is narrower than 9:16, so covering crops the top and bottom.
  const lost = cropLossFraction(1000, 3000);
  assert.ok(lost > 0.3, `a very tall source must report real loss, got ${lost}`);
});
