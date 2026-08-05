// dashboard/scripts/test-conform-cover.mjs — run: node dashboard/scripts/test-conform-cover.mjs
//
// conformCover is NOT the feed conform (dashboard/lib/conform.ts). The whole point of
// this test is that dimensions never change — see conform-cover.ts's file-header
// comment for why a Reels cover must never be resized or cropped.
import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import sharp from "sharp";
import { conformCover, COVER_MAX_BYTES } from "../lib/conform-cover.ts";

const mk = (w, h, opts = {}) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 90, g: 140, b: 200 } } })
    [opts.format ?? "png"]()
    .toBuffer();

// --- 9:16 input: no warnings, dimensions unchanged, output is JPEG -----------------
{
  const input = await mk(1080, 1920);
  const r = await conformCover(input);
  assert.deepEqual(r.warnings, [], "a proper 9:16 cover must not warn");
  assert.equal(r.width, 1080, "width must be unchanged");
  assert.equal(r.height, 1920, "height must be unchanged");
  const meta = await sharp(r.buffer).metadata();
  assert.equal(meta.format, "jpeg", "output must be JPEG");
  assert.equal(meta.width, 1080, "encoded buffer width must be unchanged");
  assert.equal(meta.height, 1920, "encoded buffer height must be unchanged");
  console.log("ok: 9:16 input passes through with no warning and unchanged dimensions");
}

// --- 1:1 input: exactly one warning naming the middle-9:16 crop, dims unchanged ----
{
  const input = await mk(1080, 1080);
  const r = await conformCover(input);
  assert.equal(r.warnings.length, 1, "a 1:1 cover must warn exactly once");
  assert.match(r.warnings[0], /middle.*9:16|9:16.*middle/i, "warning must name Instagram's middle-9:16 crop");
  assert.equal(r.width, 1080, "width must be unchanged — we do not crop");
  assert.equal(r.height, 1080, "height must be unchanged — we do not crop");
  console.log("ok: 1:1 input warns once and is left uncropped");
}

// --- 16:9 input: warns likewise, dimensions unchanged ------------------------------
{
  const input = await mk(1920, 1080);
  const r = await conformCover(input);
  assert.equal(r.warnings.length, 1, "a 16:9 cover must warn exactly once");
  assert.match(r.warnings[0], /middle.*9:16|9:16.*middle/i, "warning must name Instagram's middle-9:16 crop");
  assert.equal(r.width, 1920, "width must be unchanged — we do not crop");
  assert.equal(r.height, 1080, "height must be unchanged — we do not crop");
  console.log("ok: 16:9 input warns once and is left uncropped");
}

// --- PNG input: output is JPEG -----------------------------------------------------
{
  const input = await mk(1080, 1920, { format: "png" });
  const meta0 = await sharp(input).metadata();
  assert.equal(meta0.format, "png", "sanity: input really is a PNG");
  const r = await conformCover(input);
  const meta = await sharp(r.buffer).metadata();
  assert.equal(meta.format, "jpeg", "PNG input must be converted to JPEG output");
  console.log("ok: PNG input is converted to JPEG");
}

// --- Deliberately large input: output must be <= 8 MB ------------------------------
{
  // A large, high-entropy 9:16 image so JPEG encoding at high quality would exceed 8MB
  // and force the quality-stepping loop to kick in. Random noise (via randomFillSync,
  // native and fast) compresses far worse than a flat color, which is the point — a
  // plain background would stay under 8MB regardless of quality.
  const width = 3000;
  const height = 5334;
  const noise = Buffer.alloc(width * height * 3);
  randomFillSync(noise);
  const input = await sharp(noise, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const r = await conformCover(input);
  assert.ok(r.buffer.length <= COVER_MAX_BYTES, `output must be <= 8MB, got ${r.buffer.length} bytes`);
  assert.equal(r.width, 3000, "width must remain unchanged even under size pressure");
  assert.equal(r.height, 5334, "height must remain unchanged even under size pressure");
  console.log("ok: large input is quality-stepped to <= 8MB without resizing");
}

// --- Output colour space is sRGB ---------------------------------------------------
{
  const input = await mk(1080, 1920);
  const r = await conformCover(input);
  const meta = await sharp(r.buffer).metadata();
  assert.equal(meta.space, "srgb", `output colour space must be sRGB, got ${meta.space}`);
  console.log("ok: output colour space is sRGB");
}

console.log("\nALL CONFORM-COVER CHECKS PASSED");
