import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffMediaMime, resolveUploadMime } from "./upload-mime.ts";

// Regression: a Windows install got 415 on .webp files from a Google Photos Takeout.
// image/webp has been in the allow-list since the first dashboard commit, so the type was
// never the problem — the ROUTE trusted `file.type`, which the browser fills in from the
// OS. On Windows that comes out of the registry, and a machine with nothing registered for
// .webp reports "" for every one of them. An empty declared type then matched neither the
// image nor the video table and fell straight through to 415.
//
// The bytes are the thing that is actually authoritative, so they decide.

function bytes(...parts: (number[] | string)[]): Buffer {
  return Buffer.concat(
    parts.map((p) => (typeof p === "string" ? Buffer.from(p, "ascii") : Buffer.from(p))),
  );
}

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], new Array(24).fill(0));
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], new Array(24).fill(0));
const WEBP = bytes("RIFF", [0x24, 0x00, 0x00, 0x00], "WEBPVP8 ", new Array(16).fill(0));
const MP4 = bytes([0, 0, 0, 0x20], "ftypisom", new Array(20).fill(0));

test("sniffs webp from its RIFF/WEBP header", () => {
  assert.equal(sniffMediaMime(WEBP), "image/webp");
});

test("sniffs the other accepted types too", () => {
  assert.equal(sniffMediaMime(JPEG), "image/jpeg");
  assert.equal(sniffMediaMime(PNG), "image/png");
  assert.equal(sniffMediaMime(MP4), "video/mp4");
});

test("a RIFF container that is not WebP is not claimed as an image", () => {
  // RIFF is also WAV/AVI. Matching on "RIFF" alone would accept those and fail later in
  // sharp with something far less legible than a 415.
  assert.equal(sniffMediaMime(bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt ")), null);
});

test("unknown bytes stay unknown", () => {
  assert.equal(sniffMediaMime(bytes("not media at all........")), null);
});

// --- resolveUploadMime: what the route actually asks ---

test("an EMPTY declared type falls back to the bytes — the Windows .webp case", () => {
  assert.equal(resolveUploadMime("", WEBP), "image/webp");
});

test("a declared type the browser guessed WRONG loses to the bytes", () => {
  // Windows can also report application/octet-stream for an unregistered extension.
  assert.equal(resolveUploadMime("application/octet-stream", WEBP), "image/webp");
});

test("a correct declared type is kept", () => {
  assert.equal(resolveUploadMime("image/webp", WEBP), "image/webp");
  assert.equal(resolveUploadMime("video/quicktime", MP4), "video/quicktime");
});

test("genuinely unsupported content is still rejected", () => {
  assert.equal(resolveUploadMime("application/pdf", bytes("%PDF-1.7 not an image")), null);
  assert.equal(resolveUploadMime("", bytes("%PDF-1.7 not an image")), null);
});
