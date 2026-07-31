import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { avatarContentType } from "./avatar-files";

// asset-files.ts imports config.ts, which reads ASSET_STORAGE_DIR ONCE at module load —
// so it must be set before that module is imported, which is why resolveInsideStore comes
// in through a dynamic import below rather than a static one at the top. Same pattern as
// lib/asset-files.test.ts. avatar-files.ts itself imports only node:path, so it is safe to
// import statically.
const STORE = mkdtempSync(path.join(tmpdir(), "ss-avatar-"));
process.env.ASSET_STORAGE_DIR = STORE;

let resolveInsideStore: typeof import("./asset-files").resolveInsideStore;

before(async () => {
  ({ resolveInsideStore } = await import("./asset-files"));
});

describe("avatarContentType", () => {
  it("maps each stored extension to its image type", () => {
    assert.equal(avatarContentType("avatars/1.jpg"), "image/jpeg");
    assert.equal(avatarContentType("avatars/1.png"), "image/png");
    assert.equal(avatarContentType("avatars/1.webp"), "image/webp");
    assert.equal(avatarContentType("avatars/1.gif"), "image/gif");
  });

  it("falls back to a generic type rather than guessing", () => {
    assert.equal(avatarContentType("avatars/1.bin"), "application/octet-stream");
  });
});

describe("avatar path containment", () => {
  // The route resolves avatar_path the same way the media route resolves storage_path.
  // These paths come out of the database, so the containment rule is what stands between
  // a database string and reading an arbitrary file off the owner's disk.
  const base = path.resolve("/store");

  it("accepts a path inside the store", () => {
    assert.equal(resolveInsideStore(base, "avatars/3.jpg"), path.join(base, "avatars/3.jpg"));
  });

  it("rejects a traversal out of the store", () => {
    assert.equal(resolveInsideStore(base, "../../etc/passwd"), null);
  });

  it("rejects an absolute path", () => {
    assert.equal(resolveInsideStore(base, "/etc/passwd"), null);
  });

  it("rejects a sibling directory that merely shares the prefix", () => {
    assert.equal(resolveInsideStore(base, "../store-old/avatars/3.jpg"), null);
  });
});
