import assert from "node:assert/strict";
import { validateReel, REEL_SPEC, humanDuration, humanBytes } from "../lib/video-spec.ts";

const ok = { duration_ms: 30_000, width: 1080, height: 1920, has_audio: true };
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
