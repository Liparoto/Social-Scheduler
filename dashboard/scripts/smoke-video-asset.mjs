#!/usr/bin/env node
// Smoke test for migration 0011 + the insert path: a video asset round-trips its three
// new columns (duration_ms, cover_frame_ms, has_audio), and an image asset still inserts
// with sane defaults (back-compat).
//
// Same re-exec trick as scripts/smoke-post-now.mjs, for the same reason (lib/queries.ts
// imports "server-only" + uses extensionless/"@/" imports, which plain Node can't resolve).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_VIDEO_ASSET_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");
  const dbPath = path.join(
    os.tmpdir(),
    `socialscheduler-smoke-video-asset-${Date.now()}-${process.pid}.db`
  );

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
      env: { ...process.env, [REEXEC_FLAG]: "1", DATABASE_PATH: dbPath },
    }
  );

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* best-effort cleanup */
    }
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

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dbPath = process.env.DATABASE_PATH;
  assert(dbPath, "DATABASE_PATH was not set before import");

  // 1) Apply every migration against the temp DB file.
  const { default: Database } = await import("better-sqlite3");
  const migrationDb = new Database(dbPath);
  migrationDb.pragma("foreign_keys = ON");
  const migrationFiles = fs
    .readdirSync(path.join(repoRoot, "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    migrationDb.exec(fs.readFileSync(path.join(repoRoot, "migrations", file), "utf8"));
  }
  migrationDb.close();

  // 2) Import the real query layer under test.
  const { upsertAssetByHash, getAsset } = await import("../lib/queries.ts");

  const vid = upsertAssetByHash({
    content_hash: "smoke-video-" + Date.now(),
    media_kind: "video",
    original_filename: "clip.mov",
    storage_path: "x.mov",
    public_url: null,
    thumbnail_path: null,
    mime_type: "video/quicktime",
    width: 1080,
    height: 1920,
    byte_size: 1234,
    duration_ms: 12_500,
    has_audio: 1,
  }).asset;

  assert(vid.media_kind === "video", "media_kind not persisted as video");
  assert(vid.duration_ms === 12_500, `duration_ms=${vid.duration_ms}`);
  assert(vid.has_audio === 1, `has_audio=${vid.has_audio}`);
  assert(vid.cover_frame_ms === null, "cover_frame_ms should default to NULL");
  assert(vid.thumbnail_path === null, "video should have no thumbnail");

  // Sanity: getAsset(id) round-trips the same values as the insert result.
  const reloaded = getAsset(vid.id);
  assert(reloaded, `expected getAsset(${vid.id}) to find the inserted video`);
  assert(reloaded.duration_ms === 12_500, `reloaded duration_ms=${reloaded.duration_ms}`);
  assert(reloaded.has_audio === 1, `reloaded has_audio=${reloaded.has_audio}`);

  const img = upsertAssetByHash({
    content_hash: "smoke-image-" + Date.now(),
    media_kind: "image",
    original_filename: "p.jpg",
    storage_path: "p.jpg",
    public_url: null,
    thumbnail_path: "thumbs/p.jpg",
    mime_type: "image/jpeg",
    width: 1080,
    height: 1080,
    byte_size: 999,
  }).asset;

  assert(img.duration_ms === null, "image duration_ms should be NULL");
  assert(img.has_audio === 0, "image has_audio should default to 0");

  console.log("OK — video and image assets both round-trip correctly");
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
