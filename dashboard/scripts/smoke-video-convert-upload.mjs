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
  if (offStatus !== 0) process.exit(offStatus);

  // ---- Minor 8 (review follow-up): conversion-failure and derivative-still-invalid --
  // Both scenarios need a converter outcome that's deterministic regardless of what's
  // actually installed on this machine (and regardless of whether real encoded video
  // data would happen to convert). VIDEO_CONVERTER=ffmpeg forces the KIND, but
  // findConverter() still requires a real binary to exist (see resolveFfmpeg() in
  // lib/video-convert.ts) — it does NOT return the override as-is. A fake "ffmpeg"
  // script placed first on PATH stands in for the real binary; this only works because
  // vendoredFfmpegPath() (this install's own data/bin, checked BEFORE PATH) finds
  // nothing on a fresh clone. If this install ever gets a real data/bin/ffmpeg (e.g.
  // after Start-SocialScheduler-Windows.bat has run once), that vendored copy would be
  // found first and shadow the fake one here.
  const fakeFfmpegFailDir = makeFakeFfmpegScript();
  const convertFailStatus = runChild("convert-fail", {
    VIDEO_CONVERTER: "ffmpeg",
    FAKE_FFMPEG_MODE: "fail",
    PATH: `${fakeFfmpegFailDir}${path.delimiter}${process.env.PATH || ""}`,
  });
  fs.rmSync(fakeFfmpegFailDir, { recursive: true, force: true });
  if (convertFailStatus !== 0) process.exit(convertFailStatus);

  const fakeFfmpegBadOutputDir = makeFakeFfmpegScript();
  const badOutputFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-bad-output-fixture-"));
  const badOutputFixture = path.join(badOutputFixtureDir, "bad-output.mp4");
  fs.writeFileSync(
    badOutputFixture,
    file({ timescale: 600, duration: 6000, w: 2200, h: 3911, audio: true })
  );
  const badOutputStatus = runChild("bad-output", {
    VIDEO_CONVERTER: "ffmpeg",
    FAKE_FFMPEG_MODE: "bad-output",
    FAKE_FFMPEG_BAD_OUTPUT_SRC: badOutputFixture,
    PATH: `${fakeFfmpegBadOutputDir}${path.delimiter}${process.env.PATH || ""}`,
  });
  fs.rmSync(fakeFfmpegBadOutputDir, { recursive: true, force: true });
  fs.rmSync(badOutputFixtureDir, { recursive: true, force: true });
  process.exit(badOutputStatus);
}

/**
 * Writes a fake "ffmpeg" shell script to a fresh scratch directory and returns that
 * directory (to be prepended to the child's PATH). Behavior is chosen at run time via
 * FAKE_FFMPEG_MODE, read from the child's env:
 * - "fail": always exits 1 (simulates ConvertError — a real converter choking on this
 *   input).
 * - "bad-output": copies FAKE_FFMPEG_BAD_OUTPUT_SRC to whatever path was passed as the
 *   last CLI argument (buildArgs() in lib/video-convert.ts always puts the output path
 *   last for both converters), then exits 0 — simulates a "successful" conversion that
 *   still doesn't satisfy the Reels spec.
 */
function makeFakeFfmpegScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-fake-ffmpeg-"));
  const scriptPath = path.join(dir, "ffmpeg");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "# Fake ffmpeg for scripts/smoke-video-convert-upload.mjs — see makeFakeFfmpegScript()",
      "# in that file for what each FAKE_FFMPEG_MODE does and why this exists.",
      'case "$FAKE_FFMPEG_MODE" in',
      "  fail)",
      '    echo "fake ffmpeg: simulated failure for smoke test" 1>&2',
      "    exit 1",
      "    ;;",
      "  bad-output)",
      '    out=""',
      '    for a in "$@"; do out="$a"; done',
      '    cp "$FAKE_FFMPEG_BAD_OUTPUT_SRC" "$out"',
      "    exit 0",
      "    ;;",
      "  *)",
      '    echo "fake ffmpeg: FAKE_FFMPEG_MODE not set to fail|bad-output" 1>&2',
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n")
  );
  fs.chmodSync(scriptPath, 0o755);
  return dir;
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

/** Every scratch DB is fresh per child process, so on the convert-fail/bad-output
 *  children (a single upload attempt each) this is equivalent to "no row inserted at
 *  all" without needing to compute the upload's content hash. */
function countAllAssetRows(Database, dbFile) {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM assets").get().n;
  } finally {
    db.close();
  }
}

/** Recursive listing of the OS tmpdir entries this app's own conversion path creates
 *  (scripts/smoke-video-convert-upload.mjs's Minor-8 scenarios check this stays empty
 *  after a 422 — cleanupTemps() in the upload route must always run). Not recursive:
 *  ss-convert-* files are written flat into os.tmpdir(), never in a subdirectory. */
