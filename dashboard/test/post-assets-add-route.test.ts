import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const route = await import("../app/api/posts/[id]/assets/route.ts");

let seq = 0;

function mkAsset(kind: "image" | "video" = "image"): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, ?, ?, 1080, 1080)"
      )
      .run(`add-hash-${n}`, kind, `a/add/${n}.jpg`).lastInsertRowid
  );
}

function mkPost(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: assetIds.length > 1 ? "carousel" : "single",
  });
}

async function post(postId: number | string, body: unknown) {
  return route.POST(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(postId) }) }
  );
}

test("adding a slide returns the new order and type", async () => {
  const first = mkAsset();
  const p = mkPost([first]);
  const extra = mkAsset();

  const res = await post(p, { asset_ids: [extra] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.asset_ids, [first, extra]);
  assert.equal(body.post_type, "carousel");
  assert.equal(q.getPost(p)!.post_type, "carousel");
});

test("an unknown post is a 404", async () => {
  const res = await post(999999, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 404);
});

test("an unknown asset id is a 400 and adds nothing", async () => {
  const p = mkPost([mkAsset()]);
  const before = q.getPostSlides(p).length;
  const res = await post(p, { asset_ids: [999999] });
  assert.equal(res.status, 400);
  assert.equal(q.getPostSlides(p).length, before);
});

test("a malformed body is a 400", async () => {
  const p = mkPost([mkAsset()]);
  const res = await post(p, { asset_ids: "nope" });
  assert.equal(res.status, 400);
});

test("mixing a video into a carousel is refused", async () => {
  const p = mkPost([mkAsset(), mkAsset()]);
  const res = await post(p, { asset_ids: [mkAsset("video")] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "video_mix");
  assert.equal(q.getPostSlides(p).length, 2);
});

test("a live send is a 409 and adds nothing", async () => {
  const p = mkPost([mkAsset()]);
  const channel = Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', 'a', 'b', 1)"
      )
      .run().lastInsertRowid
  );
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(p, channel);

  const res = await post(p, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "live_send");
  assert.equal(q.getPostSlides(p).length, 1);
});
