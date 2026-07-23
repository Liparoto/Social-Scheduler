#!/usr/bin/env node
// Smoke test for Slice B1 (content-model data layer): periods CRUD, post targets,
// post periods (green/blackout), caption variants, and content_kind/content_status
// updates — exercised end-to-end against a throwaway SQLite file.
//
// Run: node scripts/smoke-content-model.mjs
//
// Why the re-exec below: lib/db.ts and lib/queries.ts import "server-only" (a marker
// package that throws unless resolved under the "react-server" export condition) and
// use Next-style extensionless relative imports (e.g. "./db"). Plain `node file.mjs`
// supports neither by default, so this script re-execs itself once with the flags that
// make both work, keeping the *usage* exactly `node scripts/smoke-content-model.mjs`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_CONTENT_MODEL_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");
  const dbPath = path.join(
    os.tmpdir(),
    `socialscheduler-smoke-${Date.now()}-${process.pid}.db`
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

  // Clean up the temp DB (+ WAL/SHM sidecar files) regardless of pass/fail.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* best-effort cleanup */
    }
  }

  process.exit(result.status ?? 1);
}

// ---- child process: DATABASE_PATH is already set in the environment above, BEFORE
// any module that touches lib/db.ts gets imported. ---------------------------------

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

  // 1) Apply migrations 0001 + 0002 directly against the temp DB file.
  const { default: Database } = await import("better-sqlite3");
  const migrationDb = new Database(dbPath);
  migrationDb.pragma("foreign_keys = ON");
  for (const file of ["0001_init.sql", "0002_content_model.sql"]) {
    const sql = fs.readFileSync(path.join(repoRoot, "migrations", file), "utf8");
    migrationDb.exec(sql);
  }
  migrationDb.close();

  // 2) NOW import the real dashboard query layer — its own getDb() will open a fresh
  // connection against the same (already-migrated) file.
  const queries = await import("../lib/queries.ts");

  // ---- Periods -----------------------------------------------------------------
  const summerId = queries.createPeriod({
    name: "Summer Sale",
    recurs_yearly: true,
    start_month: 6,
    start_day: 1,
    end_month: 8,
    end_day: 31,
  });
  assert(Number.isInteger(summerId), "createPeriod did not return a numeric id");

  const winterId = queries.createPeriod({
    name: "Holiday Blackout",
    recurs_yearly: false,
    start_date: "2026-12-20",
    end_date: "2027-01-02",
  });

  let periods = queries.listPeriods();
  assert(periods.length === 2, `expected 2 periods, got ${periods.length}`);

  const fetchedSummer = queries.getPeriod(summerId);
  assert(fetchedSummer?.name === "Summer Sale", "getPeriod returned wrong period");
  assert(fetchedSummer.recurs_yearly === 1, "recurs_yearly should be 1 for yearly period");
  assert(fetchedSummer.start_month === 6 && fetchedSummer.end_month === 8, "month range mismatch");

  queries.updatePeriod(summerId, { name: "Summer Sale (updated)", end_month: 9 });
  const updatedSummer = queries.getPeriod(summerId);
  assert(updatedSummer.name === "Summer Sale (updated)", "updatePeriod did not update name");
  assert(updatedSummer.end_month === 9, "updatePeriod did not update end_month");

  // ---- Channels (needed for targeting) ------------------------------------------
  const channelAId = queries.createChannel({
    platform: "instagram",
    account_name: "Personal IG",
    timezone: "America/New_York",
  });
  const channelBId = queries.createChannel({
    platform: "facebook",
    account_name: "Advantage PT",
    timezone: "America/New_York",
  });

  // ---- Assets (needed to create a post) -----------------------------------------
  const { asset } = queries.upsertAssetByHash({
    content_hash: "smoke-hash-1",
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

  // ---- Create a post with targets + a green period + 2 caption variants ---------
  const { postId } = queries.createPostWithPublications({
    caption: "Fallback caption",
    first_comment: "",
    post_type: "single",
    asset_ids: [asset.id],
    channel_ids: [channelAId],
    scheduled_at: new Date().toISOString(),
    created_by: "smoke-test",
    content_kind: "evergreen",
    content_status: "draft",
    cooldown_days: 14,
    target_channel_ids: [channelAId, channelBId],
    period_links: [{ periodId: summerId, mode: "green" }],
    caption_variants: [
      { platform: null, body: "Generic variant one", sort_order: 0 },
      { platform: "instagram", body: "Instagram-specific variant", sort_order: 1 },
    ],
  });
  assert(Number.isInteger(postId), "createPostWithPublications did not return a postId");

  // ---- Read everything back and assert ------------------------------------------
  const targets = queries.getPostTargets(postId);
  assert(
    targets.length === 2 && targets.includes(channelAId) && targets.includes(channelBId),
    `expected targets [${channelAId}, ${channelBId}], got [${targets.join(",")}]`
  );

  const postPeriods = queries.getPostPeriods(postId);
  assert(postPeriods.length === 1, `expected 1 period link, got ${postPeriods.length}`);
  assert(postPeriods[0].period_id === summerId, "period link points to the wrong period");
  assert(postPeriods[0].mode === "green", "period link mode should be green");

  const variants = queries.getCaptionVariants(postId);
  assert(variants.length === 2, `expected 2 caption variants, got ${variants.length}`);
  assert(variants[0].platform === null, "first variant should be generic (platform NULL)");
  assert(variants[1].platform === "instagram", "second variant should be instagram-specific");

  const createdPost = queries.getPost(postId);
  assert(createdPost.content_kind === "evergreen", "content_kind not persisted");
  assert(createdPost.content_status === "draft", "content_status not persisted");
  assert(createdPost.cooldown_days === 14, "cooldown_days not persisted");

  // ---- setPostTargets / setPostPeriods / setCaptionVariants replace, not append --
  queries.setPostTargets(postId, [channelBId]);
  assert(
    JSON.stringify(queries.getPostTargets(postId)) === JSON.stringify([channelBId]),
    "setPostTargets did not replace the target set"
  );

  queries.setPostPeriods(postId, [
    { periodId: summerId, mode: "green" },
    { periodId: winterId, mode: "blackout" },
  ]);
  const replacedPeriods = queries.getPostPeriods(postId);
  assert(replacedPeriods.length === 2, "setPostPeriods did not replace correctly");
  assert(
    replacedPeriods.some((p) => p.period_id === winterId && p.mode === "blackout"),
    "blackout link missing after setPostPeriods"
  );

  queries.setCaptionVariants(postId, [{ platform: null, body: "Replaced caption", sort_order: 0 }]);
  const replacedVariants = queries.getCaptionVariants(postId);
  assert(replacedVariants.length === 1, "setCaptionVariants did not replace correctly");
  assert(replacedVariants[0].body === "Replaced caption", "caption body not replaced");

  // ---- updatePostContentModel + assert --------------------------------------------
  queries.updatePostContentModel(postId, { content_status: "ready" });
  const readyPost = queries.getPost(postId);
  assert(readyPost.content_status === "ready", "content_status was not updated to ready");
  assert(readyPost.content_kind === "evergreen", "unrelated field content_kind should be untouched");

  queries.updatePostContentModel(postId, { content_kind: "one_time", cooldown_days: null });
  const finalPost = queries.getPost(postId);
  assert(finalPost.content_kind === "one_time", "content_kind was not updated to one_time");
  assert(finalPost.cooldown_days === null, "cooldown_days was not cleared to null");

  // ---- listPosts includes the new content-model + season/target summary columns --
  const libraryRows = queries.listPosts();
  const row = libraryRows.find((r) => r.id === postId);
  assert(row, "listPosts did not include the created post");
  assert(row.content_kind === "one_time", "listPosts row missing updated content_kind");
  assert(row.content_status === "ready", "listPosts row missing updated content_status");
  assert(row.target_count === 1, `expected target_count 1, got ${row.target_count}`);
  assert(row.green_period_count === 1, `expected green_period_count 1, got ${row.green_period_count}`);
  assert(
    row.blackout_period_count === 1,
    `expected blackout_period_count 1, got ${row.blackout_period_count}`
  );

  // ---- deletePeriod ----------------------------------------------------------------
  const deleted = queries.deletePeriod(winterId);
  assert(deleted === true, "deletePeriod should return true for an existing period");
  assert(queries.getPeriod(winterId) === undefined, "period should be gone after delete");
  // ON DELETE CASCADE should have removed the post_periods row referencing it.
  const periodsAfterDelete = queries.getPostPeriods(postId);
  assert(
    !periodsAfterDelete.some((p) => p.period_id === winterId),
    "post_periods row for deleted period should be gone (CASCADE)"
  );

  console.log("PASS");
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
