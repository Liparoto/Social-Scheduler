/**
 * Previewing a FEED framing mode without committing it.
 *
 * The framing dialog used to POST the moment a button was clicked, so merely looking at
 * what Pad did rewrote the derivative that was scheduled to publish — the owner reframed
 * three assets by exploring. `?variant=publish&mode=` exists so the dialog can show both
 * options before Save, and the property that makes it safe is the one tested hardest here:
 * a preview must never touch the committed `pub/<hash>.jpg` or the asset row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const db = (await import("../lib/db.ts")).getDb();
const { config } = await import("../lib/config.ts");
const { GET } = await import("../app/api/media/[id]/route.ts");

let seq = 0;

/** A real JPEG on disk plus its asset row. Geometry is what's under test, not content. */
async function makeImageAsset(width: number, height: number) {
  const n = ++seq;
  const hash = `feedpreview${n}`;
  const original = `orig-feed${n}.jpg`;
  const publish = `pub/${hash}.jpg`;

  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 140, b: 90 } },
  })
    .jpeg()
    .toBuffer();

  await fs.mkdir(path.join(config.assetStorageDir, "pub"), { recursive: true });
  await fs.writeFile(path.join(config.assetStorageDir, original), bytes);
  // Deliberately NOT the conformed bytes: a distinct marker proves which file came back.
  await fs.writeFile(path.join(config.assetStorageDir, publish), "COMMITTED-DERIVATIVE");

  const id = Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, publish_path, " +
          "width, height, conform_mode) VALUES (?, 'image', ?, ?, ?, ?, 'crop')"
      )
      .run(hash, original, publish, width, height).lastInsertRowid
  );
  return { id, hash, publishAbs: path.join(config.assetStorageDir, publish) };
}

function get(id: number, query = ""): Promise<Response> {
  return GET(new NextRequest(`http://localhost:3939/api/media/${id}${query}`), {
    params: Promise.resolve({ id: String(id) }),
  }) as unknown as Promise<Response>;
}

test("previewing a mode never overwrites the committed derivative or the asset row", async () => {
  // 1000x2000 (0.5) is outside 4:5-1.91:1, so both modes genuinely render something.
  const { id, publishAbs } = await makeImageAsset(1000, 2000);

  const res = await get(id, "?variant=publish&mode=pad");
  assert.equal(res.status, 200);

  // The file the worker publishes is untouched...
  assert.equal(await fs.readFile(publishAbs, "utf8"), "COMMITTED-DERIVATIVE");
  // ...and so is the choice recorded against the asset.
  const row = db.prepare("SELECT conform_mode FROM assets WHERE id = ?").get(id) as {
    conform_mode: string;
  };
  assert.equal(row.conform_mode, "crop");
});

test("crop and pad previews are different images", async () => {
  // The whole point of the dialog. If these came back identical it would be the 40x40
  // object-cover bug again, just at a different layer.
  const { id } = await makeImageAsset(1000, 2000);

  const crop = Buffer.from(await (await get(id, "?variant=publish&mode=crop")).arrayBuffer());
  const pad = Buffer.from(await (await get(id, "?variant=publish&mode=pad")).arrayBuffer());

  assert.ok(crop.length > 0 && pad.length > 0);
  assert.notEqual(crop.equals(pad), true, "crop and pad previews should differ");

  // Both land inside the feed's range, since that is what conforming means.
  for (const [label, buf] of [["crop", crop], ["pad", pad]] as const) {
    const meta = await sharp(buf).metadata();
    const ratio = (meta.width ?? 0) / (meta.height ?? 1);
    assert.ok(ratio >= 0.8 - 1e-6 && ratio <= 1.91 + 1e-6, `${label} ratio ${ratio}`);
  }
});

test("an in-range source serves the committed derivative rather than rendering a copy", async () => {
  // conformImage() resolves "none" here, so crop and pad would be byte-identical. Rendering
  // two more copies of an image nothing reshapes is pure waste.
  const { id } = await makeImageAsset(1200, 1200);

  assert.equal(
    await (await get(id, "?variant=publish&mode=pad")).text(),
    "COMMITTED-DERIVATIVE"
  );
});

test("without a mode, ?variant=publish is unchanged", async () => {
  // The preview branch is additive: every existing caller must keep its old behaviour.
  const { id } = await makeImageAsset(1000, 2000);

  assert.equal(await (await get(id, "?variant=publish")).text(), "COMMITTED-DERIVATIVE");
});
