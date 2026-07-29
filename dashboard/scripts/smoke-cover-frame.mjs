#!/usr/bin/env node
// Smoke test for POST /api/assets/[id]/cover — the cover-frame picker's save endpoint.
//
// The cover is a single millisecond offset (Instagram's thumb_offset), not an image, so
// there is nothing to render or upload here — just the DB round-trip and the route's
// validation. cover_frame_ms: 0 is a legitimate explicit choice ("use the first frame,
// deliberately") and must be accepted and persisted exactly like any other value — it must
// never be treated as "unset" (that's what NULL means).
//
// Same re-exec trick as scripts/smoke-post-now.mjs, for the same reason (lib/queries.ts
// imports "server-only" + uses extensionless/"@/" imports, which plain Node can't resolve).
//
// Run: node scripts/smoke-cover-frame.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_COVER_FRAME_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");
  const dbPath = path.join(
    os.tmpdir(),
    `socialscheduler-smoke-cover-frame-${Date.now()}-${process.pid}.db`
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

  // 2) Import the real query layer + the actual route handler under test.
  const queries = await import("../lib/queries.ts");
  const coverRoute = await import("../app/api/assets/[id]/cover/route.ts");
  const { NextRequest } = await import("next/server");

  const { asset: video } = queries.upsertAssetByHash({
    content_hash: "smoke-cover-frame-video-1",
    media_kind: "video",
    original_filename: "clip.mp4",
    storage_path: "assets/clip.mp4",
    public_url: null,
    thumbnail_path: null,
    mime_type: "video/mp4",
    width: 1080,
    height: 1920,
    byte_size: 55555,
    duration_ms: 10_000,
  });

  const { asset: image } = queries.upsertAssetByHash({
    content_hash: "smoke-cover-frame-image-1",
    media_kind: "image",
    original_filename: "photo.jpg",
    storage_path: "assets/photo.jpg",
    public_url: null,
    thumbnail_path: "thumbs/photo.jpg",
    mime_type: "image/jpeg",
    width: 1080,
    height: 1080,
    byte_size: 12345,
  });

  function coverReq(body) {
    return new NextRequest("http://localhost/api/assets/x/cover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function post(id, body) {
    return coverRoute.POST(coverReq(body), { params: Promise.resolve({ id: String(id) }) });
  }

  // ---- Scenario 1: a valid save persists and round-trips --------------------------
  const res1 = await post(video.id, { cover_frame_ms: 3_500 });
  assert(res1.status === 200, `expected 200 for a valid save, got ${res1.status}`);
  const body1 = await res1.json();
  assert(
    body1.asset.cover_frame_ms === 3_500,
    `expected the response asset to carry cover_frame_ms=3500, got ${body1.asset.cover_frame_ms}`
  );
  const reloaded1 = queries.getAsset(video.id);
  assert(
    reloaded1.cover_frame_ms === 3_500,
    `expected the DB row to round-trip cover_frame_ms=3500, got ${reloaded1.cover_frame_ms}`
  );

  // ---- Scenario 2: cover_frame_ms: 0 is an explicit choice, not "unset" -----------
  const res2 = await post(video.id, { cover_frame_ms: 0 });
  assert(res2.status === 200, `expected 200 for cover_frame_ms:0, got ${res2.status}`);
  const body2 = await res2.json();
  assert(
    body2.asset.cover_frame_ms === 0,
    `expected the response asset to carry cover_frame_ms=0 (not null), got ${body2.asset.cover_frame_ms}`
  );
  const reloaded2 = queries.getAsset(video.id);
  assert(
    reloaded2.cover_frame_ms === 0,
    `expected the DB row to persist the explicit 0, got ${reloaded2.cover_frame_ms}`
  );

  // ---- Scenario 3: an offset past the asset's own duration -> 400 ------------------
  const res3 = await post(video.id, { cover_frame_ms: 10_001 });
  assert(res3.status === 400, `expected 400 for an offset past duration_ms, got ${res3.status}`);
  const reloaded3 = queries.getAsset(video.id);
  assert(
    reloaded3.cover_frame_ms === 0,
    `expected the rejected save to leave cover_frame_ms unchanged at 0, got ${reloaded3.cover_frame_ms}`
  );

  // ---- Scenario 4: a negative offset -> 400 ----------------------------------------
  const res4 = await post(video.id, { cover_frame_ms: -1 });
  assert(res4.status === 400, `expected 400 for a negative offset, got ${res4.status}`);

  // ---- Scenario 5: a non-integer offset -> 400 -------------------------------------
  const res5 = await post(video.id, { cover_frame_ms: 250.5 });
  assert(res5.status === 400, `expected 400 for a non-integer offset, got ${res5.status}`);

  // ---- Scenario 6: an image asset has no cover frame -> 409 ------------------------
  const res6 = await post(image.id, { cover_frame_ms: 0 });
  assert(res6.status === 409, `expected 409 for an image asset, got ${res6.status}`);

  // ---- Scenario 7: an unknown asset id -> 404 --------------------------------------
  const res7 = await post(999_999, { cover_frame_ms: 0 });
  assert(res7.status === 404, `expected 404 for an unknown asset id, got ${res7.status}`);

  console.log("PASS");
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
