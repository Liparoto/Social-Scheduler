/**
 * Build a video that reproduces the originally reported upload failure: HEVC-encoded,
 * with its `moov` atom at the END of the file. Both are iPhone camera defaults, and both
 * are what classifyReelErrors() flags as convertible.
 *
 * Usage: node scripts/make-hevc-fixture.mjs <ffmpeg-bin> <output.mov>
 */
import { execFileSync } from "node:child_process";

const [bin, out] = process.argv.slice(2);
if (!bin || !out) {
  console.error("usage: make-hevc-fixture.mjs <ffmpeg-bin> <output.mov>");
  process.exit(2);
}

execFileSync(bin, [
  "-y", "-nostdin", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=4",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
  "-c:v", "libx265", "-tag:v", "hvc1",
  "-c:a", "aac",
  // No +faststart on purpose: that leaves moov at the end, which is half the bug.
  out,
]);
console.log(`wrote ${out}`);
