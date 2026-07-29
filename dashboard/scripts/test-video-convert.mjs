import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findConverter, convertVideo, buildArgs, ConvertError } from "../lib/video-convert.ts";
import { readVideoMeta } from "../lib/video-meta.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "off" must disable conversion entirely, whatever is installed
assert.equal(findConverter("off"), null, "off disables conversion");

// The ffmpeg filter must fit video inside a 1920x1920 box (matching avconvert's
// Preset1920x1080 behaviour for both orientations), not scale off input width alone.
// Asserted on the constructed argument list directly so this runs even on machines without
// ffmpeg installed.
{
  const args = buildArgs("ffmpeg", "in.mov", "out.mov");
  const vfIndex = args.indexOf("-vf");
  assert.ok(vfIndex !== -1, "ffmpeg args must include -vf");
  const filter = args[vfIndex + 1];
  assert.ok(
    filter.includes("force_original_aspect_ratio=decrease"),
    `filter must scale down to fit, not distort/pad: ${filter}`
  );
  assert.ok(
    filter.includes("force_divisible_by=2"),
    `filter must keep dimensions h264-even: ${filter}`
  );
  const faststartIndex = args.indexOf("-movflags");
  assert.ok(faststartIndex !== -1 && args[faststartIndex + 1] === "+faststart",
    "moov must still be moved to the front for Instagram");

  // ffmpeg is verbose on stderr by default (banner, full stream metadata, a continuously
  // rewriting progress line) — enough that a long Reel could plausibly exceed execFile's
  // default 1 MB maxBuffer and fail a conversion that actually succeeded. Quiet it down.
  assert.ok(args.includes("-nostdin"), "must not let ffmpeg try to read stdin");
  const loglevelIndex = args.indexOf("-loglevel");
  assert.ok(loglevelIndex !== -1 && args[loglevelIndex + 1] === "error",
    "must suppress ffmpeg's banner/metadata chatter, keeping only real errors");
  assert.ok(args.includes("-nostats"), "must suppress the rewriting progress line");
}

// On macOS avconvert is always present
if (process.platform === "darwin") {
  assert.equal(findConverter(), "avconvert", "macOS must find avconvert");
}

// A garbage input must reject with the typed error, not hang or resolve
const conv = findConverter();
if (conv) {
  const bad = path.join(os.tmpdir(), `bad-${process.pid}.mov`);
  const out = path.join(os.tmpdir(), `out-${process.pid}.mov`);
  fs.writeFileSync(bad, Buffer.from("definitely not a video"));
  await assert.rejects(
    () => convertVideo(bad, out, { converter: conv, timeoutMs: 60_000 }),
    ConvertError,
    "garbage input must reject with ConvertError"
  );
  assert.ok(!fs.existsSync(out), "no partial output may be left behind");
  fs.rmSync(bad, { force: true });

  // Real conversion, if the 4K fixture is present on this machine
  const REAL = path.join(os.homedir(), "Downloads", "IMG_3707.MOV");
  if (fs.existsSync(REAL)) {
    const dst = path.join(os.tmpdir(), `conv-${process.pid}.mov`);
    await convertVideo(REAL, dst, { converter: conv, timeoutMs: 300_000 });
    const m = readVideoMeta(fs.readFileSync(dst));
    assert.ok(m.width <= 1920, `converted width must be <=1920, got ${m.width}`);
    assert.equal(m.width, 1080, "2160x3840 must become 1080x1920");
    assert.equal(m.height, 1920);
    // Meta's spec wants moov at the front; conversion should deliver that.
    const b = fs.readFileSync(dst);
    assert.ok(b.indexOf(Buffer.from("moov")) < b.indexOf(Buffer.from("mdat")), "moov must be first");
    fs.rmSync(dst, { force: true });

    // Timeout path: the kill-and-cleanup logic was verified manually during review, but
    // nothing in this suite forced a real timeout — the garbage-input case above fails too
    // fast to ever reach it. Force one deterministically with an absurdly small timeoutMs
    // against the real (multi-second-to-convert) fixture, and confirm not just that it
    // rejects, but that the killed child is actually gone — a SIGTERM the process ignored,
    // or a grandchild it spawned, would otherwise keep transcoding in the background after
    // we've already told the caller it failed.
    const timeoutDst = path.join(os.tmpdir(), `conv-timeout-${process.pid}.mov`);
    await assert.rejects(
      () => convertVideo(REAL, timeoutDst, { converter: conv, timeoutMs: 50 }),
      ConvertError,
      "an absurdly short timeoutMs must reject with ConvertError"
    );
    assert.ok(!fs.existsSync(timeoutDst), "no partial output may survive a timeout");

    let stillRunning = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        stillRunning = execFileSync("pgrep", ["-f", timeoutDst], { encoding: "utf8" }).trim();
      } catch {
        stillRunning = ""; // pgrep exits non-zero when nothing matches — the expected outcome
      }
      if (!stillRunning) break;
      await sleep(100);
    }
    assert.equal(
      stillRunning,
      "",
      `${conv} must not still be running after a timeout (pgrep found: ${stillRunning})`
    );
    console.log("  timeout path verified — ConvertError, no partial file, no lingering process");
  } else {
    console.log("  (skipped real-file conversion — IMG_3707.MOV not present)");
    console.log(
      "\n  *** SKIPPED: timeout/kill/cleanup test not run (IMG_3707.MOV fixture not present). ***\n" +
      "  *** This machine did not verify the timeout path forces a real kill+cleanup. ***\n"
    );
  }
}

// ffmpeg path specifically, forced regardless of what findConverter() auto-selects (avconvert
// wins the auto-probe on macOS, so the block above never exercises ffmpeg there). Must
// reproduce avconvert's 1080x1920 shape for the same portrait 4K input — this is the actual
// regression being fixed.
{
  const hasFfmpeg = findConverter("ffmpeg") === "ffmpeg";
  const REAL = path.join(os.homedir(), "Downloads", "IMG_3707.MOV");
  if (hasFfmpeg && fs.existsSync(REAL)) {
    const dst = path.join(os.tmpdir(), `conv-ffmpeg-${process.pid}.mov`);
    await convertVideo(REAL, dst, { converter: "ffmpeg", timeoutMs: 300_000 });
    const m = readVideoMeta(fs.readFileSync(dst));
    assert.equal(m.width, 1080, `ffmpeg must match avconvert's shape: got width ${m.width}`);
    assert.equal(m.height, 1920, `ffmpeg must match avconvert's shape: got height ${m.height}`);
    fs.rmSync(dst, { force: true });
    console.log("  ffmpeg real-file conversion verified — 1080x1920, matches avconvert");
  } else {
    console.log(
      `\n  *** SKIPPED: ffmpeg real-file conversion check not run (ffmpeg available: ${hasFfmpeg}, fixture present: ${fs.existsSync(REAL)}). ***\n` +
      "  *** This machine did not verify that the ffmpeg path produces 1080x1920. ***\n"
    );
  }
}

console.log("OK — converter probe and conversion behave");
