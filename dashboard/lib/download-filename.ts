/**
 * Turning a stored asset into a filename safe to put in a `Content-Disposition` header.
 *
 * Two separate problems live here, and only one of them is cosmetic.
 *
 * The cosmetic one: assets are stored under content-hash names, so a download named after
 * `storage_path` arrives as `a3f9c1…jpg` and is useless in a Downloads folder. The
 * `original_filename` column already holds the name the file had when it was uploaded.
 *
 * The one that matters: `original_filename` is attacker-adjacent text. It comes from
 * whatever the browser reported at upload, and (see `browser-declared-mime-is-unreliable`)
 * that channel has already proven untrustworthy on this project. A name containing CR or
 * LF splits the HTTP response; a name containing a double quote ends the header's quoted
 * string early; a name containing `/` or `..` is a path shape that some download managers
 * will honour. All three are stripped here rather than at the call site, so there is one
 * place to get it right.
 */

/** Characters that would break out of a quoted header value, plus path separators. */
const UNSAFE = /[\u0000-\u001f\u007f"\\]/g;

/** Strip any directory component, whatever separator was used. */
function baseName(name: string): string {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/** The extension of a path, including the dot, or "" when there isn't one. */
function extensionOf(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  // A leading dot is a hidden file (".gitignore"), not an extension.
  return dot > 0 ? base.slice(dot) : "";
}

/**
 * A human-meaningful, header-safe filename for one asset.
 *
 * Falls back to `asset-<id>` (with the stored file's extension, so the OS still opens it
 * with the right app) whenever `original_filename` is missing or sanitizes away to nothing.
 */
export function downloadFilename(
  originalFilename: string | null | undefined,
  assetId: number,
  storagePath: string
): string {
  const fallbackExt = extensionOf(storagePath);
  const fallback = `asset-${assetId}${fallbackExt}`;

  if (!originalFilename) return fallback;

  const cleaned = baseName(originalFilename).replace(UNSAFE, "").trim();
  // ".." survives baseName and the strip above, but naming a file ".." is nonsense — and
  // a bare "." or ".." is exactly the traversal shape this function exists to defuse.
  if (!cleaned || /^\.+$/.test(cleaned)) return fallback;

  // A name that lost its extension somewhere (or never had one) still needs to open in the
  // right app, so borrow the stored file's.
  return extensionOf(cleaned) ? cleaned : `${cleaned}${fallbackExt}`;
}

/**
 * The full `Content-Disposition` value for an attachment download.
 *
 * Emits BOTH filename forms on purpose. `filename=` is ASCII-only by spec, so an emoji or
 * accented name has to be folded down for it; `filename*=` (RFC 5987) carries the real
 * UTF-8 name percent-encoded, and every current browser prefers it when both are present.
 * Sending only the ASCII form would quietly mangle the many real filenames on this install
 * that are not ASCII.
 */
export function contentDisposition(filename: string): string {
  // Anything outside printable ASCII becomes "_" in the legacy parameter — a readable
  // stand-in, not a guess at what the character meant.
  const ascii = filename.replace(/[^\u0020-\u007e]/g, "_").replace(UNSAFE, "");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
