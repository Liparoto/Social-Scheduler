/**
 * Read duration, dimensions and audio presence straight out of an MP4/MOV container.
 *
 * Why hand-rolled: the alternatives are ffprobe (a large system binary every clone owner
 * would have to install) or trusting a duration the browser reported (unverifiable input,
 * and a wrong value fails hours later in the worker instead of at upload). Both MP4 and
 * MOV are ISO base media files — a tree of [4-byte size][4-byte type][payload] boxes — so
 * reading three of them is far cheaper than either alternative.
 *
 * Deliberately pure: bytes in, facts out. No I/O, no database, no config.
 */

export class VideoParseError extends Error {}

export interface VideoMeta {
  duration_ms: number;
  width: number;
  height: number;
  has_audio: boolean;
  // False when the top-level 'moov' box sits AFTER the top-level 'mdat' box. Meta's
  // servers require 'moov' (the file's index) at the front so they can validate the
  // container without reading the whole file — roughly 1 in 4 real iPhone camera
  // originals write it last, and such a file passes every numeric spec check yet Meta
  // still refuses it. Re-encoding relocates 'moov' to the front, so this belongs in
  // video-spec.ts's `convertible` bucket, not `fatal`.
  moov_before_mdat: boolean;
  // True when a video track's sample description names an HEVC (H.265) codec (hvc1 or
  // hev1). iPhone "High Efficiency" mode at 1080p produces an in-spec HEVC file that
  // passes every numeric check, but Chrome (and this app's own <video> previews/cover
  // scrubber) cannot decode HEVC, so it renders blank with nothing to explain why.
  // Conversion transcodes to H.264, which fixes this — same `convertible` reasoning.
  is_hevc: boolean;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;   // payload end (exclusive)
}

/** Iterate the boxes directly inside [from, to). */
function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let pos = from;
  while (pos + 8 <= to) {
    const size = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    // size 0 means "to end of file"; size 1 means a 64-bit size follows the type.
    let header = 8;
    let total = size;
    if (size === 1) {
      if (pos + 16 > to) return;
      total = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      total = to - pos;
    }
    if (total < header || pos + total > to) return; // truncated or nonsense — stop
    yield { type, start: pos + header, end: pos + total };
    pos += total;
  }
}

/** Depth-first search for the first box of `type`. */
function find(buf: Buffer, from: number, to: number, type: string): Box | null {
  for (const b of boxes(buf, from, to)) {
    if (b.type === type) return b;
    // Only these are containers; recursing into media data would be wasteful and wrong.
    if (["moov", "trak", "mdia", "minf", "stbl", "udta"].includes(b.type)) {
      const hit = find(buf, b.start, b.end, type);
      if (hit) return hit;
    }
  }
  return null;
}

function findAll(buf: Buffer, from: number, to: number, type: string, out: Box[] = []): Box[] {
  for (const b of boxes(buf, from, to)) {
    if (b.type === type) out.push(b);
    if (["moov", "trak", "mdia", "minf", "stbl", "udta"].includes(b.type)) {
      findAll(buf, b.start, b.end, type, out);
    }
  }
  return out;
}

/**
 * Whether the top-level 'moov' box precedes the top-level 'mdat' box. 'mdat' (the raw
 * media bytes) never nests inside anything, so this only ever needs the direct children
 * of the file root — no recursion. When there's no top-level 'mdat' at all (unusual, but
 * not this function's problem to flag) there is nothing for 'moov' to trail, so this
 * reports true: absence of the problem, not presence of a fix.
 */
function moovBeforeMdat(buf: Buffer, moov: Box): boolean {
  for (const b of boxes(buf, 0, buf.length)) {
    if (b.type === "mdat") return moov.start < b.start;
  }
  return true;
}

/**
 * Whether any video track's sample description names an HEVC codec (hvc1 or hev1).
 *
 * Scoped per top-level 'trak' (not a single moov-wide search) so a video track's codec
 * is never confused with an audio track's — deliberately tolerant of exactly where
 * 'hdlr'/'stsd' sit inside that trak (real ISO files nest them under mdia/minf/stbl;
 * this codebase's own synthetic test fixtures place 'hdlr' directly under 'trak' with no
 * 'mdia' wrapper at all), since `find` already recurses through any of the container
 * types below regardless of depth.
 *
 * stsd (sample description box) layout: version+flags(4), entry_count(4), then
 * `entry_count` sample entries, each itself a box — [size(4)][fourcc(4)][payload] — whose
 * fourcc names the codec. Only the first entry is read: a track legitimately switching
 * codecs mid-stream is not a real-world case this app needs to detect.
 */
