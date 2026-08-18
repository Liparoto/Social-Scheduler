/**
 * Downloading an asset to the viewer's computer.
 *
 * Two behaviours matter here and neither is visible in the browser until it is wrong:
 *
 * 1. `?download=1` must set Content-Disposition. Without it the browser renders the file
 *    in a tab instead of saving it, and every "download" button in the UI silently becomes
 *    a "view" button.
 * 2. It must serve the ORIGINAL. The preview path substitutes a thumbnail, a story canvas,
 *    or (for video) the H.264 derivative — so the obvious implementation, hanging the
 *    header off the existing variant logic, would hand the owner a 320px thumbnail when
 *    they asked for their photo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const db = (await import("../lib/db.ts")).getDb();
const { config } = await import("../lib/config.ts");
const { GET } = await import("../app/api/media/[id]/route.ts");

let seq = 0;

/** An asset with real bytes on disk for each of its variants. */
async function makeAsset(opts: {
  mediaKind?: "image" | "video";
  originalFilename?: string | null;
  withThumb?: boolean;
  publishPath?: string | null;
}): Promise<number> {
  const n = ++seq;
  const original = `orig${n}.jpg`;
  const thumb = `thumb${n}.jpg`;
  const publish = `publish${n}.jpg`;

  await fs.mkdir(config.assetStorageDir, { recursive: true });
  // Distinct contents so a test can tell WHICH file came back, not merely that one did.
  await fs.writeFile(path.join(config.assetStorageDir, original), `ORIGINAL-${n}`);
  await fs.writeFile(path.join(config.assetStorageDir, thumb), `THUMB-${n}`);
  await fs.writeFile(path.join(config.assetStorageDir, publish), `PUBLISH-${n}`);

  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, original_filename, storage_path, " +
          "thumbnail_path, publish_path) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        `dlhash${n}`,
        opts.mediaKind ?? "image",
        opts.originalFilename === undefined ? `beach day ${n}.jpg` : opts.originalFilename,
        original,
        opts.withThumb === false ? null : thumb,
        opts.publishPath === undefined ? publish : opts.publishPath
      ).lastInsertRowid
  );
}

function get(id: number, query = ""): Promise<Response> {
  return GET(new NextRequest(`http://localhost:3939/api/media/${id}${query}`), {
    params: Promise.resolve({ id: String(id) }),
  }) as unknown as Promise<Response>;
}

test("?download=1 marks the response as an attachment with the uploaded name", async () => {
  const id = await makeAsset({ originalFilename: "beach-day.jpg" });
  const res = await get(id, "?download=1");

  assert.equal(res.status, 200);
  const cd = res.headers.get("content-disposition");
  assert.ok(cd, "expected a Content-Disposition header");
  assert.match(cd, /^attachment;/);
  assert.match(cd, /filename="beach-day\.jpg"/);
});

test("without the flag there is no Content-Disposition — previews must still render inline", async () => {
  const id = await makeAsset({});
  const res = await get(id);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-disposition"), null);
});

test("a download serves the original, not the thumbnail", async () => {
  const id = await makeAsset({});

  // Confirm the thumb variant really is a different file, so the assertion below has teeth.
  assert.equal(await (await get(id, "?variant=thumb")).text(), `THUMB-${seq}`);
  assert.equal(await (await get(id, "?download=1&variant=thumb")).text(), `ORIGINAL-${seq}`);
});

test("a video download serves the original, not the playable derivative", async () => {
  // The preview deliberately returns publish_path for video because Chrome cannot decode
  // iPhone HEVC. A download must not inherit that substitution.
  const id = await makeAsset({ mediaKind: "video" });

  assert.equal(await (await get(id)).text(), `PUBLISH-${seq}`);
  assert.equal(await (await get(id, "?download=1")).text(), `ORIGINAL-${seq}`);
});

test("an asset with no original_filename still downloads under a usable name", async () => {
  const id = await makeAsset({ originalFilename: null });
  const cd = (await get(id, "?download=1")).headers.get("content-disposition");

  assert.ok(cd);
  assert.match(cd, new RegExp(`filename="asset-${id}\\.jpg"`));
});

test("a hostile stored filename cannot inject a header", async () => {
  const id = await makeAsset({ originalFilename: 'x"\r\nX-Injected: yes.jpg' });
  const cd = (await get(id, "?download=1")).headers.get("content-disposition");

  assert.ok(cd);
  assert.ok(!cd.includes("\r"), "CR survived into the header");
  assert.ok(!cd.includes("\n"), "LF survived into the header");
  assert.equal(cd.match(/"/g)?.length, 2, "expected exactly one quoted filename");
});

test("a ranged download keeps its filename", async () => {
  // Without the header on the 206, a resumed download saves as the bare numeric id.
  const id = await makeAsset({ originalFilename: "clip.mp4" });
  const res = (await GET(
    new NextRequest(`http://localhost:3939/api/media/${id}?download=1`, {
      headers: { range: "bytes=0-3" },
    }),
    { params: Promise.resolve({ id: String(id) }) }
  )) as unknown as Response;

  assert.equal(res.status, 206);
  assert.match(res.headers.get("content-disposition") ?? "", /filename="clip\.mp4"/);
});

test("a missing asset is still a 404, flag or not", async () => {
  const res = await get(999999, "?download=1");
  assert.equal(res.status, 404);
});
