#!/usr/bin/env node
// Smoke test for video upload support: POST /api/assets/upload accepting MP4/MOV,
// validating against the Reels spec (dashboard/lib/video-spec.ts), and storing the
// result — plus the regression guard that the pre-existing image path is untouched.
//
// Run: node scripts/smoke-video-upload.mjs
//
// Same re-exec trick as scripts/smoke-post-now.mjs, for the same reason
// (lib/queries.ts imports "server-only" + uses extensionless/"@/" imports). This
// script ALSO overrides ASSET_STORAGE_DIR to a scratch directory, because — unlike
// smoke-post-now.mjs, which only ever inserts synthetic rows — the upload route
// under test actually writes files to disk. Without this override, config.ts's
// fallback ("data/assets" resolved from the repo root) would write test fixtures
// into the LIVE asset store.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_VIDEO_UPLOAD_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");
  const stamp = `${Date.now()}-${process.pid}`;
  const dbPath = path.join(os.tmpdir(), `socialscheduler-smoke-video-upload-${stamp}.db`);
  const assetDir = path.join(os.tmpdir(), `socialscheduler-smoke-video-upload-assets-${stamp}`);

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

// ---- Synthetic MP4 fixture builder --------------------------------------------------
// Copied from scripts/test-video-meta.mjs (that script runs its own assertions at
// import time, so importing it directly here would execute a second, unrelated test
// suite as a side effect). See that file for the box-layout derivations/comments.

/** Build one MP4 box: [size][type][payload]. */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
}

function mvhd(timescale, duration, { version = 0 } = {}) {
  if (version === 1) {
    const p = Buffer.alloc(112);
    p.writeUInt8(1, 0);
    p.writeUInt32BE(timescale, 20);
    p.writeBigUInt64BE(BigInt(duration), 24);
    return box("mvhd", p);
  }
  const p = Buffer.alloc(100);
  p.writeUInt32BE(0, 0);
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box("mvhd", p);
}

function tkhd(width, height, { rotate90 = false, rotate270 = false, version = 0 } = {}) {
  const FIX = 65536;
  let a = FIX, b = 0, c = 0, d = FIX;
  if (rotate90) {
    a = 0; b = 1 * FIX; c = -1 * FIX; d = 0;
  } else if (rotate270) {
    a = 0; b = -1 * FIX; c = 1 * FIX; d = 0;
  }

  if (version === 1) {
    const p = Buffer.alloc(96);
    p.writeUInt8(1, 0);
    const matrixOffset = 52;
    p.writeInt32BE(a, matrixOffset);
    p.writeInt32BE(b, matrixOffset + 4);
    p.writeInt32BE(c, matrixOffset + 12);
    p.writeInt32BE(d, matrixOffset + 16);
    p.writeInt32BE(1 << 30, matrixOffset + 32);
    p.writeUInt32BE(width * 65536, 88);
    p.writeUInt32BE(height * 65536, 92);
    return box("tkhd", p);
  }

  const p = Buffer.alloc(84);
  p.writeUInt32BE(0, 0);
  p.writeInt32BE(a, 40);
  p.writeInt32BE(b, 44);
  p.writeInt32BE(c, 52);
  p.writeInt32BE(d, 56);
  p.writeInt32BE(1 << 30, 72);
  p.writeUInt32BE(width * 65536, 76);
  p.writeUInt32BE(height * 65536, 80);
  return box("tkhd", p);
}

function hdlr(kind) {
  const p = Buffer.alloc(24);
  p.write(kind, 8, "ascii");
  return box("hdlr", p);
}

