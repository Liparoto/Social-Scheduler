import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findConverter, buildArgs, vendoredFfmpegPath } from "./video-convert.ts";

function tmpVendorDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ss-vendor-"));
}

test("off disables conversion whatever is installed", () => {
  assert.equal(findConverter("off"), null);
});

test("a vendored ffmpeg is found and returned as an absolute path", () => {
  const dir = tmpVendorDir();
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, "#!/bin/sh\n");
  fs.chmodSync(binPath, 0o755);

  const found = vendoredFfmpegPath(dir);
  assert.equal(found, binPath);
  assert.ok(path.isAbsolute(found), "must be absolute — background launchers have a minimal PATH");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("an empty vendor dir yields no vendored ffmpeg", () => {
  const dir = tmpVendorDir();
  assert.equal(vendoredFfmpegPath(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("forcing ffmpeg prefers the vendored copy over anything on PATH", () => {
  const dir = tmpVendorDir();
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, "#!/bin/sh\n");
  fs.chmodSync(binPath, 0o755);

  const c = findConverter("ffmpeg", dir);
  assert.equal(c?.kind, "ffmpeg");
  assert.equal(c?.bin, binPath);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("forcing a converter that does not exist returns null, not a bare name", () => {
  // The old behaviour returned the string "ffmpeg" unconditionally, so an install with no
  // ffmpeg got a spawn failure mid-upload instead of the actionable 422.
  const dir = tmpVendorDir();
  const saved = process.env.PATH;
  process.env.PATH = dir; // empty of binaries
  try {
    assert.equal(findConverter("ffmpeg", dir), null);
  } finally {
    process.env.PATH = saved;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildArgs still switches on kind and keeps the Instagram-critical flags", () => {
  const args = buildArgs("ffmpeg", "in.mov", "out.mp4");
  const mv = args.indexOf("-movflags");
  assert.ok(mv !== -1 && args[mv + 1] === "+faststart", "moov must move to the front");
  assert.deepEqual(buildArgs("avconvert", "in.mov", "out.mp4"),
    ["-s", "in.mov", "-p", "Preset1920x1080", "-o", "out.mp4", "--replace"]);
});

if (process.platform === "darwin") {
  test("macOS still auto-selects avconvert, at its absolute path", () => {
    const c = findConverter();
    assert.equal(c?.kind, "avconvert");
    assert.equal(c?.bin, "/usr/bin/avconvert");
  });
}
