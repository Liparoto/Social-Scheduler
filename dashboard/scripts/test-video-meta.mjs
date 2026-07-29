import assert from "node:assert/strict";
import { readVideoMeta, VideoParseError } from "../lib/video-meta.ts";

/** Build one MP4 box: [size][type][payload]. */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
}

/**
 * mvhd v0: version+flags(4), created(4), modified(4), timescale(4), duration(4), rest.
 *
 * mvhd v1 (independently derived from the ISO/IEC 14496-12 box layout, NOT copied from
 * video-meta.ts's offsets): version 1 widens created/modified/duration from 32-bit to
 * 64-bit. created 4->8 (+4), modified 4->8 (+4), duration 4->8 (+4) = every field after
 * "modified" shifts by +12 bytes relative to v0:
 *   v0: created(4)@4, modified(4)@8, timescale(4)@12, duration(4)@16
 *   v1: created(8)@4, modified(8)@12, timescale(4)@20, duration(8)@24
 * Total payload grows from 100 to 112 bytes (the +12 shift applies to everything after
 * timescale too, but nothing past duration is populated/read here).
 */
function mvhd(timescale, duration, { version = 0 } = {}) {
  if (version === 1) {
    const p = Buffer.alloc(112);
    p.writeUInt8(1, 0);               // version 1, flags 0
    p.writeUInt32BE(timescale, 20);
    p.writeBigUInt64BE(BigInt(duration), 24);
    return box("mvhd", p);
  }
  const p = Buffer.alloc(100);
  p.writeUInt32BE(0, 0);            // version 0 + flags
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box("mvhd", p);
}

/**
 * tkhd v0: width at payload offset 76, height at 80, both 16.16 fixed-point.
 * The 3x3 display matrix {a,b,u,c,d,v,x,y,w} occupies offsets 40-76. By default this
 * writes a proper identity matrix (a=1, d=1, w=1 in 2.30 fixed-point) — real files always
 * have a valid matrix, so fixtures should too. Pass rotate90 or rotate270 to instead write
 * the matrix iPhones use for portrait-recorded, landscape-sampled video.
 *
 * tkhd v1 (independently derived from ISO/IEC 14496-12, NOT copied from video-meta.ts's
 * offsets): same +12-byte widening as mvhd (created/modified/duration each 4->8 bytes,
 * total +12), applied to the v0 field list:
 *   v0: created(4)@4, modified(4)@8, track_ID(4)@12, reserved(4)@16, duration(4)@20,
 *       reserved(8)@24, layer(2)@32, alt_group(2)@34, volume(2)@36, reserved(2)@38,
 *       matrix(36)@40 [a@40 b@44 u@48 c@52 d@56 v@60 x@64 y@68 w@72], width(4)@76,
 *       height(4)@80  -> payload ends at 84
 *   v1: created(8)@4, modified(8)@12, track_ID(4)@20, reserved(4)@24, duration(8)@28,
 *       reserved(8)@36, layer(2)@44, alt_group(2)@46, volume(2)@48, reserved(2)@50,
 *       matrix(36)@52 [a@52 b@56 u@60 c@64 d@68 v@72 x@76 y@80 w@84], width(4)@88,
 *       height(4)@92  -> payload ends at 96
 * So matrix moves from +40 to +52 (a +12 shift) and width/height move from +76/+80 to
 * +88/+92 (also +12, since matrix is a fixed 36-byte block that itself doesn't change size).
 */
