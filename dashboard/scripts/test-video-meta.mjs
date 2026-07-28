import assert from "node:assert/strict";
import { readVideoMeta, VideoParseError } from "../lib/video-meta.ts";

/** Build one MP4 box: [size][type][payload]. */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
}

/** mvhd v0: version+flags(4), created(4), modified(4), timescale(4), duration(4), rest. */
function mvhd(timescale, duration) {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(0, 0);            // version 0 + flags
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box("mvhd", p);
}

/** tkhd v0: width at payload offset 76, height at 80, both 16.16 fixed-point. */
function tkhd(width, height) {
  const p = Buffer.alloc(84);
  p.writeUInt32BE(0, 0);
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

function file({ timescale = 600, duration = 6000, w = 1080, h = 1920, audio = true, moovFirst = true } = {}) {
  const ftyp = box("ftyp", Buffer.from("isomiso2avc1mp41", "ascii"));
  const tracks = [box("trak", Buffer.concat([tkhd(w, h), hdlr("vide")]))];
  if (audio) tracks.push(box("trak", Buffer.concat([tkhd(0, 0), hdlr("soun")])));
  const moov = box("moov", Buffer.concat([mvhd(timescale, duration), ...tracks]));
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

// Landscape
const land = readVideoMeta(file({ w: 1920, h: 1080 }));
assert.equal(land.width, 1920);
assert.equal(land.height, 1080);

// Garbage must throw a typed error, never return junk
assert.throws(() => readVideoMeta(Buffer.from("this is not a video at all")), VideoParseError);

// Truncated: a valid header claiming more bytes than exist
const trunc = file().subarray(0, 40);
assert.throws(() => readVideoMeta(trunc), VideoParseError);

console.log("OK — video-meta parses duration, dimensions, audio; handles moov-last and rejects garbage");
