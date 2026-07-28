import assert from "node:assert/strict";
import { validateReel, REEL_SPEC } from "../lib/video-spec.ts";

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

// File size — 300MB, inclusive
assert.deepEqual(validateReel(ok, 300 * MB, "video/mp4").errors, [], "300MB ok");
assert.equal(validateReel(ok, 300 * MB + 1, "video/mp4").errors.length, 1, "over 300MB refused");
assert.match(validateReel(ok, 512 * MB, "video/mp4").errors[0], /512(\.0)?\s?MB/, "names the real size");

// MIME
assert.equal(validateReel(ok, MB, "video/x-matroska").errors.length, 1, "mkv refused");

// Horizontal pixel cap
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
