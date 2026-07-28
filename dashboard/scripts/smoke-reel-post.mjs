#!/usr/bin/env node
// Smoke test for Task 9 (Composer — create a Reel): POST /api/posts deriving post_type
// from the asset's media_kind, not just asset count.
//
// Covers: a single video asset -> post_type 'reel'; a video + an image together -> 400
// (no platform publishes a mixed carousel); a reel targeted at a Threads channel -> 400
// (platforms.ts's incompatibleChannelsForPost now gates 'reel' on supportsVideo, the
// same way it already gated 'text' on supportsText); two images -> 'carousel'
// (regression); and an unknown asset id -> 400 (the new validation Task 9 added — see
// dashboard/app/api/posts/route.ts's asset lookup, mirroring the pre-existing channel
// lookup directly above it).
//
// Run: node scripts/smoke-reel-post.mjs
//
// Same re-exec trick as scripts/smoke-post-now.mjs, for the same reason
// (lib/queries.ts imports "server-only" + uses extensionless/"@/" imports).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_REEL_POST_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");
  const dbPath = path.join(
    os.tmpdir(),
    `socialscheduler-smoke-reel-post-${Date.now()}-${process.pid}.db`
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
  const postsRoute = await import("../app/api/posts/route.ts");
  const { NextRequest } = await import("next/server");

  const igChannel = queries.createChannel({
    platform: "instagram",
    account_name: "IG Reel Smoke",
    timezone: "America/New_York",
    remote_account_id: "ig-acct-reel-smoke",
    access_token: "tok",
    requires_approval: false,
  });
  const threadsChannel = queries.createChannel({
    platform: "threads",
    account_name: "TH Reel Smoke",
    timezone: "America/New_York",
    remote_account_id: "@th-reel-smoke",
    access_token: "tok",
    requires_approval: false,
  });

  const { asset: videoAsset } = queries.upsertAssetByHash({
    content_hash: "smoke-reel-post-video-1",
    media_kind: "video",
    original_filename: "reel.mp4",
    storage_path: "assets/reel.mp4",
    public_url: null,
    thumbnail_path: null,
    mime_type: "video/mp4",
    width: 1080,
    height: 1920,
    byte_size: 5_000_000,
    publish_path: null,
    duration_ms: 10_000,
    has_audio: 1,
  });
  const { asset: imageAsset1 } = queries.upsertAssetByHash({
    content_hash: "smoke-reel-post-image-1",
    media_kind: "image",
    original_filename: "one.jpg",
    storage_path: "assets/one.jpg",
    public_url: "https://example.test/one.jpg",
    thumbnail_path: null,
    mime_type: "image/jpeg",
    width: 1080,
    height: 1080,
    byte_size: 12345,
  });
  const { asset: imageAsset2 } = queries.upsertAssetByHash({
    content_hash: "smoke-reel-post-image-2",
    media_kind: "image",
    original_filename: "two.jpg",
    storage_path: "assets/two.jpg",
    public_url: "https://example.test/two.jpg",
    thumbnail_path: null,
    mime_type: "image/jpeg",
    width: 1080,
    height: 1080,
    byte_size: 12345,
  });

  function postReq(body) {
    return new NextRequest("http://localhost/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ---- Scenario 1: a single video asset -> post_type 'reel' -----------------------
  const res1 = await postsRoute.POST(
    postReq({
      asset_ids: [videoAsset.id],
      channel_ids: [igChannel],
      scheduled_local: "2026-08-01T12:00",
      timezone: "America/New_York",
      created_by: "smoke-test",
    })
  );
  assert(res1.status === 201, `expected 201 for a single-video post, got ${res1.status}`);
  const body1 = await res1.json();
  const post1 = queries.getPost(body1.postId);
  assert(post1.post_type === "reel", `expected post_type 'reel', got '${post1.post_type}'`);

  // ---- Scenario 2: a video + an image together -> 400 (no mixed carousel) ---------
  const res2 = await postsRoute.POST(
    postReq({
      asset_ids: [videoAsset.id, imageAsset1.id],
      channel_ids: [igChannel],
      scheduled_local: "2026-08-01T12:00",
      timezone: "America/New_York",
      created_by: "smoke-test",
    })
  );
  assert(
    res2.status === 400,
    `expected 400 for a video mixed with an image, got ${res2.status}`
  );

  // ---- Scenario 3: a reel targeted at a Threads channel -> 400 --------------------
  // Threads' supportsVideo is false (dashboard/lib/platforms.ts) — the existing
  // platform-compatibility validation (incompatiblePostError) now gates 'reel' the
  // same way it already gated 'text'.
  const res3 = await postsRoute.POST(
    postReq({
      asset_ids: [videoAsset.id],
      channel_ids: [threadsChannel],
      scheduled_local: "2026-08-01T12:00",
      timezone: "America/New_York",
      created_by: "smoke-test",
    })
  );
  assert(
    res3.status === 400,
    `expected 400 for a reel targeted at a Threads channel, got ${res3.status}`
  );

  // ---- Scenario 4: two images -> 'carousel' (regression) ---------------------------
  const res4 = await postsRoute.POST(
    postReq({
      asset_ids: [imageAsset1.id, imageAsset2.id],
      channel_ids: [igChannel],
      scheduled_local: "2026-08-01T12:00",
      timezone: "America/New_York",
      created_by: "smoke-test",
    })
  );
  assert(res4.status === 201, `expected 201 for a two-image post, got ${res4.status}`);
  const body4 = await res4.json();
  const post4 = queries.getPost(body4.postId);
  assert(
    post4.post_type === "carousel",
    `regression: expected post_type 'carousel' for two images, got '${post4.post_type}'`
  );

  // ---- Scenario 5: an unknown asset id -> 400 --------------------------------------
  // New behaviour Task 9 added: previously an unknown asset id produced a post with a
  // dangling post_assets row, silently. Confirmed above (smoke-post-now.mjs) that no
  // existing smoke script relies on that old silent tolerance.
  const bogusAssetId = Math.max(videoAsset.id, imageAsset1.id, imageAsset2.id) + 1000;
  const res5 = await postsRoute.POST(
    postReq({
      asset_ids: [bogusAssetId],
      channel_ids: [igChannel],
      scheduled_local: "2026-08-01T12:00",
      timezone: "America/New_York",
      created_by: "smoke-test",
    })
  );
  assert(res5.status === 400, `expected 400 for an unknown asset id, got ${res5.status}`);
  const body5 = await res5.json();
  assert(
    typeof body5.error === "string" && body5.error.includes(String(bogusAssetId)),
    `expected the error to name the unknown asset id, got ${JSON.stringify(body5.error)}`
  );

  console.log("PASS");
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