function tkhd(width, height, { rotate90 = false, rotate270 = false, version = 0 } = {}) {
  const FIX = 65536; // 16.16 fixed-point unit
  let a = FIX, b = 0, c = 0, d = FIX;
  if (rotate90) {
    a = 0; b = 1 * FIX; c = -1 * FIX; d = 0;
  } else if (rotate270) {
    a = 0; b = -1 * FIX; c = 1 * FIX; d = 0;
  }

  if (version === 1) {
    const p = Buffer.alloc(96);
    p.writeUInt8(1, 0); // version 1, flags 0
    const matrixOffset = 52;
    p.writeInt32BE(a, matrixOffset);
    p.writeInt32BE(b, matrixOffset + 4);
    p.writeInt32BE(c, matrixOffset + 12);
    p.writeInt32BE(d, matrixOffset + 16);
    p.writeInt32BE(1 << 30, matrixOffset + 32); // w, 2.30 fixed-point unit
    p.writeUInt32BE(width * 65536, 88);
    p.writeUInt32BE(height * 65536, 92);
    return box("tkhd", p);
  }

  const p = Buffer.alloc(84);
  p.writeUInt32BE(0, 0);
  p.writeInt32BE(a, 40);
  p.writeInt32BE(b, 44);
  p.writeInt32BE(c, 52);
  p.writeInt32BE(d, 56);
  p.writeInt32BE(1 << 30, 72); // w, 2.30 fixed-point unit
  p.writeUInt32BE(width * 65536, 76);
  p.writeUInt32BE(height * 65536, 80);
  return box("tkhd", p);
}

/** hdlr: version+flags(4), pre_defined(4), handler_type(4). */
function hdlr(kind) {
  const p = Buffer.alloc(24);
  p.write(kind, 8, "ascii");
  return box("hdlr", p);
}

/**
 * stsd (sample description): version+flags(4), entry_count(4), then one sample-entry
 * box per entry — [size][fourcc][payload] — whose fourcc names the codec (e.g. 'avc1'
 * for H.264, 'hvc1' for HEVC). Only one entry is ever built here; the payload contents
 * are never read by readVideoMeta, so it's left as zeroed filler.
 */
function stsd(codecFourCC) {
  const entry = box(codecFourCC, Buffer.alloc(78));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(0, 0); // version + flags
  head.writeUInt32BE(1, 4); // entry_count = 1
  return box("stsd", Buffer.concat([head, entry]));
}

function file({
  timescale = 600,
  duration = 6000,
  w = 1080,
  h = 1920,
  audio = true,
  moovFirst = true,
  rotate90 = false,
  rotate270 = false,
  mvhdVersion = 0,
  tkhdVersion = 0,
  // Codec fourcc for the video track's stsd entry, or null to omit stsd entirely
  // (the pre-existing fixture shape, which every duration/dimension test below still
  // relies on). 'avc1' = H.264, 'hvc1' = HEVC.
  videoCodec = null,
} = {}) {
  const ftyp = box("ftyp", Buffer.from("isomiso2avc1mp41", "ascii"));
  const videoTrakParts = [tkhd(w, h, { rotate90, rotate270, version: tkhdVersion }), hdlr("vide")];
  if (videoCodec) videoTrakParts.push(stsd(videoCodec));
  const tracks = [box("trak", Buffer.concat(videoTrakParts))];
  if (audio) tracks.push(box("trak", Buffer.concat([tkhd(0, 0), hdlr("soun")])));
  const moov = box("moov", Buffer.concat([mvhd(timescale, duration, { version: mvhdVersion }), ...tracks]));
  const mdat = box("mdat", Buffer.alloc(64));
  return moovFirst
    ? Buffer.concat([ftyp, moov, mdat])
    : Buffer.concat([ftyp, mdat, moov]);   // iPhone-style: moov at the END
}

// 6000 units / 600 per second = 10 seconds
const m = readVideoMeta(file());
assert.equal(m.duration_ms, 10_000, "duration");
assert.equal(m.width, 1080);
assert.equal(m.height, 1920);
assert.equal(m.has_audio, true);
assert.equal(m.moov_before_mdat, true, "moov-first fixture reports moov_before_mdat true");
assert.equal(m.is_hevc, false, "no stsd at all must not be misread as HEVC");

// No audio track
assert.equal(readVideoMeta(file({ audio: false })).has_audio, false, "silent video");

// A different timescale must still resolve to the same wall-clock duration
assert.equal(readVideoMeta(file({ timescale: 90_000, duration: 90_000 * 7 })).duration_ms, 7000);

// moov at the END of the file must still parse. This is the iPhone case, and the whole
// reason the parser walks boxes rather than assuming a layout.
const moovLast = readVideoMeta(file({ moovFirst: false }));
assert.equal(moovLast.duration_ms, 10_000, "moov-last");
// It must ALSO be correctly flagged as such — this is the fact video-spec.ts needs to
// classify a trailing-moov file as convertible instead of silently passing it through.
assert.equal(moovLast.moov_before_mdat, false, "moov-last must report moov_before_mdat false");

