#!/usr/bin/env node
// Smoke test for the custom Reels cover-image endpoint:
//   POST /api/assets/[id]/cover-image   (upload + link)
//   DELETE /api/assets/[id]/cover-image (unlink)
//
// Run: node scripts/smoke-cover-image.mjs
//
// Same re-exec trick as scripts/smoke-video-upload.mjs, for the same reason
// (lib/queries.ts imports "server-only" + uses extensionless/"@/" imports), and the
// same scratch ASSET_STORAGE_DIR override — this route writes files to disk, so
// without it config.ts's fallback would write test fixtures into the LIVE asset store.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_COVER_IMAGE_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");
  const stamp = `${Date.now()}-${process.pid}`;
  const dbPath = path.join(os.tmpdir(), `socialscheduler-smoke-cover-image-${stamp}.db`);
  const assetDir = path.join(os.tmpdir(), `socialscheduler-smoke-cover-image-assets-${stamp}`);

  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      `--experimental-loader=${loader}`,
      "--no-warnings",
      self,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        [REEXEC_FLAG]: "1",
        DATABASE_PATH: dbPath,
        ASSET_STORAGE_DIR: assetDir,
      },
    }
  );

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* best-effort cleanup */
    }
  }
  try {
    fs.rmSync(assetDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }

  process.exit(result.status ?? 1);
}

