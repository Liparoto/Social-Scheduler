import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * Content type for a stored avatar, derived from its extension.
 *
 * The extension is trustworthy here in a way it would not be for user uploads: the worker
 * writes it from the file's own magic bytes (worker/avatars.py `_image_extension`), never
 * from the CDN URL. Split out from the route so it can be tested — dashboard/package.json
 * only globs lib/*.test.ts and test/*.test.ts.
 */
export function avatarContentType(rel: string): string {
  const ext = path.extname(rel).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
