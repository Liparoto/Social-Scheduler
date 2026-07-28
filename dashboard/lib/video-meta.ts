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
  let width = 0;
  let height = 0;
  for (const tkhd of findAll(buf, moov.start, moov.end, "tkhd")) {
    if (tkhd.end - tkhd.start < 84) continue;
    const w = buf.readUInt32BE(tkhd.start + 76) / 65536;
    const h = buf.readUInt32BE(tkhd.start + 80) / 65536;
    if (w > 0 && h > 0) {
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
  };
}