function isHevcVideo(buf: Buffer, moov: Box): boolean {
  for (const trak of boxes(buf, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const hdlrBox = find(buf, trak.start, trak.end, "hdlr");
    if (!hdlrBox || hdlrBox.end - hdlrBox.start < 12) continue;
    const handlerType = buf.toString("ascii", hdlrBox.start + 8, hdlrBox.start + 12);
    if (handlerType !== "vide") continue;

    const stsd = find(buf, trak.start, trak.end, "stsd");
    if (!stsd || stsd.end - stsd.start < 8) continue;
    const entryCount = buf.readUInt32BE(stsd.start + 4);
    let p = stsd.start + 8;
    for (let i = 0; i < entryCount; i++) {
      if (p + 8 > stsd.end) break;
      const size = buf.readUInt32BE(p);
      const fourcc = buf.toString("ascii", p + 4, p + 8);
      if (fourcc === "hvc1" || fourcc === "hev1") return true;
      if (size < 8) break; // malformed entry — stop rather than loop forever
      p += size;
    }
  }
  return false;
}

export function readVideoMeta(buf: Buffer): VideoMeta {
  const moov = find(buf, 0, buf.length, "moov");
  if (!moov) {
    throw new VideoParseError(
      "Could not read this video's properties — no 'moov' header was found. " +
        "The file may be corrupt or still transferring."
    );
  }

  const mvhd = find(buf, moov.start, moov.end, "mvhd");
  if (!mvhd) throw new VideoParseError("Could not read this video's duration ('mvhd' missing).");

  const version = buf.readUInt8(mvhd.start);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    timescale = buf.readUInt32BE(mvhd.start + 20);
    duration = Number(buf.readBigUInt64BE(mvhd.start + 24));
  } else {
    timescale = buf.readUInt32BE(mvhd.start + 12);
    duration = buf.readUInt32BE(mvhd.start + 16);
  }
  if (!timescale) throw new VideoParseError("Could not read this video's duration (timescale is 0).");

  // Dimensions come from the first track that actually has them. An audio track's tkhd
  // carries 0x0, so a plain "first tkhd" read would report a 0x0 video on files that
  // happen to list audio first.
  //
  // tkhd has two versions with different payload layouts (version 1 uses 64-bit
  // creation/modification/duration fields, shifting everything after by 12 bytes):
  //   v0: matrix at +40 (36 bytes), width/height at +76/+80
  //   v1: matrix at +52 (36 bytes), width/height at +88/+92
  //
  // Width/height here are the *stored sample* dimensions, not necessarily the *displayed*
  // ones. iPhones commonly record portrait video as landscape samples plus a 90°/270°
  // rotation in the matrix, so the raw fields alone would report a portrait Reel as
  // landscape — exactly backwards for Reels' portrait-first validation. The matrix is
  // {a, b, u, c, d, v, x, y, w}; for an unrotated video a=1, d=1, b=c=0. For a 90°/270°
  // rotation a=d=0 and b, c are both non-zero, and the displayed dimensions are the
  // stored ones transposed. We only special-case that transposing pattern — arbitrary
  // rotation angles or scaling are out of scope.
  let width = 0;
  let height = 0;
  const MATRIX_EPSILON = 0.01;
  for (const tkhd of findAll(buf, moov.start, moov.end, "tkhd")) {
    const version = buf.readUInt8(tkhd.start);
    const isV1 = version === 1;
    const matrixOffset = isV1 ? 52 : 40;
    const dimOffset = isV1 ? 88 : 76;
    const minSize = isV1 ? 96 : 84;
    if (tkhd.end - tkhd.start < minSize) continue;

    let w = buf.readUInt32BE(tkhd.start + dimOffset) / 65536;
    let h = buf.readUInt32BE(tkhd.start + dimOffset + 4) / 65536;
    if (w > 0 && h > 0) {
      const a = buf.readInt32BE(tkhd.start + matrixOffset) / 65536;
      const b = buf.readInt32BE(tkhd.start + matrixOffset + 4) / 65536;
      const c = buf.readInt32BE(tkhd.start + matrixOffset + 12) / 65536;
      const d = buf.readInt32BE(tkhd.start + matrixOffset + 16) / 65536;
      const isTransposing =
        Math.abs(a) < MATRIX_EPSILON &&
        Math.abs(d) < MATRIX_EPSILON &&
        Math.abs(b) > MATRIX_EPSILON &&
        Math.abs(c) > MATRIX_EPSILON;
      if (isTransposing) {
        [w, h] = [h, w];
      }
      width = Math.round(w);
      height = Math.round(h);
      break;
    }
  }
  if (!width || !height) {
    throw new VideoParseError("Could not read this video's dimensions ('tkhd' missing or empty).");
  }

  const has_audio = findAll(buf, moov.start, moov.end, "hdlr").some(
    (h) => h.end - h.start >= 12 && buf.toString("ascii", h.start + 8, h.start + 12) === "soun"
  );

  return {
    duration_ms: Math.round((duration / timescale) * 1000),
    width,
    height,
    has_audio,
    moov_before_mdat: moovBeforeMdat(buf, moov),
    is_hevc: isHevcVideo(buf, moov),
  };
}
