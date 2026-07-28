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
} = {}) {
  const ftyp = box("ftyp", Buffer.from("isomiso2avc1mp41", "ascii"));
  const tracks = [
    box("trak", Buffer.concat([tkhd(w, h, { rotate90, rotate270, version: tkhdVersion }), hdlr("vide")])),
  ];
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

// No audio track
assert.equal(readVideoMeta(file({ audio: false })).has_audio, false, "silent video");

// A different timescale must still resolve to the same wall-clock duration
assert.equal(readVideoMeta(file({ timescale: 90_000, duration: 90_000 * 7 })).duration_ms, 7000);

// moov at the END of the file must still parse. This is the iPhone case, and the whole
// reason the parser walks boxes rather than assuming a layout.
assert.equal(readVideoMeta(file({ moovFirst: false })).duration_ms, 10_000, "moov-last");

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

// Garbage must throw a typed error, never return junk
assert.throws(() => readVideoMeta(Buffer.from("this is not a video at all")), VideoParseError);

// Truncated: a valid header claiming more bytes than exist
const trunc = file().subarray(0, 40);
assert.throws(() => readVideoMeta(trunc), VideoParseError);

console.log("OK — video-meta parses duration, dimensions, audio; handles moov-last and rejects garbage");