function fail(reason) {
  console.log(`FAIL: ${reason}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

/** Recursive, sorted, relative-path directory listing. Missing dir -> empty list. */
function listFiles(dir) {
  const out = [];
  function walk(rel) {
    const abs = path.join(dir, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childRel);
      } else {
        out.push(childRel);
      }
    }
  }
  walk("");
  return out.sort();
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dbPath = process.env.DATABASE_PATH;
  const assetDir = process.env.ASSET_STORAGE_DIR;
  assert(dbPath, "DATABASE_PATH was not set before import");
  assert(assetDir, "ASSET_STORAGE_DIR was not set before import");

  // 1) Apply every migration against the temp DB file.
  const { default: Database } = await import("better-sqlite3");
  const migrationDb = new Database(dbPath);
  migrationDb.pragma("foreign_keys = ON");
  const migrationFiles = fs
    .readdirSync(path.join(repoRoot, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const migFile of migrationFiles) {
    migrationDb.exec(fs.readFileSync(path.join(repoRoot, "migrations", migFile), "utf8"));
  }
  migrationDb.close();

  // 2) Import the real query layer + the actual route handlers under test.
  const queries = await import("../lib/queries.ts");
  const { config } = await import("../lib/config.ts");
  const coverImageRoute = await import("../app/api/assets/[id]/cover-image/route.ts");
  const sharp = (await import("sharp")).default;
  const { NextRequest } = await import("next/server");

  assert(
    path.resolve(config.assetStorageDir) === path.resolve(assetDir),
    `config.assetStorageDir did not pick up the scratch ASSET_STORAGE_DIR override ` +
      `(got ${config.assetStorageDir})`
  );

  function countAssets() {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare("SELECT COUNT(*) AS n FROM assets").get().n;
    } finally {
      db.close();
    }
  }

  function coverImageReq(method, fileObj) {
    if (!fileObj) {
      return new NextRequest("http://localhost/api/assets/1/cover-image", { method });
    }
    const form = new FormData();
    form.append("file", fileObj);
    return new NextRequest("http://localhost/api/assets/1/cover-image", { method, body: form });
  }

  // ---- Seed fixture assets directly (upsertAssetByHash), same as other smoke tests --
  const { asset: videoAsset } = queries.upsertAssetByHash({
    content_hash: "smoke-video-hash",
    media_kind: "video",
    original_filename: "reel.mp4",
    storage_path: "smoke-video.mp4",
    public_url: null,
    thumbnail_path: null,
    mime_type: "video/mp4",
    width: 1080,
    height: 1920,
    byte_size: 12345,
    duration_ms: 10_000,
    cover_frame_ms: 4200, // pre-existing chosen frame — must survive being overridden
    has_audio: 1,
  });
  const { asset: imageAsset } = queries.upsertAssetByHash({
    content_hash: "smoke-existing-image-hash",
    media_kind: "image",
    original_filename: "photo.jpg",
    storage_path: "smoke-photo.jpg",
    public_url: null,
    thumbnail_path: null,
    mime_type: "image/jpeg",
    width: 800,
    height: 800,
    byte_size: 500,
  });

  // ---- Scenario 1: 1080x1920 (9:16) JPEG onto the video -> 200, no warnings --------
  const portraitJpeg = await sharp({
    create: { width: 1080, height: 1920, channels: 3, background: { r: 30, g: 60, b: 120 } },
  })
    .jpeg()
    .toBuffer();

  const res1 = await coverImageRoute.POST(
    coverImageReq("POST", new File([portraitJpeg], "cover.jpg", { type: "image/jpeg" })),
    { params: Promise.resolve({ id: String(videoAsset.id) }) }
  );
  assert(res1.status === 200, `expected 200 for a 9:16 cover, got ${res1.status}`);
  const body1 = await res1.json();
  assert(
    Array.isArray(body1.warnings) && body1.warnings.length === 0,
    `expected no warnings for a 9:16 cover, got ${JSON.stringify(body1.warnings)}`
  );
  assert(body1.cover.media_kind === "image", `expected the cover to be an image asset`);
  assert(
    body1.asset.cover_asset_id === body1.cover.id,
    `expected the video's cover_asset_id (${body1.asset.cover_asset_id}) to point at the ` +
      `new cover asset (${body1.cover.id})`
  );
  assert(countAssets() === 3, `expected 3 asset rows after linking one new cover, found ${countAssets()}`);
  const firstCoverAssetId = body1.cover.id;

  // ---- Scenario 2: a 1:1 image -> 200 with one ratio warning -----------------------
  const squareJpeg = await sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 200, g: 200, b: 10 } },
  })
    .jpeg()
    .toBuffer();
  const res2 = await coverImageRoute.POST(
    coverImageReq("POST", new File([squareJpeg], "square.jpg", { type: "image/jpeg" })),
    { params: Promise.resolve({ id: String(videoAsset.id) }) }
  );
  assert(res2.status === 200, `expected 200 for a 1:1 cover, got ${res2.status}`);
  const body2 = await res2.json();
  assert(
    Array.isArray(body2.warnings) && body2.warnings.length === 1,
    `expected exactly one warning for a 1:1 cover, got ${JSON.stringify(body2.warnings)}`
  );
  assert(
    body2.warnings[0].toLowerCase().includes("9:16") || body2.warnings[0].toLowerCase().includes("crop"),
    `expected the warning to mention 9:16/cropping, got ${JSON.stringify(body2.warnings[0])}`
  );

  // ---- Scenario 3: cover_frame_ms is untouched by both POSTs above -----------------
  const afterPosts = queries.getAsset(videoAsset.id);
  assert(
    afterPosts.cover_frame_ms === 4200,
    `expected cover_frame_ms to survive being overridden (still 4200), got ${afterPosts.cover_frame_ms}`
  );
  assert(
    afterPosts.cover_asset_id === body2.cover.id,
    `expected cover_asset_id to now point at the second upload (${body2.cover.id}), got ${afterPosts.cover_asset_id}`
  );

  // ---- Scenario 4: DELETE -> cover_asset_id NULL, cover_frame_ms still 4200 --------
  const res4 = await coverImageRoute.DELETE(coverImageReq("DELETE", null), {
    params: Promise.resolve({ id: String(videoAsset.id) }),
  });
  assert(res4.status === 200, `expected 200 for DELETE, got ${res4.status}`);
  const body4 = await res4.json();
  assert(body4.asset.cover_asset_id === null, `expected cover_asset_id NULL after DELETE, got ${body4.asset.cover_asset_id}`);
  assert(
    body4.asset.cover_frame_ms === 4200,
    `expected cover_frame_ms still 4200 after DELETE (restorable), got ${body4.asset.cover_frame_ms}`
  );
  // The cover asset ROW must still exist — DELETE unlinks, never deletes.
  const coverRowStillThere = queries.getAsset(body2.cover.id);
  assert(coverRowStillThere !== undefined, "expected the cover asset row to survive DELETE (unlink only)");
  assert(countAssets() === 4, `expected asset row count unchanged by DELETE (still 4), found ${countAssets()}`);

  // ---- Scenario 5: POST to a non-video (image) asset -> 409 ------------------------
  const res5 = await coverImageRoute.POST(
    coverImageReq("POST", new File([squareJpeg], "whatever.jpg", { type: "image/jpeg" })),
    { params: Promise.resolve({ id: String(imageAsset.id) }) }
  );
  assert(res5.status === 409, `expected 409 for POSTing a cover onto an image asset, got ${res5.status}`);

  // ---- Scenario 6: POST to an unknown asset id -> 404 ------------------------------
  const res6 = await coverImageRoute.POST(
    coverImageReq("POST", new File([squareJpeg], "whatever.jpg", { type: "image/jpeg" })),
    { params: Promise.resolve({ id: "999999" }) }
  );
  assert(res6.status === 404, `expected 404 for an unknown asset id, got ${res6.status}`);

  // ---- Scenario 7: a non-image (text) file -> 422, nothing written -----------------
  const beforeListing = JSON.stringify(listFiles(assetDir));
  const beforeCount = countAssets();
  const res7 = await coverImageRoute.POST(
    coverImageReq("POST", new File([Buffer.from("hello, not an image")], "notes.txt", { type: "text/plain" })),
    { params: Promise.resolve({ id: String(videoAsset.id) }) }
  );
  assert(res7.status === 422, `expected 422 for a non-image file, got ${res7.status}`);
  const afterListing = JSON.stringify(listFiles(assetDir));
  assert(
    beforeListing === afterListing,
    `expected no file written to the asset store on refusal; before=${beforeListing} after=${afterListing}`
  );
  assert(
    countAssets() === beforeCount,
    `expected no new asset row on refusal (still ${beforeCount}), found ${countAssets()}`
  );

  // ---- Scenario 8: dedup — the SAME cover bytes uploaded twice reuse the row -------
  const dedupJpeg = await sharp({
    create: { width: 1080, height: 1920, channels: 3, background: { r: 5, g: 250, b: 5 } },
  })
    .jpeg()
    .toBuffer();
  const resA = await coverImageRoute.POST(
    coverImageReq("POST", new File([dedupJpeg], "dedup-a.jpg", { type: "image/jpeg" })),
    { params: Promise.resolve({ id: String(videoAsset.id) }) }
  );
  assert(resA.status === 200, `expected 200 for the first dedup upload, got ${resA.status}`);
  const bodyA = await resA.json();
  const countAfterFirst = countAssets();

  const resB = await coverImageRoute.POST(
    coverImageReq("POST", new File([dedupJpeg], "dedup-b.jpg", { type: "image/jpeg" })),
    { params: Promise.resolve({ id: String(videoAsset.id) }) }
  );
  assert(resB.status === 200, `expected 200 for the second (dedup) upload, got ${resB.status}`);
  const bodyB = await resB.json();
  assert(
    bodyB.cover.id === bodyA.cover.id,
    `expected the dedup upload to reuse the same cover asset id (${bodyA.cover.id}), got ${bodyB.cover.id}`
  );
  assert(
    countAssets() === countAfterFirst,
    `expected no new asset row from the dedup re-upload (still ${countAfterFirst}), found ${countAssets()}`
  );
  // firstCoverAssetId is unused directly but documents scenario 1's created id for clarity.
  void firstCoverAssetId;

  console.log("PASS");
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
