#!/usr/bin/env node
// Smoke test for automatic video conversion on upload: an out-of-spec video (too wide,
// e.g. an iPhone's default 4K 2160x3840 recording) is downscaled to a Reels-legal size
// instead of being refused, while the fatal/convertible ordering, dedup, and the
// existing image + in-spec-video paths all stay exactly as they were.
//
// Run: node scripts/smoke-video-convert-upload.mjs
//
// Same re-exec trick as scripts/smoke-video-upload.mjs (read that file first — this one
// follows it closely), for the same reason (lib/queries.ts imports "server-only" +
// uses extensionless/"@/" imports) and the same scratch DATABASE_PATH + ASSET_STORAGE_DIR
// setup (the upload route under test writes real files to disk).
//
// One addition over smoke-video-upload.mjs: testing VIDEO_CONVERTER=off requires a
// FRESH module load of lib/config.ts with that env var set BEFORE import — config values
// (other than the live-reloaded DRY_RUN/KILL_SWITCH) are read once at module load, so
// this can't be flipped mid-process. The top-level orchestrator below therefore spawns
// TWO child processes, each with its own scratch DB/asset dir: one for the default
// (auto-detect) converter scenarios, one with VIDEO_CONVERTER=off.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_VIDEO_CONVERT_UPLOAD_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");

  function runChild(mode, extraEnv) {
    const stamp = `${Date.now()}-${process.pid}-${mode}`;
    const dbPath = path.join(os.tmpdir(), `socialscheduler-smoke-video-convert-${stamp}.db`);
    const assetDir = path.join(
      os.tmpdir(),
      `socialscheduler-smoke-video-convert-assets-${stamp}`
    );

    const result = spawnSync(
      process.execPath,
      ["--conditions=react-server", `--experimental-loader=${loader}`, "--no-warnings", self],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          [REEXEC_FLAG]: "1",
          SMOKE_MODE: mode,
          DATABASE_PATH: dbPath,
          ASSET_STORAGE_DIR: assetDir,
          ...extraEnv,
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

    return result.status ?? 1;
  }

  const defaultStatus = runChild("default", {});
  if (defaultStatus !== 0) process.exit(defaultStatus);

  const offStatus = runChild("off", { VIDEO_CONVERTER: "off" });
  process.exit(offStatus);
}

