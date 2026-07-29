import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findConverter, convertVideo, ConvertError } from "../lib/video-convert.ts";
import { readVideoMeta } from "../lib/video-meta.ts";

// "off" must disable conversion entirely, whatever is installed
assert.equal(findConverter("off"), null, "off disables conversion");

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
  } else {
    console.log("  (skipped real-file conversion — IMG_3707.MOV not present)");
  }
}
console.log("OK — converter probe and conversion behave");
