import assert from "node:assert/strict";
import { validateReel, classifyReelErrors, REEL_SPEC, humanDuration, humanBytes } from "../lib/video-spec.ts";

const ok = {
  duration_ms: 30_000,
  width: 1080,
  height: 1920,
  has_audio: true,
  moov_before_mdat: true,
  is_hevc: false,
};
const MB = 1024 * 1024;

// The happy path: a normal vertical iPhone clip
let r = validateReel(ok, 40 * MB, "video/quicktime");
assert.deepEqual(r.errors, [], "a normal vertical clip must pass");
assert.deepEqual(r.warnings, [], "and warn about nothing");

// Duration boundaries — 3s min, 15min max, both INCLUSIVE
assert.deepEqual(validateReel({ ...ok, duration_ms: 3_000 }, MB, "video/mp4").errors, [], "3.0s ok");
assert.equal(validateReel({ ...ok, duration_ms: 2_999 }, MB, "video/mp4").errors.length, 1, "2.999s too short");
assert.deepEqual(validateReel({ ...ok, duration_ms: 900_000 }, MB, "video/mp4").errors, [], "15m ok");
assert.equal(validateReel({ ...ok, duration_ms: 900_001 }, MB, "video/mp4").errors.length, 1, "15m+1ms too long");

// The error text must state the ACTUAL value, not just the rule
const long = validateReel({ ...ok, duration_ms: 964_000 }, MB, "video/mp4");
assert.match(long.errors[0], /16m04s/, `error should name the real duration, got: ${long.errors[0]}`);
assert.match(long.errors[0], /15 minutes/, "error should name the limit");

// Finding 2 — a rejected too-short video must never be reported AT the minimum it failed.
// 2999ms rounded to-nearest would read "3.0s", contradicting "must be at least 3 seconds".
const tooShort = validateReel({ ...ok, duration_ms: 2_999 }, MB, "video/mp4");
assert.equal(tooShort.errors.length, 1, "2.999s still just one error");
assert.doesNotMatch(
  tooShort.errors[0],
  /\b3\.0s\b/,
  `a rejected too-short video must not display AT the minimum, got: ${tooShort.errors[0]}`
);
assert.match(tooShort.errors[0], /2\.9s/, "2999ms should floor to 2.9s, not round to 3.0s");

// Finding 3 — sub-minute durations must never display as a whole minute due to rounding.
// Unreachable via validateReel today (59-60s is deep inside the valid range), so exercise
// the formatter directly since it is likely to be reused for display elsewhere later.
assert.doesNotMatch(
  humanDuration(59_500),
  /1m00s/,
  "59500ms must not format as a whole minute"
);
assert.doesNotMatch(
  humanDuration(59_999),
  /1m00s/,
  "59999ms must not format as a whole minute"
);

// File size — 300MB, inclusive
assert.deepEqual(validateReel(ok, 300 * MB, "video/mp4").errors, [], "300MB ok");
assert.equal(validateReel(ok, 300 * MB + 1, "video/mp4").errors.length, 1, "over 300MB refused");
assert.match(validateReel(ok, 512 * MB, "video/mp4").errors[0], /512(\.0)?\s?MB/, "names the real size");

// Finding 1 — a rejected too-big file must never be reported AT the cap it failed.
// 300MB+1 byte rounded to-nearest would read "300.0 MB", contradicting "caps Reels at 300 MB".
const overCap = validateReel(ok, 300 * MB + 1, "video/mp4");
assert.doesNotMatch(
  overCap.errors[0],
  /300\.0 MB/,
  `a rejected too-big file must not display AT the cap, got: ${overCap.errors[0]}`
);
assert.match(humanBytes(300 * MB + 1), /300\.1 MB/, "1 byte over the cap should ceil to 300.1 MB");

// MIME
assert.equal(validateReel(ok, MB, "video/x-matroska").errors.length, 1, "mkv refused");