function fail(reason) {
  console.log(`FAIL: ${reason}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

// ---- Synthetic MP4 fixture builder --------------------------------------------------
// Copied from scripts/smoke-video-upload.mjs / scripts/test-video-meta.mjs (importing
// either directly would run its own unrelated assertions/side effects at import time).

/** Build one MP4 box: [size][type][payload]. */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length + 8, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
}

function mvhd(timescale, duration) {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(0, 0);
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box("mvhd", p);
}

function tkhd(width, height) {
  const FIX = 65536;
  const p = Buffer.alloc(84);
  p.writeUInt32BE(0, 0);
  p.writeInt32BE(FIX, 40);
  p.writeInt32BE(FIX, 56);
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

function file({ timescale = 600, duration = 6000, w = 1080, h = 1920, audio = true } = {}) {
  const ftyp = box("ftyp", Buffer.from("isomiso2avc1mp41", "ascii"));
  const tracks = [box("trak", Buffer.concat([tkhd(w, h), hdlr("vide")]))];
  if (audio) tracks.push(box("trak", Buffer.concat([tkhd(0, 0), hdlr("soun")])));
  const moov = box("moov", Buffer.concat([mvhd(timescale, duration), ...tracks]));
  const mdat = box("mdat", Buffer.alloc(64));
  return Buffer.concat([ftyp, moov, mdat]);
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

function countAssetRows(Database, dbFile, contentHash) {
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

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const dbPath = process.env.DATABASE_PATH;
  const assetDir = process.env.ASSET_STORAGE_DIR;
  const mode = process.env.SMOKE_MODE || "default";
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

  // 2) Import the real query layer + the actual route handler under test, AFTER the
  // scratch env vars (including VIDEO_CONVERTER for the "off" child) are in place.
  const { config } = await import("../lib/config.ts");
  const uploadRoute = await import("../app/api/assets/upload/route.ts");
  const { readVideoMeta } = await import("../lib/video-meta.ts");
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

  const fourKPath = path.join(os.homedir(), "Downloads", "IMG_3707.MOV");
  const fourKAvailable = fs.existsSync(fourKPath);

  if (mode === "off") {
    // ---- Scenario 6: VIDEO_CONVERTER=off ------------------------------------------
    assert(
      config.videoConverter === "off",
      `expected config.videoConverter === "off" in the off-mode child, got ${config.videoConverter}`
    );
    if (!fourKAvailable) {
      console.log(
        `SKIP: ${fourKPath} not found — skipping the VIDEO_CONVERTER=off check ` +
          `(scenario 6). The rest of the suite still ran in the default-mode child.`
      );
      console.log("PASS");
      return;
    }
    const buf4k = fs.readFileSync(fourKPath);
    const beforeListing = listFiles(assetDir);
    const res = await uploadRoute.POST(
      uploadReq(new File([buf4k], "IMG_3707.MOV", { type: "video/quicktime" }))
    );
    assert(res.status === 422, `expected 422 with VIDEO_CONVERTER=off, got ${res.status}`);
    const body = await res.json();
    assert(
      typeof body.error === "string" && body.error.includes("1920"),
      `expected the width-cap message, got ${JSON.stringify(body.error)}`
    );
    assert(
      body.error.toLowerCase().includes("ffmpeg"),
      `expected the ffmpeg-install hint, got ${JSON.stringify(body.error)}`
    );
    const afterListing = listFiles(assetDir);
    assert(
      JSON.stringify(beforeListing) === JSON.stringify(afterListing),
      `expected nothing written to the asset store when VIDEO_CONVERTER=off; ` +
        `before=${JSON.stringify(beforeListing)} after=${JSON.stringify(afterListing)}`
    );
    console.log("PASS");
    return;
  }

  // ---- Scenarios 1, 2, 4: the real 4K file — convert, retain original, dedup --------
  if (!fourKAvailable) {
    console.log(
      `SKIP: ${fourKPath} not found — skipping the real-4K conversion checks ` +
        `(scenarios 1, 2, 4). The rest of the suite still ran.`
    );
  } else {
    const buf4k = fs.readFileSync(fourKPath);

    const res1 = await uploadRoute.POST(
      uploadReq(new File([buf4k], "IMG_3707.MOV", { type: "video/quicktime" }))
    );
    assert(res1.status === 200, `expected 200 for the 4K file, got ${res1.status}`);
    const body1 = await res1.json();
    const asset1 = body1.asset;
    assert(asset1.width === 1080, `expected asset.width 1080, got ${asset1.width}`);
    assert(asset1.height === 1920, `expected asset.height 1920, got ${asset1.height}`);
    assert(
      asset1.conform_mode === "downscale",
      `expected conform_mode 'downscale', got ${asset1.conform_mode}`
    );
    assert(asset1.needs_review === 1, `expected needs_review 1, got ${asset1.needs_review}`);
    assert(
      typeof asset1.publish_path === "string" && asset1.publish_path.length > 0,
      `expected a non-null publish_path, got ${asset1.publish_path}`
    );
    assert(
      typeof asset1.storage_path === "string" && asset1.storage_path.length > 0,
      `expected storage_path to be present, got ${asset1.storage_path}`
    );
    assert(
      body1.converted &&
        body1.converted.from === "2160×3840" &&
        body1.converted.to === "1080×1920",
      `expected converted: { from: "2160×3840", to: "1080×1920" }, got ${JSON.stringify(body1.converted)}`
    );

    // The file at publish_path exists and re-parses to 1080x1920 (this is what Meta
    // will actually be sent).
    const publishAbs = path.join(assetDir, asset1.publish_path);
    assert(fs.existsSync(publishAbs), `expected a file on disk at ${publishAbs}`);
    const publishMeta = readVideoMeta(fs.readFileSync(publishAbs));
    assert(
      publishMeta.width === 1080 && publishMeta.height === 1920,
      `expected the file at publish_path to re-parse as 1080x1920, got ` +
        `${publishMeta.width}x${publishMeta.height}`
    );

    // ---- Scenario 2: the ORIGINAL is retained, untouched, at storage_path ----------
    const storageAbs = path.join(assetDir, asset1.storage_path);
    assert(fs.existsSync(storageAbs), `expected the original retained at ${storageAbs}`);
    const originalMeta = readVideoMeta(fs.readFileSync(storageAbs));
    assert(
      originalMeta.width === 2160 && originalMeta.height === 3840,
      `expected the retained original to still be 2160x3840, got ` +
        `${originalMeta.width}x${originalMeta.height}`
    );

    // ---- Scenario 4: dedup — re-uploading the same 4K bytes must not re-convert ----
    const res2 = await uploadRoute.POST(
      uploadReq(new File([buf4k], "IMG_3707-again.MOV", { type: "video/quicktime" }))
    );
    assert(res2.status === 200, `expected 200 for the dedup re-upload, got ${res2.status}`);
    const body2 = await res2.json();
    assert(body2.deduped === true, "expected deduped:true for the second 4K upload");
    assert(
      body2.asset.id === asset1.id,
      `expected the deduped upload to return the same asset id (${asset1.id}), got ${body2.asset.id}`
    );
    assert(
      !("converted" in body2),
      `expected no "converted" key (no re-conversion) on a deduped upload, got ${JSON.stringify(body2.converted)}`
    );
    const rowCount = countAssetRows(Database, dbPath, asset1.content_hash);
    assert(rowCount === 1, `expected exactly 1 assets row for the 4K content hash, found ${rowCount}`);
  }

  // ---- Scenario 3: an in-spec video — today's path exactly, untouched --------------
  const inSpec = file({ timescale: 600, duration: 6000, w: 1080, h: 1920, audio: true });
  const res3 = await uploadRoute.POST(
    uploadReq(new File([inSpec], "inspec.mp4", { type: "video/mp4" }))
  );
  assert(res3.status === 200, `expected 200 for an in-spec video, got ${res3.status}`);
  const body3 = await res3.json();
  assert(
    body3.asset.publish_path === null,
    `expected publish_path null for an in-spec video, got ${body3.asset.publish_path}`
  );
  assert(
    body3.asset.conform_mode === "none",
    `expected conform_mode 'none' for an in-spec video, got ${body3.asset.conform_mode}`
  );
  assert(
    !("converted" in body3),
    `expected no "converted" key for an in-spec upload, got ${JSON.stringify(body3.converted)}`
  );

  // ---- Scenario 5: a too-long video — fatal, refused fast, no conversion attempted -
  const tooLong = file({ timescale: 1000, duration: 16 * 60 * 1000, w: 1080, h: 1920, audio: true });
  const beforeTooLong = listFiles(assetDir);
  const t0 = Date.now();
  const res5 = await uploadRoute.POST(
    uploadReq(new File([tooLong], "toolong.mp4", { type: "video/mp4" }))
  );
  const elapsedMs = Date.now() - t0;
  assert(res5.status === 422, `expected 422 for a too-long video, got ${res5.status}`);
  const body5 = await res5.json();
  assert(
    typeof body5.error === "string" && body5.error.includes("16m00s"),
    `expected the error to name the duration ("16m00s"), got ${JSON.stringify(body5.error)}`
  );
  assert(
    body5.error.includes("15 minutes"),
    `expected the error to name the 15-minute cap, got ${JSON.stringify(body5.error)}`
  );
  assert(
    elapsedMs < 2000,
    `expected a fast (<2s) refusal with no conversion attempted, took ${elapsedMs}ms`
  );
  const afterTooLong = listFiles(assetDir);
  assert(
    JSON.stringify(beforeTooLong) === JSON.stringify(afterTooLong),
    `expected no file written to the asset store on a fatal refusal; ` +
      `before=${JSON.stringify(beforeTooLong)} after=${JSON.stringify(afterTooLong)}`
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
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
