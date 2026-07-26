#!/usr/bin/env node
// Smoke test for "Post now" support in POST /api/posts/{id}/schedule.
//
// This is the sibling of scripts/smoke-post-now.mjs, but for the route that schedules
// an EXISTING (already-created, e.g. library) post rather than creating a new one.
// Same semantics: post_now means scheduled_at = now and status forced to 'scheduled',
// bypassing requires_approval, even when a date/time is also supplied. The normal
// date+time path (no post_now) must be completely unchanged, including still landing
// pending_approval when required.
//
// Run: node scripts/smoke-post-now-schedule.mjs
//
// Same re-exec trick as scripts/smoke-post-now.mjs, for the same reason
// (lib/queries.ts imports "server-only" + uses extensionless/"@/" imports).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REEXEC_FLAG = "__SMOKE_POST_NOW_SCHEDULE_CHILD__";

if (!process.env[REEXEC_FLAG]) {
  const self = fileURLToPath(import.meta.url);
  const loader = path.join(path.dirname(self), "ts-resolve-loader.mjs");
  const dbPath = path.join(
    os.tmpdir(),
    `socialscheduler-smoke-post-now-schedule-${Date.now()}-${process.pid}.db`
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
  const scheduleRoute = await import("../app/api/posts/[id]/schedule/route.ts");
  const { NextRequest } = await import("next/server");

  const approvalChannel = queries.createChannel({
    platform: "instagram",
    account_name: "IG Approval-Required",
    timezone: "America/New_York",
    remote_account_id: "ig-acct-approval",
    access_token: "tok",
    requires_approval: true,
  });
  const noApprovalChannel = queries.createChannel({
    platform: "instagram",
    account_name: "IG No-Approval",
    timezone: "America/New_York",
    remote_account_id: "ig-acct-no-approval",
    access_token: "tok",
    requires_approval: false,
  });
  // Instagram has no enforced caption limit (captionChars: {}); Telegram does
  // (1024 for a single image), so the over-limit-caption validation check below
  // needs a channel that can actually be over its limit.
  const telegramChannel = queries.createChannel({
    platform: "telegram",
    account_name: "TG No-Approval",
    timezone: "America/New_York",
    remote_account_id: "@tg-smoke",
    access_token: "tok",
    requires_approval: false,
  });

  const { asset } = queries.upsertAssetByHash({
    content_hash: "smoke-post-now-schedule-hash-1",
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

  function makeDraftPost(assetIds = [asset.id], captionOverride) {
    return queries.createDraftPost({
      caption: captionOverride ?? "smoke caption",
      first_comment: "",
      asset_ids: assetIds,
      created_by: "smoke-test",
    });
  }

  function scheduleReq(postId, body) {
    return scheduleRoute.POST(
      new NextRequest(`http://localhost/api/posts/${postId}/schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: String(postId) }) }
    );
  }

  // ---- Scenario 1: post_now, no date/time, approval-required channel -> scheduled ---
  const post1 = makeDraftPost();
  const beforeNow1 = Date.now();
  const res1 = await scheduleReq(post1, {
    channel_ids: [approvalChannel],
    post_now: true,
  });
  assert(res1.status === 201, `expected 201 for post_now on approval channel, got ${res1.status}`);
  const pub1 = queries.getPostPublications(post1).find((p) => p.channel_id === approvalChannel);
  assert(pub1, "expected a publication for the approval channel");
  assert(
    pub1.status === "scheduled",
    `expected status 'scheduled' (not pending_approval) for post_now, got '${pub1.status}'`
  );
  const scheduledAtMs1 = new Date(pub1.scheduled_at).getTime();
  assert(
    scheduledAtMs1 >= beforeNow1 && scheduledAtMs1 <= Date.now() + 5000,
    `expected scheduled_at to be ~now, got ${pub1.scheduled_at}`
  );

  // ---- Scenario 2: post_now, no-approval channel -> also scheduled (unchanged) -----
  const post2 = makeDraftPost();
  const res2 = await scheduleReq(post2, {
    channel_ids: [noApprovalChannel],
    post_now: true,
  });
  assert(res2.status === 201, `expected 201 for post_now on no-approval channel, got ${res2.status}`);
  const pub2 = queries.getPostPublications(post2).find((p) => p.channel_id === noApprovalChannel);
  assert(pub2.status === "scheduled", `expected 'scheduled', got '${pub2.status}'`);

  // ---- Scenario 3: REGRESSION GUARD — normal scheduled request is unchanged --------
  const post3 = makeDraftPost();
  const res3 = await scheduleReq(post3, {
    channel_ids: [approvalChannel],
    date: "2026-08-01",
    time: "12:00",
  });
  assert(res3.status === 201, `expected 201 for a normal scheduled request, got ${res3.status}`);
  const pub3 = queries.getPostPublications(post3).find((p) => p.channel_id === approvalChannel);
  assert(
    pub3.status === "pending_approval",
    `regression: normal scheduling to an approval-required channel must still land ` +
      `pending_approval, got '${pub3.status}'`
  );
  assert(
    pub3.scheduled_at !== pub1.scheduled_at,
    "sanity: the normal-scheduled publication should carry the requested date/time, not 'now'"
  );

  // ---- Scenario 4: post_now AND a date/time supplied -> post_now wins, date ignored
  const post4 = makeDraftPost();
  const beforeNow4 = Date.now();
  const res4 = await scheduleReq(post4, {
    channel_ids: [approvalChannel],
    post_now: true,
    date: "2026-08-01",
    time: "12:00",
  });
  assert(res4.status === 201, `expected 201 for post_now + date/time, got ${res4.status}`);
  const pub4 = queries.getPostPublications(post4).find((p) => p.channel_id === approvalChannel);
  assert(
    pub4.status === "scheduled",
    `expected post_now to still force 'scheduled' when a date/time is also present, got '${pub4.status}'`
  );
  const scheduledAtMs4 = new Date(pub4.scheduled_at).getTime();
  assert(
    scheduledAtMs4 >= beforeNow4 && scheduledAtMs4 <= Date.now() + 5000,
    `expected post_now to win over the supplied date/time (scheduled_at should be ~now), got ${pub4.scheduled_at}`
  );

  // ---- Scenario 5: existing validation still applies to post_now requests ---------
  const post5 = makeDraftPost();
  const noChannels = await scheduleReq(post5, { channel_ids: [], post_now: true });
  assert(noChannels.status === 400, `expected 400 for no channels selected, got ${noChannels.status}`);

  const unknownChannel = await scheduleReq(post5, {
    channel_ids: [999999],
    post_now: true,
  });
  assert(unknownChannel.status === 400, `expected 400 for unknown channel, got ${unknownChannel.status}`);

  // Instagram: supportsText === false, and this draft post is an image post, so target a
  // text-only channel incompatibility instead — reuse the platform-incompatibility path via
  // an oversized carousel below, and cover unsupported-type via a text post here.
  const textPost = queries.createDraftPost({
    caption: "hello",
    first_comment: "",
    post_type: "text",
    asset_ids: [],
    created_by: "smoke-test",
  });
  const unsupportedTypeForTarget = await scheduleReq(textPost, {
    channel_ids: [noApprovalChannel], // Instagram: supportsText === false
    post_now: true,
  });
  assert(
    unsupportedTypeForTarget.status === 400,
    `expected 400 for a text post targeting a channel that doesn't support text, got ${unsupportedTypeForTarget.status}`
  );

  const longCaption = "x".repeat(1400); // over Telegram's 1024 single-image limit
  const overCaptionPost = makeDraftPost([asset.id], longCaption);
  const overLimitCaption = await scheduleReq(overCaptionPost, {
    channel_ids: [telegramChannel],
    post_now: true,
  });
  assert(
    overLimitCaption.status === 400,
    `expected 400 for an over-limit caption, got ${overLimitCaption.status}`
  );

  // ---- Scenario 6: carousel over the platform limit still rejected under post_now --
  // noApprovalChannel is instagram, whose maxCarousel is 10 (dashboard/lib/platforms.ts).
  // Unlike the create-post route (which validates before ever writing post_assets), this
  // route's carousel is a pre-existing library post, so post_assets needs 11 DISTINCT
  // asset ids up front (a UNIQUE(post_id, asset_id) constraint rejects duplicates).
  const carouselAssetIds = [];
  for (let i = 0; i < 11; i++) {
    const { asset: a } = queries.upsertAssetByHash({
      content_hash: `smoke-post-now-schedule-carousel-${i}`,
      media_kind: "image",
      original_filename: `smoke-${i}.jpg`,
      storage_path: `assets/smoke-${i}.jpg`,
      public_url: `https://example.test/smoke-${i}.jpg`,
      thumbnail_path: null,
      mime_type: "image/jpeg",
      width: 1080,
      height: 1080,
      byte_size: 12345,
    });
    carouselAssetIds.push(a.id);
  }
  const carouselPost = makeDraftPost(carouselAssetIds);
  const overSizeCarousel = await scheduleReq(carouselPost, {
    channel_ids: [noApprovalChannel],
    post_now: true,
  });
  assert(
    overSizeCarousel.status === 400,
    `expected 400 for an over-limit carousel, got ${overSizeCarousel.status}`
  );

  console.log("PASS");
}

main().catch((err) => {
  fail(err?.stack || String(err));
});