// Identity-matrix portrait video must still report portrait (pins that the matrix fix
// doesn't disturb the already-passing, non-rotated case).
const portraitIdentity = readVideoMeta(file({ w: 1080, h: 1920 }));
assert.equal(portraitIdentity.width, 1080, "identity portrait width");
assert.equal(portraitIdentity.height, 1920, "identity portrait height");

// iPhone-style 90-degree rotation: stored landscape (1280x720), displayed portrait (720x1280).
const rot90 = readVideoMeta(file({ w: 1280, h: 720, rotate90: true }));
assert.equal(rot90.width, 720, "90deg-rotated width");
assert.equal(rot90.height, 1280, "90deg-rotated height");

// 270-degree rotation: same transpose as 90 degrees.
const rot270 = readVideoMeta(file({ w: 1280, h: 720, rotate270: true }));
assert.equal(rot270.width, 720, "270deg-rotated width");
assert.equal(rot270.height, 1280, "270deg-rotated height");

// Genuinely landscape identity-matrix video must NOT be transposed.
const landIdentity = readVideoMeta(file({ w: 1920, h: 1080 }));
assert.equal(landIdentity.width, 1920, "identity landscape width");
assert.equal(landIdentity.height, 1080, "identity landscape height");

// --- Version 1 mvhd/tkhd (64-bit time fields, everything after shifted by 12 bytes) ---

// A version-1 mvhd must yield the same duration as the equivalent version-0 one.
const v1Mvhd = readVideoMeta(file({ mvhdVersion: 1 }));
assert.equal(v1Mvhd.duration_ms, 10_000, "v1 mvhd duration");

// A duration that doesn't fit in 32 bits forces the reader to actually use the 64-bit
// field rather than coincidentally getting the right answer from a truncated read.
const v1MvhdBig = readVideoMeta(
  file({ mvhdVersion: 1, timescale: 1000, duration: 5_000_000_000 })
);
assert.equal(v1MvhdBig.duration_ms, 5_000_000_000, "v1 mvhd 64-bit-only duration");

// A version-1 tkhd must yield the correct width/height (identity matrix, no rotation).
const v1Tkhd = readVideoMeta(file({ w: 1280, h: 720, tkhdVersion: 1, audio: false }));
assert.equal(v1Tkhd.width, 1280, "v1 tkhd width");
assert.equal(v1Tkhd.height, 720, "v1 tkhd height");

// A version-1 tkhd carrying a 90-degree rotation matrix must still transpose correctly.
const v1Rot90 = readVideoMeta(file({ w: 1280, h: 720, tkhdVersion: 1, rotate90: true }));
assert.equal(v1Rot90.width, 720, "v1 90deg-rotated width");
assert.equal(v1Rot90.height, 1280, "v1 90deg-rotated height");

// A version-1 tkhd carrying a 270-degree rotation matrix must also transpose correctly.
const v1Rot270 = readVideoMeta(file({ w: 1280, h: 720, tkhdVersion: 1, rotate270: true }));
assert.equal(v1Rot270.width, 720, "v1 270deg-rotated width");
assert.equal(v1Rot270.height, 1280, "v1 270deg-rotated height");

// Mixed versions: mvhd and tkhd carry independent version bytes, and a real file may mix
// them (e.g. a long-running capture with a 64-bit mvhd duration next to an ordinary tkhd).
const mixedV1MvhdV0Tkhd = readVideoMeta(
  file({ mvhdVersion: 1, tkhdVersion: 0, timescale: 90_000, duration: 90_000 * 7, w: 1080, h: 1920 })
);
assert.equal(mixedV1MvhdV0Tkhd.duration_ms, 7000, "mixed v1 mvhd + v0 tkhd: duration");
assert.equal(mixedV1MvhdV0Tkhd.width, 1080, "mixed v1 mvhd + v0 tkhd: width");
assert.equal(mixedV1MvhdV0Tkhd.height, 1920, "mixed v1 mvhd + v0 tkhd: height");