// Horizontal pixel cap — 1920, inclusive
assert.deepEqual(
  validateReel({ ...ok, width: 1920, height: 2500 }, MB, "video/mp4").errors,
  [],
  "exactly 1920 wide must pass"
);
assert.equal(validateReel({ ...ok, width: 3840, height: 2160 }, MB, "video/mp4").errors.length, 1, "4K width refused");

// Aspect ratio WARNS, never refuses (Decision 4) — Instagram accepts and letterboxes it
const landscape = validateReel({ ...ok, width: 1920, height: 1080 }, MB, "video/mp4");
assert.deepEqual(landscape.errors, [], "landscape must NOT be refused");
assert.equal(landscape.warnings.length, 1, "landscape must warn");
assert.match(landscape.warnings[0], /letterbox/i);

// Silent video warns too
const silent = validateReel({ ...ok, has_audio: false }, MB, "video/mp4");
assert.deepEqual(silent.errors, []);
assert.match(silent.warnings.join(" "), /no audio/i);

// Multiple problems are ALL reported, not just the first
const bad = validateReel({ ...ok, duration_ms: 1_000, width: 3840 }, 400 * MB, "video/mp4");
assert.equal(bad.errors.length, 3, `expected 3 errors, got ${bad.errors.length}: ${bad.errors}`);

assert.equal(REEL_SPEC.maxBytes, 300 * MB);
assert.equal(REEL_SPEC.maxDurationMs, 900_000);

console.log("OK — reel spec validator enforces verified limits, warns on ratio/audio");

// --- classifyReelErrors: splits fatal from convertible ---

const okC = {
  duration_ms: 30_000,
  width: 1080,
  height: 1920,
  has_audio: true,
  moov_before_mdat: true,
  is_hevc: false,
};
const MB2 = 1024 * 1024;

// 4K iPhone portrait — the case that motivated this work. Convertible, not fatal.
let c = classifyReelErrors({ ...okC, width: 2160, height: 3840 }, 50 * MB2, "video/quicktime");
assert.deepEqual(c.fatal, [], "4K must NOT be fatal — downscaling fixes it");
assert.equal(c.convertible.length, 1, "4K width must be convertible");
assert.match(c.convertible[0], /2160/, "must name the measured width");

// Oversize is convertible
c = classifyReelErrors(okC, 400 * MB2, "video/mp4");
assert.deepEqual(c.fatal, []);
assert.equal(c.convertible.length, 1);

// Wrong container is convertible
c = classifyReelErrors(okC, MB2, "video/x-matroska");
assert.deepEqual(c.fatal, []);
assert.equal(c.convertible.length, 1);

// Duration is FATAL — conversion cannot honestly fix it
c = classifyReelErrors({ ...okC, duration_ms: 964_000 }, MB2, "video/mp4");
assert.equal(c.fatal.length, 1, "too long must be fatal");
assert.deepEqual(c.convertible, [], "and must not offer conversion");
assert.match(c.fatal[0], /16m04s/, "must name the real duration");

c = classifyReelErrors({ ...okC, duration_ms: 2_000 }, MB2, "video/mp4");
assert.equal(c.fatal.length, 1, "too short must be fatal");

// A 16-minute 4K video has BOTH a fatal problem and convertible ones. The classifier
// reports both honestly; the upload route is what guarantees the fatal check runs first
// so no time is wasted transcoding a video that will be refused for length anyway.
c = classifyReelErrors({ ...okC, duration_ms: 964_000, width: 2160 }, 400 * MB2, "video/mp4");
assert.equal(c.fatal.length, 1, "duration is fatal");
assert.ok(c.convertible.length >= 1, "and the width/size problems are still reported");

// Warnings are unchanged and never block
c = classifyReelErrors({ ...okC, width: 1920, height: 1080, has_audio: false }, MB2, "video/mp4");
assert.deepEqual(c.fatal, []);
assert.deepEqual(c.convertible, []);
assert.equal(c.warnings.length, 2, "landscape + silent both warn");

