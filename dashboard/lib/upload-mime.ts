import { REEL_MIME_TYPES } from "./video-spec";

/**
 * Deciding what an uploaded file actually IS.
 *
 * The upload route used to trust `file.type` alone. That value is not a property of the
 * file — the browser fills it in from the operating system, and on Windows it comes out of
 * the registry. A machine with no application registered for `.webp` reports `""` (or
 * `application/octet-stream`) for every .webp on disk, so a Google Photos Takeout import
 * failed with 415 "Only JPEG, PNG or WebP images…" on files that were, in fact, WebP.
 * image/webp had been in the allow-list since the first commit; the declared type was the
 * broken part, not the list.
 *
 * The first bytes of the file are authoritative and cost nothing to check, so they get the
 * final say whenever the declared type is missing or isn't one we accept.
 */

/** Accepted image types, and the extension each is stored under. */
export const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString("ascii");
}

/**
 * The media type of these bytes, or null if it isn't one this app accepts.
 *
 * Deliberately narrow: it only recognises the types the uploader already supports, so it
 * can never widen what gets through — it only stops a supported file being turned away for
 * having no declared type.
 */
export function sniffMediaMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;

  // FF D8 FF — every JPEG variant (JFIF, Exif, raw).
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";

  // The 8-byte PNG signature, including the CRLF/EOF bytes that detect line-ending damage.
  if (ascii(buf, 1, 4) === "PNG" && buf[0] === 0x89 && buf[4] === 0x0d && buf[5] === 0x0a) {
    return "image/png";
  }

  // RIFF alone is not enough — WAV and AVI are RIFF containers too. The form type at
  // bytes 8-11 is what makes it a WebP, and matching on "RIFF" only would wave a WAV
  // through to sharp to fail there with a much worse error.
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return "image/webp";

  // ISO base media (MP4/MOV): a 'ftyp' box at byte 4. The brand that follows separates
  // QuickTime from everything else.
  if (ascii(buf, 4, 8) === "ftyp") {
    return ascii(buf, 8, 12).trimEnd() === "qt" ? "video/quicktime" : "video/mp4";
  }

  return null;
}

/**
 * The type to treat this upload as, or null if it genuinely isn't supported.
 *
 * A declared type we accept is kept as-is (it is more specific than sniffing can be — MOV
 * and MP4 share a container). Anything else defers to the bytes.
 */
export function resolveUploadMime(declaredMime: string, buf: Buffer): string | null {
  if (IMAGE_EXT_BY_MIME[declaredMime] || REEL_MIME_TYPES[declaredMime]) return declaredMime;
  return sniffMediaMime(buf);
}