function listTmpConvertFiles() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((f) => f.startsWith("ss-convert-"))
    .sort();
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
    // Not "ffmpeg" — converterAdvice("win32") deliberately contains no such word (see
    // lib/converter-advice.ts), so that assertion fails on the one platform this whole
    // branch exists for. Assert the video-defect diagnostic instead: it comes from
    // classifyReelErrors() in lib/video-spec.ts, is unrelated to which hint the platform
    // gets, and IMG_3707.MOV — a real iPhone camera original — is expected to trip both.
    assert(
      body.error.includes("HEVC") || body.error.toLowerCase().includes("moov"),
      `expected the HEVC/moov diagnostic to still be present, got ${JSON.stringify(body.error)}`
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

  if (mode === "convert-fail") {
    // ---- Minor 8: conversion-failure path (ConvertError) --------------------------
    assert(
      config.videoConverter === "ffmpeg",
      `expected config.videoConverter === "ffmpeg" in the convert-fail child, got ${config.videoConverter}`
    );
    const tooWide = file({ timescale: 600, duration: 6000, w: 2200, h: 3911, audio: true });
    const beforeListing = listFiles(assetDir);
    const beforeTmp = listTmpConvertFiles();
    const res = await uploadRoute.POST(
      uploadReq(new File([tooWide], "toowide.mp4", { type: "video/mp4" }))
    );
    assert(res.status === 422, `expected 422 when the converter itself fails, got ${res.status}`);
    const body = await res.json();
    assert(
      body.error === "Converting this video failed — it may be corrupt or in an unsupported format.",
      `expected the sanitized conversion-failure message, got ${JSON.stringify(body.error)}`
    );
    assert(
      !body.error.includes("/") && !body.error.toLowerCase().includes("ffmpeg "),
      `expected no temp file paths or converter command line leaked into the error body, ` +
        `got ${JSON.stringify(body.error)}`
    );
    const afterListing = listFiles(assetDir);
    assert(
      JSON.stringify(beforeListing) === JSON.stringify(afterListing),
      `expected no files written to the asset store on a conversion failure; ` +
        `before=${JSON.stringify(beforeListing)} after=${JSON.stringify(afterListing)}`
    );
    assert(
      countAllAssetRows(Database, dbPath) === 0,
      "expected no assets row inserted on a conversion failure"
    );
    const afterTmp = listTmpConvertFiles();
    assert(
      JSON.stringify(beforeTmp) === JSON.stringify(afterTmp),
      `expected no leftover ss-convert-* temp files after a conversion failure; ` +
        `before=${JSON.stringify(beforeTmp)} after=${JSON.stringify(afterTmp)}`
    );
    console.log("PASS");
    return;
  }

  if (mode === "bad-output") {
    // ---- Minor 8: derivative-still-invalid path ------------------------------------
    assert(
      config.videoConverter === "ffmpeg",
      `expected config.videoConverter === "ffmpeg" in the bad-output child, got ${config.videoConverter}`
    );
    const tooWide = file({ timescale: 600, duration: 6000, w: 2400, h: 4267, audio: true });
    const beforeListing = listFiles(assetDir);
    const beforeTmp = listTmpConvertFiles();
    const res = await uploadRoute.POST(
      uploadReq(new File([tooWide], "toowide2.mp4", { type: "video/mp4" }))
    );
    assert(
      res.status === 422,
      `expected 422 when the "converted" derivative is still out of spec, got ${res.status}`
    );
    const body = await res.json();
    assert(
      typeof body.error === "string" &&
        body.error.includes("Conversion did not produce a usable video"),
      `expected the derivative-still-invalid message, got ${JSON.stringify(body.error)}`
    );
    assert(
      body.error.includes("1920"),
      `expected the derivative-still-invalid message to name the width cap, got ${JSON.stringify(body.error)}`
    );
    const afterListing = listFiles(assetDir);
    assert(
      JSON.stringify(beforeListing) === JSON.stringify(afterListing),
      `expected no files written to the asset store when the derivative is still invalid; ` +
        `before=${JSON.stringify(beforeListing)} after=${JSON.stringify(afterListing)}`
    );
    assert(
      countAllAssetRows(Database, dbPath) === 0,
      "expected no assets row inserted when the derivative is still invalid"
    );
    const afterTmp = listTmpConvertFiles();
    assert(
      JSON.stringify(beforeTmp) === JSON.stringify(afterTmp),
      `expected no leftover ss-convert-* temp files when the derivative is still invalid; ` +
        `before=${JSON.stringify(beforeTmp)} after=${JSON.stringify(afterTmp)}`
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
