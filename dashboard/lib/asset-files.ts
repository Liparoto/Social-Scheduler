import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

/**
 * Resolve a stored-file path against the asset store, returning null if it escapes.
 *
 * Split out from unlinkInsideStore() below so the containment rule can be tested without
 * touching a filesystem — it is the check standing between a database string and an
 * irreversible unlink, so it deserves direct tests rather than inference from the
 * endpoint's behaviour. Same rule as app/api/media/[id]/route.ts: the `+ path.sep` matters,
 * or a sibling store named `assets-old` would satisfy a bare startsWith(base).
 *
 * Note this is lexical, not symlink-aware — path.resolve() does not follow links, so a
 * symlinked directory component inside the store would still be traversed. worker/
 * asset_server.py's resolve_within() is stricter (it calls .resolve()). The paths here are
 * written by the app itself and are content-hash derived, so the gap is theoretical; it is
 * recorded rather than closed to keep this identical to the media route it mirrors.
 */
export function resolveInsideStore(base: string, rel: string): string | null {
  const root = path.resolve(base);
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/**
 * Unlink a stored file, but only if it really resolves inside the asset store — these
 * paths come out of the database, and a path that escapes the store must never be deleted.
 * Returns the path if it could NOT be removed, so the caller can report leftovers.
 */
export async function unlinkInsideStore(rel: string | null): Promise<string | null> {
  if (!rel) return null;
  const abs = resolveInsideStore(config.assetStorageDir, rel);
  if (!abs) return rel;
  try {
    await fs.unlink(abs);
    return null;
  } catch (err) {
    // Already gone is success — the row is what the UI reads.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return rel;
  }
}
