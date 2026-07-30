import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// config.ts reads ASSET_STORAGE_DIR once at module load, so this must be set BEFORE the
// dynamic import below — same reason test/helpers.ts sets DATABASE_PATH before importing
// queries.ts. Pointing it at a temp dir also guarantees these tests can never touch the
// real asset store, which holds the owner's actual media.
const STORE = mkdtempSync(path.join(tmpdir(), "ss-store-"));
process.env.ASSET_STORAGE_DIR = STORE;

// ---- resolveInsideStore: the rule that stands between a DB string and an unlink --------

test("resolves an ordinary relative path inside the store", async () => {
  const { resolveInsideStore } = await import("./asset-files.ts");
  assert.equal(resolveInsideStore("/store", "abc.jpg"), path.resolve("/store/abc.jpg"));
  assert.equal(
    resolveInsideStore("/store", "pub/abc.jpg"),
    path.resolve("/store/pub/abc.jpg")
  );
});

test("refuses a path that climbs out of the store", async () => {
  const { resolveInsideStore } = await import("./asset-files.ts");
  assert.equal(resolveInsideStore("/store", "../secrets.txt"), null);
  assert.equal(resolveInsideStore("/store", "pub/../../secrets.txt"), null);
  assert.equal(resolveInsideStore("/store", "a/b/c/../../../../etc/passwd"), null);
});

test("refuses an absolute path, which path.resolve would otherwise honour outright", async () => {
  const { resolveInsideStore } = await import("./asset-files.ts");
  // This is the sharpest case: path.resolve(base, "/etc/passwd") discards base entirely.
  assert.equal(resolveInsideStore("/store", "/etc/passwd"), null);
});

test("refuses the store root itself, so the directory can never be the target", async () => {
  const { resolveInsideStore } = await import("./asset-files.ts");
  assert.equal(resolveInsideStore("/store", "."), null);
  assert.equal(resolveInsideStore("/store", ""), null);
});

test("a sibling directory sharing the store's prefix is outside it", async () => {
  const { resolveInsideStore } = await import("./asset-files.ts");
  // Without the `+ path.sep` in the check, "/store-old/x" would pass startsWith("/store").
  assert.equal(resolveInsideStore("/store", "../store-old/x.jpg"), null);
});

// ---- unlinkInsideStore: the real filesystem behaviour ----------------------------------

test("removes a file that lives in the store and reports no leftover", async () => {
  const { unlinkInsideStore } = await import("./asset-files.ts");
  const rel = "gone.jpg";
  writeFileSync(path.join(STORE, rel), "bytes");

  assert.equal(await unlinkInsideStore(rel), null);
  assert.equal(existsSync(path.join(STORE, rel)), false);
});

test("a file that is already missing counts as success, not a leftover", async () => {
  const { unlinkInsideStore } = await import("./asset-files.ts");
  // The real case this covers: an asset whose thumbnail_path names a thumbs/ directory
  // that was never created. ENOENT must not strand the caller, because the row is gone.
  assert.equal(await unlinkInsideStore("thumbs/never-existed.jpg"), null);
});

test("null path is a no-op — assets legitimately have no publish_path or thumbnail", async () => {
  const { unlinkInsideStore } = await import("./asset-files.ts");
  assert.equal(await unlinkInsideStore(null), null);
});

test("an escaping path is reported as leftover and the file is NOT deleted", async () => {
  const { unlinkInsideStore } = await import("./asset-files.ts");
  // A real file outside the store, reachable only by climbing out of it.
  const outside = mkdtempSync(path.join(tmpdir(), "ss-outside-"));
  const victim = path.join(outside, "keep-me.txt");
  writeFileSync(victim, "must survive");
  const escaping = path.relative(STORE, victim); // e.g. "../ss-outside-xxx/keep-me.txt"

  assert.equal(await unlinkInsideStore(escaping), escaping);
  assert.equal(existsSync(victim), true, "file outside the store must survive");
});

test("a subdirectory inside the store is still fair game", async () => {
  const { unlinkInsideStore } = await import("./asset-files.ts");
  mkdirSync(path.join(STORE, "pub"), { recursive: true });
  writeFileSync(path.join(STORE, "pub", "derivative.jpg"), "bytes");

  assert.equal(await unlinkInsideStore("pub/derivative.jpg"), null);
  assert.equal(existsSync(path.join(STORE, "pub", "derivative.jpg")), false);
});