// A clean video classifies as entirely clean
c = classifyReelErrors(okC, 40 * MB2, "video/mp4");
assert.deepEqual([c.fatal, c.convertible, c.warnings], [[], [], []]);

// --- Whole-branch review, Important 3: trailing 'moov' and HEVC are convertible -----

// 'moov' after 'mdat' (the common iPhone-camera-original layout) is convertible, not
// fatal — conversion relocates it to the front.
c = classifyReelErrors({ ...okC, moov_before_mdat: false }, 40 * MB2, "video/quicktime");
assert.deepEqual(c.fatal, [], "trailing moov must NOT be fatal — conversion relocates it");
assert.equal(c.convertible.length, 1, "trailing moov must be convertible");
assert.match(c.convertible[0], /moov/i, "must name the actual problem (moov)");

// HEVC is convertible, not fatal — conversion transcodes to H.264.
c = classifyReelErrors({ ...okC, is_hevc: true }, 40 * MB2, "video/quicktime");
assert.deepEqual(c.fatal, [], "HEVC must NOT be fatal — conversion transcodes it");
assert.equal(c.convertible.length, 1, "HEVC must be convertible");
assert.match(c.convertible[0], /HEVC/, "must name the actual problem (HEVC)");

// The two new conditions are independent — a file can have either, both, or neither.
c = classifyReelErrors({ ...okC, moov_before_mdat: false, is_hevc: true }, 40 * MB2, "video/quicktime");
assert.deepEqual(c.fatal, []);
assert.equal(c.convertible.length, 2, "moov-trailing AND HEVC must both be reported");

console.log("OK — classifyReelErrors splits fatal from convertible");

// --- Real-file verification (whole-branch review, Important 3) ---------------------
// Both real files this fix was written against. Read-only — never modify either.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { readVideoMeta } = await import("../lib/video-meta.ts");

  const iphoneOriginal = path.join(os.homedir(), "Downloads", "IMG_3707.MOV");
  if (fs.existsSync(iphoneOriginal)) {
    const meta = readVideoMeta(fs.readFileSync(iphoneOriginal));
    assert.equal(meta.moov_before_mdat, false, "IMG_3707.MOV: moov is known to be LAST");
    assert.equal(meta.is_hevc, true, "IMG_3707.MOV: known to be HEVC");
    const real = classifyReelErrors(meta, fs.statSync(iphoneOriginal).size, "video/quicktime");
    assert.ok(
      real.convertible.length >= 3,
      `IMG_3707.MOV must classify convertible on several counts (width, moov, HEVC), got: ${real.convertible}`
    );
    console.log("OK — IMG_3707.MOV (real 4K HEVC, moov-last) classifies convertible on several counts");
  } else {
    console.log("SKIPPED — ~/Downloads/IMG_3707.MOV not present on this machine");
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const convertedReel = path.join(
    scriptDir,
    "..",
    "..",
    "data",
    "assets",
    "pub",
    "da5ef00137664d28da89e0489bce2f594b922a73df7dd473cbd0f213f6875313.mp4"
  );
  if (fs.existsSync(convertedReel)) {
    const meta = readVideoMeta(fs.readFileSync(convertedReel));
    assert.equal(meta.moov_before_mdat, true, "converted reel: moov is known to be FIRST");
    assert.equal(meta.is_hevc, false, "converted reel: known to be H.264, not HEVC");
    const real = classifyReelErrors(meta, fs.statSync(convertedReel).size, "video/mp4");
    assert.deepEqual(real.convertible, [], `converted reel must classify entirely clean, got: ${real.convertible}`);
    assert.deepEqual(real.fatal, []);
    console.log("OK — the converted 1080x1920 H.264 reel classifies entirely clean");
  } else {
    console.log("SKIPPED — converted reel fixture not present at data/assets/pub/…f6875313.mp4");
  }
}
