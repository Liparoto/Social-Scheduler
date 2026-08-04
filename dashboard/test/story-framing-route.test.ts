import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTestDb } from "./helpers.ts";

// Choosing a story framing renders a 9:16 canvas and records it. The behaviour that matters
// most here is that the choice is CHANGEABLE — the old feed control replaced its buttons with
// static text after one click, which is the bug this project exists to fix.

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { config } = await import("../lib/config.ts");
const { POST } = await import("../app/api/assets/[id]/story-framing/route.ts");

let seq = 0;

/** A real JPEG on disk, so the route has something to actually render. */
async function imageAsset(width: number, height: number): Promise<number> {
  const n = ++seq;
  const name = `sf${n}.jpg`;
  const abs = path.join(config.assetStorageDir, name);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(
    abs,
    await sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 90, b: 160 } },
    })
      .jpeg()
      .toBuffer()
  );
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) " +
          "VALUES (?, 'image', ?, ?, ?)"
      )
      .run(`sfhash${n}`, name, width, height).lastInsertRowid
  );
}

async function choose(assetId: number, body: unknown) {
  return POST(
    new NextRequest(`http://localhost:3939/api/assets/${assetId}/story-framing`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: String(assetId) }) }
  );
}

test("choosing blurred writes a 1080x1920 derivative and records the mode", async () => {
  const id = await imageAsset(1600, 1200);
  const res = await choose(id, { mode: "blurred" });
  assert.equal(res.status, 200);

  const asset = q.getAsset(id)!;
  assert.equal(asset.story_mode, "blurred");
  assert.ok(asset.story_path, "story_path must be set for a landscape source");
  const meta = await sharp(path.join(config.assetStorageDir, asset.story_path!)).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
});

test("the choice is changeable — that is the whole point", async () => {
  const id = await imageAsset(1600, 1200);
  await choose(id, { mode: "blurred" });
  await choose(id, { mode: "crop" });
  assert.equal(q.getAsset(id)!.story_mode, "crop");
  await choose(id, { mode: "blurred" });
  assert.equal(q.getAsset(id)!.story_mode, "blurred", "and changeable back again");
});

test("switching modes points story_path at the new render, not the old one", async () => {
  const id = await imageAsset(1600, 1200);
  await choose(id, { mode: "blurred" });
  const blurred = q.getAsset(id)!.story_path;
  await choose(id, { mode: "crop" });
  const cropped = q.getAsset(id)!.story_path;
  assert.notEqual(blurred, cropped, "a stale path would publish the wrong framing");
  assert.match(cropped!, /crop/);
});

test("an already-9:16 source gets NO canvas — the original is published untouched", async () => {
  // 1320x2346 is asset 173 from the first real Story: ratio 0.5627 vs 0.5625.
  const id = await imageAsset(1320, 2346);
  const res = await choose(id, { mode: "blurred" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).canvas, false);
  assert.equal(q.getAsset(id)!.story_path, null, "NULL means: publish the original");
});

test("an unknown mode is rejected rather than defaulted", async () => {
  const id = await imageAsset(1600, 1200);
  const res = await choose(id, { mode: "pad" });
  assert.equal(res.status, 400, "'pad' is a FEED mode, not a story mode");
  assert.equal(q.getAsset(id)!.story_path, null, "a rejected request writes nothing");
});

test("a missing mode is rejected", async () => {
  const id = await imageAsset(1600, 1200);
  assert.equal((await choose(id, {})).status, 400);
});

test("a video is refused — sharp cannot decode one", async () => {
  const id = Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'video', 'v.mp4')"
      )
      .run(`sfvid${++seq}`).lastInsertRowid
  );
  const res = await choose(id, { mode: "blurred" });
  assert.equal(res.status, 409);
});

test("an unknown asset is a 404, not a crash", async () => {
  assert.equal((await choose(999999, { mode: "blurred" })).status, 404);
});

// ---- countScheduledSendsForAsset --------------------------------------------------
test("scheduled sends are counted for both story and feed publications", async () => {
  const id = await imageAsset(1600, 1200);
  const ch = q.createChannel({
    platform: "instagram",
    account_name: `sf-ch${seq}`,
    timezone: "UTC",
  } as Parameters<typeof q.createChannel>[0]);
  const postId = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [id] });

  // A story send names its slide; a feed send has asset_id NULL and covers every asset on
  // the post. Counting only the first would under-report exactly the sends most likely
  // to exist.
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id) " +
      "VALUES (?,?,?,'scheduled','story',?)"
  ).run(postId, ch, "2026-09-01T00:00:00Z", id);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id) " +
      "VALUES (?,?,?,'scheduled','feed',NULL)"
  ).run(postId, ch, "2026-09-01T00:00:00Z");

  assert.equal(q.countScheduledSendsForAsset(id), 2);
});

test("already-posted sends are not counted — framing cannot change them", async () => {
  const id = await imageAsset(1600, 1200);
  const ch = q.createChannel({
    platform: "instagram",
    account_name: `sf-ch-posted${seq}`,
    timezone: "UTC",
  } as Parameters<typeof q.createChannel>[0]);
  const postId = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [id] });
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id) " +
      "VALUES (?,?,?,'posted','story',?)"
  ).run(postId, ch, "2026-09-01T00:00:00Z", id);

  assert.equal(q.countScheduledSendsForAsset(id), 0);
});