const mixedV0MvhdV1Tkhd = readVideoMeta(
  file({ mvhdVersion: 0, tkhdVersion: 1, w: 1280, h: 720, rotate90: true })
);
assert.equal(mixedV0MvhdV1Tkhd.duration_ms, 10_000, "mixed v0 mvhd + v1 tkhd: duration");
assert.equal(mixedV0MvhdV1Tkhd.width, 720, "mixed v0 mvhd + v1 tkhd: width");
assert.equal(mixedV0MvhdV1Tkhd.height, 1280, "mixed v0 mvhd + v1 tkhd: height");

// --- Codec detection: HEVC (hvc1/hev1) vs H.264 (avc1), whole-branch review Important 3 ---

// H.264 (avc1) must NOT be flagged as HEVC.
assert.equal(readVideoMeta(file({ videoCodec: "avc1" })).is_hevc, false, "avc1 is not HEVC");

// hvc1 is one of the two HEVC sample-entry fourccs actually used in the wild (Apple's).
assert.equal(readVideoMeta(file({ videoCodec: "hvc1" })).is_hevc, true, "hvc1 must be detected as HEVC");

// hev1 is the other standard HEVC fourcc (used when parameter sets are inline rather
// than out-of-band) — both must be recognized, not just the one Apple happens to emit.
assert.equal(readVideoMeta(file({ videoCodec: "hev1" })).is_hevc, true, "hev1 must be detected as HEVC");

// The audio track's own (nonexistent, in this fixture) stsd must never be confused with
// the video track's — codec detection must be scoped to the video (handler type 'vide')
// track specifically, not "any stsd anywhere in the file".
const hevcWithAudio = readVideoMeta(file({ videoCodec: "hvc1", audio: true }));
assert.equal(hevcWithAudio.is_hevc, true, "HEVC video track detected even alongside an audio track");
assert.equal(hevcWithAudio.has_audio, true, "audio track detection is unaffected by codec detection");

// --- Real-file verification (whole-branch review, Important 3) ---------------------
// Both real files this fix was written against. Read-only — never modify either.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const iphoneOriginal = path.join(os.homedir(), "Downloads", "IMG_3707.MOV");
  if (fs.existsSync(iphoneOriginal)) {
    const meta = readVideoMeta(fs.readFileSync(iphoneOriginal));
    assert.equal(meta.width, 2160, "IMG_3707.MOV: known stored width 2160");
    assert.equal(meta.height, 3840, "IMG_3707.MOV: known stored height 3840");
    assert.equal(meta.moov_before_mdat, false, "IMG_3707.MOV: moov is known to be LAST");
    assert.equal(meta.is_hevc, true, "IMG_3707.MOV: known to be HEVC (hvc1)");
    console.log("OK — IMG_3707.MOV (real 4K HEVC, moov-last) parses and flags both conditions");
  } else {
    console.log("SKIPPED — ~/Downloads/IMG_3707.MOV not present on this machine");
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const convertedReel = path.join(
    scriptDir, "..", "..", "data", "assets", "pub",
    "da5ef00137664d28da89e0489bce2f594b922a73df7dd473cbd0f213f6875313.mp4"
  );
  if (fs.existsSync(convertedReel)) {
    const meta = readVideoMeta(fs.readFileSync(convertedReel));
    assert.equal(meta.width, 1080, "converted reel: known width 1080");
    assert.equal(meta.height, 1920, "converted reel: known height 1920");
    assert.equal(meta.moov_before_mdat, true, "converted reel: moov is known to be FIRST");
    assert.equal(meta.is_hevc, false, "converted reel: known to be H.264 (avc1), not HEVC");
    console.log("OK — the converted 1080x1920 H.264 reel parses clean on both conditions");
  } else {
    console.log("SKIPPED — converted reel fixture not present at data/assets/pub/…f6875313.mp4");
  }
}

// Garbage must throw a typed error, never return junk
assert.throws(() => readVideoMeta(Buffer.from("this is not a video at all")), VideoParseError);

// Truncated: a valid header claiming more bytes than exist
const trunc = file().subarray(0, 40);
assert.throws(() => readVideoMeta(trunc), VideoParseError);

console.log(
  "OK — video-meta parses duration, dimensions, audio, moov position and HEVC codec; " +
    "handles moov-last and rejects garbage"
);
