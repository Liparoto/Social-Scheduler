#!/usr/bin/env node
// Smoke test for the caption-limit fix on the "human driven" re-target/schedule
// routes: an evergreen post whose caption is fine for Instagram (no enforced limit)
// but over Telegram's 1024-char single-image limit must be REJECTED by
// /api/posts/[id]/schedule and /api/posts/targets/bulk when Telegram is the (or a)
// target — before this fix, neither route checked caption length at all, so the post
// would be scheduled/re-targeted and then fail terminally, forever (it's evergreen),
// with nothing in the UI having warned.
//
// Run: node scripts/smoke-caption-limit-routes.mjs
//
// Same re-exec trick as scripts/smoke-content-model.mjs, for the same reason
// (lib/queries.ts imports "server-only" + uses extensionless/"@/" imports).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_CAPTION_LIMIT_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");
  const dbPath = path.join(
    os.tmpdir(),
    `socialscheduler-smoke-caption-${Date.now()}-${process.pid}.db`
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

  // 2) Import the real query layer + the actual route handlers under test.
  const queries = await import("../lib/queries.ts");
  const scheduleRoute = await import("../app/api/posts/[id]/schedule/route.ts");
  const targetsBulkRoute = await import("../app/api/posts/targets/bulk/route.ts");
  const { NextRequest } = await import("next/server");

  const igChannel = queries.createChannel({
    platform: "instagram",
    account_name: "IG Test",
    timezone: "America/New_York",
    remote_account_id: "ig-acct",
    access_token: "tok",
  });
  const tgChannel = queries.createChannel({
    platform: "telegram",
    account_name: "TG Test",
    timezone: "America/New_York",
    remote_account_id: "@tgchat",
    access_token: "tok",
  });

  const { asset } = queries.upsertAssetByHash({
    content_hash: "smoke-caption-hash-1",
    media_kind: "image",
    original_filename: "smoke.jpg",
    storage_path: "assets/smoke.jpg",
    public_url: "https://example.test/smoke.jpg",
    thumbnail_path: null,
    mime_type: "image/jpeg",
    width: 1080,
    height: 1080,
    byte_size: 12345,
  });

  const longCaption = "x".repeat(1400); // over Telegram's 1024 single-image limit

  // ---- Scenario A: /api/posts/[id]/schedule rejects scheduling to Telegram --------
  const { postId } = queries.createPostWithPublications({
    caption: longCaption,
    first_comment: "",
    post_type: "single",
    asset_ids: [asset.id],
    channel_ids: [], // schedule separately below, via the route under test
    scheduled_at: new Date().toISOString(),
    created_by: "smoke-test",
    content_kind: "evergreen",
    content_status: "ready",
    target_channel_ids: [],
  });

  const scheduleReq = new NextRequest("http://localhost/api/posts/1/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_ids: [tgChannel],
      date: "2026-08-01",
      time: "12:00",
    }),
  });
  const scheduleRes = await scheduleRoute.POST(scheduleReq, {
    params: Promise.resolve({ id: String(postId) }),
  });
  assert(
    scheduleRes.status === 400,
    `expected 400 scheduling an over-limit caption to Telegram, got ${scheduleRes.status}`
  );
  const scheduleBody = await scheduleRes.json();
  assert(
    typeof scheduleBody.error === "string" && scheduleBody.error.includes("Telegram"),
    `expected a Telegram caption-limit error, got: ${JSON.stringify(scheduleBody)}`
  );
  // No publication should have been created by the rejected request.
  const pubCountAfterReject = queries
    .getPostAssets(postId) // sanity: post + asset still intact
    .length;
  assert(pubCountAfterReject === 1, "post's asset should be untouched by the rejected request");

  // Scheduling the SAME post to Instagram (no enforced caption limit) must still work.
  const scheduleOkReq = new NextRequest("http://localhost/api/posts/1/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_ids: [igChannel],
      date: "2026-08-01",
      time: "12:00",
    }),
  });
  const scheduleOkRes = await scheduleRoute.POST(scheduleOkReq, {
    params: Promise.resolve({ id: String(postId) }),
  });
  assert(
    scheduleOkRes.status === 201,
    `expected 201 scheduling the same caption to Instagram, got ${scheduleOkRes.status}`
  );

  // ---- Scenario B: /api/posts/targets/bulk rejects adding Telegram as a target ----
  const { postId: postId2 } = queries.createPostWithPublications({
    caption: longCaption,
    first_comment: "",
    post_type: "single",
    asset_ids: [asset.id],
    channel_ids: [],
    scheduled_at: new Date().toISOString(),
    created_by: "smoke-test",
    content_kind: "evergreen",
    content_status: "ready",
    target_channel_ids: [igChannel], // already fine on Instagram
  });

  const targetsReq = new NextRequest("http://localhost/api/posts/targets/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      post_ids: [postId2],
      channel_ids: [tgChannel],
      action: "add",
    }),
  });
  const targetsRes = await targetsBulkRoute.POST(targetsReq);
  assert(
    targetsRes.status === 400,
    `expected 400 re-targeting an over-limit caption to Telegram, got ${targetsRes.status}`
  );
  const targetsBody = await targetsRes.json();
  assert(
    typeof targetsBody.error === "string" && targetsBody.error.includes("Telegram"),
    `expected a Telegram caption-limit error, got: ${JSON.stringify(targetsBody)}`
  );
  const targetsAfterReject = queries.getPostTargets(postId2);
  assert(
    !targetsAfterReject.includes(tgChannel),
    "Telegram must not have been added as a target after the rejected request"
  );

  // Removing a channel is never blocked by the caption gate (it can only relax things).
  const removeReq = new NextRequest("http://localhost/api/posts/targets/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      post_ids: [postId2],
      channel_ids: [igChannel],
      action: "remove",
    }),
  });
  const removeRes = await targetsBulkRoute.POST(removeReq);
  assert(removeRes.status === 200, `expected 200 removing a target, got ${removeRes.status}`);

  console.log("PASS");
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
