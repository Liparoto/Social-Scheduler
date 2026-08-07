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

// The .exe branch is the single riskiest line on a feature shipping blind to Windows —
// nobody here can run this on an actual Windows box. `platform` is threaded through as a
// parameter (mirroring converterAdvice(platform)) specifically so these three can run on
// any dev machine instead of never running at all.
test("on win32, a vendored ffmpeg.exe is found even though this machine isn't Windows", () => {
  const dir = tmpVendorDir();
  const exePath = path.join(dir, "ffmpeg.exe");
  fs.writeFileSync(exePath, "not a real binary");

  assert.equal(vendoredFfmpegPath(dir, "win32"), exePath);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("on win32, ffmpeg.exe is preferred over a bare ffmpeg in the same directory", () => {
  const dir = tmpVendorDir();
  const exePath = path.join(dir, "ffmpeg.exe");
  fs.writeFileSync(path.join(dir, "ffmpeg"), "bare, no extension");
  fs.writeFileSync(exePath, "the real Windows one");

  assert.equal(vendoredFfmpegPath(dir, "win32"), exePath);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a bare ffmpeg is not mistaken for the Windows binary on a non-Windows platform", () => {
  // The opposite mistake: a file named exactly "ffmpeg.exe" sitting in the vendor dir
  // (e.g. copied over from a Windows install by accident) must not be picked up when
  // resolving for darwin/linux, which only ever look for the bare name.
  const dir = tmpVendorDir();
  fs.writeFileSync(path.join(dir, "ffmpeg.exe"), "a Windows binary");

  assert.equal(vendoredFfmpegPath(dir, "darwin"), null);
  assert.equal(vendoredFfmpegPath(dir, "linux"), null);

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