function file({
  timescale = 600,
  duration = 6000,
  w = 1080,
  h = 1920,
  audio = true,
  moovFirst = true,
  rotate90 = false,
  rotate270 = false,
  mvhdVersion = 0,
  tkhdVersion = 0,
} = {}) {
  const ftyp = box("ftyp", Buffer.from("isomiso2avc1mp41", "ascii"));
  const tracks = [
    box("trak", Buffer.concat([tkhd(w, h, { rotate90, rotate270, version: tkhdVersion }), hdlr("vide")])),
  ];
  if (audio) tracks.push(box("trak", Buffer.concat([tkhd(0, 0), hdlr("soun")])));
  const moov = box("moov", Buffer.concat([mvhd(timescale, duration, { version: mvhdVersion }), ...tracks]));
  const mdat = box("mdat", Buffer.alloc(64));
  return moovFirst
    ? Buffer.concat([ftyp, moov, mdat])
    : Buffer.concat([ftyp, mdat, moov]);
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
  const uploadRoute = await import("../app/api/assets/upload/route.ts");
  const sharp = (await import("sharp")).default;
  const { NextRequest } = await import("next/server");

  assert(
    path.resolve(config.assetStorageDir) === path.resolve(assetDir),
    `config.assetStorageDir did not pick up the scratch ASSET_STORAGE_DIR override ` +
      `(got ${config.assetStorageDir})`
  );

  function uploadReq(fileObj) {
    const form = new FormData();
    form.append("file", fileObj);
    return new NextRequest("http://localhost/api/assets/upload", {
      method: "POST",
      body: form,
    });
  }

  // ---- Scenario 1: a synthetic valid MP4 -------------------------------------------
  const validMp4 = file({ timescale: 600, duration: 6000, w: 1080, h: 1920, audio: true });
  const res1 = await uploadRoute.POST(
    uploadReq(new File([validMp4], "reel.mp4", { type: "video/mp4" }))
  );
  assert(res1.status === 200, `expected 200 for a valid MP4, got ${res1.status}`);
  const body1 = await res1.json();
  assert(
    body1.asset.media_kind === "video",
    `expected media_kind 'video', got '${body1.asset.media_kind}'`
  );
  assert(body1.asset.duration_ms === 10_000, `expected duration_ms 10000, got ${body1.asset.duration_ms}`);
  assert(
    body1.asset.thumbnail_path === null,
    `expected thumbnail_path null for video, got ${body1.asset.thumbnail_path}`
  );
  assert(
    body1.asset.publish_path === null,
    `expected publish_path null for video, got ${body1.asset.publish_path}`
  );

  // ---- Scenario 2: the same bytes uploaded twice -> dedup, no second row -----------
  const res2 = await uploadRoute.POST(
    uploadReq(new File([validMp4], "reel-again.mp4", { type: "video/mp4" }))
  );
  assert(res2.status === 200, `expected 200 for the duplicate upload, got ${res2.status}`);
  const body2 = await res2.json();
  assert(body2.deduped === true, "expected deduped:true for a re-upload of identical bytes");
  assert(
    body2.asset.id === body1.asset.id,
    `expected the deduped upload to return the same asset id (${body1.asset.id}), got ${body2.asset.id}`
  );
  const rowCount = migrationDbCount(dbPath, body1.asset.content_hash);
  assert(rowCount === 1, `expected exactly 1 assets row for the content hash, found ${rowCount}`);

  // ---- Scenario 3: a 20-second landscape video -> 200 with letterbox warning -------
  const landscape20s = file({ timescale: 1000, duration: 20_000, w: 1920, h: 1080, audio: true });
  const res3 = await uploadRoute.POST(
    uploadReq(new File([landscape20s], "landscape.mp4", { type: "video/mp4" }))
  );
  assert(res3.status === 200, `expected 200 for a valid landscape video, got ${res3.status}`);
  const body3 = await res3.json();
  assert(
    Array.isArray(body3.warnings) && body3.warnings.length > 0,
    "expected a non-empty warnings array for a landscape (letterboxing) video"
  );
  assert(
    body3.warnings.some((w) => w.toLowerCase().includes("letterbox")),
    `expected a warning mentioning letterboxing, got ${JSON.stringify(body3.warnings)}`
  );

  // ---- Scenario 4: a 2-second video -> 422, error names "3 seconds" ----------------
  const tooShort = file({ timescale: 1000, duration: 2000, w: 1080, h: 1920, audio: true });
  const res4 = await uploadRoute.POST(
    uploadReq(new File([tooShort], "short.mp4", { type: "video/mp4" }))
  );
  assert(res4.status === 422, `expected 422 for a 2-second video, got ${res4.status}`);
  const body4 = await res4.json();
  assert(
    typeof body4.error === "string" && body4.error.includes("3 seconds"),
    `expected the error to name "3 seconds", got ${JSON.stringify(body4.error)}`
  );

  // ---- Scenario 5: text/plain -> 415 -----------------------------------------------
  const res5 = await uploadRoute.POST(
    uploadReq(new File([Buffer.from("hello")], "notes.txt", { type: "text/plain" }))
  );
  assert(res5.status === 415, `expected 415 for text/plain, got ${res5.status}`);

  // ---- Scenario 6: garbage bytes with a video/mp4 type -> 422, no orphan file -----
  const beforeListing = JSON.stringify(listFiles(assetDir));
  const res6 = await uploadRoute.POST(
    uploadReq(new File([Buffer.from("definitely not a video")], "garbage.mp4", { type: "video/mp4" }))
  );
  assert(res6.status === 422, `expected 422 for unparseable "video", got ${res6.status}`);
  const afterListing = JSON.stringify(listFiles(assetDir));
  assert(
    beforeListing === afterListing,
    `expected no file written to the asset store on refusal; before=${beforeListing} after=${afterListing}`
  );

  // ---- Scenario 7: REGRESSION GUARD — JPEG upload is completely unchanged ---------
  const jpegBuf = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer();
  const res7 = await uploadRoute.POST(
    uploadReq(new File([jpegBuf], "photo.jpg", { type: "image/jpeg" }))
  );
  assert(res7.status === 200, `expected 200 for a JPEG upload, got ${res7.status}`);
  const body7 = await res7.json();
  assert(
    body7.asset.media_kind === "image",
    `expected media_kind 'image', got '${body7.asset.media_kind}'`
  );
  assert(
    typeof body7.asset.thumbnail_path === "string" && body7.asset.thumbnail_path.length > 0,
    `expected a thumbnail_path for the JPEG regression check, got ${body7.asset.thumbnail_path}`
  );
  assert(
    typeof body7.asset.publish_path === "string" && body7.asset.publish_path.length > 0,
    `expected a publish_path for the JPEG regression check, got ${body7.asset.publish_path}`
  );

  console.log("PASS");

  function migrationDbCount(dbFile, contentHash) {
    const db = new Database(dbFile, { readonly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM assets WHERE content_hash = ?")
        .get(contentHash);
      return row.n;
    } finally {
      db.close();
    }
  }
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
