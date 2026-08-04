import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { makeTestDb } from "./helpers.ts";

// Deleting an asset must leave NOTHING behind. Every derivative the app writes has to be
// cleaned up here — this is the one place that knows how to undo an upload, and it silently
// missed the story canvas when that fourth derivative was added.

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { config } = await import("../lib/config.ts");
const { DELETE } = await import("../app/api/assets/[id]/route.ts");

let seq = 0;

async function write(rel: string) {
  const abs = path.join(config.assetStorageDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(
    abs,
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer()
  );
  return abs;
}

async function exists(abs: string) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** An asset with every derivative the app can produce, all present on disk. */
async function fullyDerivedAsset() {
  const n = ++seq;
  const hash = `delhash${n}`;
  const paths = {
    storage: `${hash}.jpg`,
    publish: `pub/${hash}.jpg`,
    thumb: `thumb/${hash}.jpg`,
    storyBlurred: `story/${hash}-blurred.jpg`,
    storyCrop: `story/${hash}-crop.jpg`,
  };
  const abs: Record<string, string> = {};
  for (const [k, rel] of Object.entries(paths)) abs[k] = await write(rel);

  const id = Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, publish_path, " +
          "thumbnail_path, story_path, story_mode, width, height) " +
          "VALUES (?, 'image', ?, ?, ?, ?, 'crop', 1600, 1200)"
      )
      .run(hash, paths.storage, paths.publish, paths.thumb, paths.storyCrop)
      .lastInsertRowid
  );
  return { id, abs };
}

async function del(id: number) {
  return DELETE(new NextRequest(`http://localhost:3939/api/assets/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  });
}

test("deleting an asset removes the original, the feed derivative and the thumbnail", async () => {
  const { id, abs } = await fullyDerivedAsset();
  assert.equal((await del(id)).status, 200);

  assert.equal(await exists(abs.storage), false, "original must go");
  assert.equal(await exists(abs.publish), false, "feed derivative must go");
  assert.equal(await exists(abs.thumb), false, "thumbnail must go");
});

test("deleting an asset removes BOTH cached story canvases, not just the chosen one", async () => {
  // story_path records only the mode in use, but the media route caches both so switching
  // is instant. Cleaning up only story_path would strand the other mode's render forever.
  const { id, abs } = await fullyDerivedAsset();
  assert.equal((await del(id)).status, 200);

  assert.equal(await exists(abs.storyCrop), false, "the chosen canvas must go");
  assert.equal(await exists(abs.storyBlurred), false, "the other cached mode must go too");
});

test("an asset that was never story-framed deletes cleanly anyway", async () => {
  const n = ++seq;
  const hash = `plain${n}`;
  const storage = await write(`${hash}.jpg`);
  const id = Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)"
      )
      .run(hash, `${hash}.jpg`).lastInsertRowid
  );

  const res = await del(id);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).leftover, [], "a missing canvas is not 'leftover'");
  assert.equal(await exists(storage), false);
});

test("an asset still referenced by a post is refused, and its files survive", async () => {
  const { id, abs } = await fullyDerivedAsset();
  q.createDraftPost({ caption: "", first_comment: "", asset_ids: [id] });

  assert.equal((await del(id)).status, 409);
  assert.equal(await exists(abs.storage), true, "a refused delete must touch nothing");
  assert.equal(await exists(abs.storyCrop), true);
  assert.equal(await exists(abs.storyBlurred), true);
});
