import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const route = await import("../app/api/posts/[id]/assets/route.ts");

let seq = 0;

function mkAsset(): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, 'image', ?, 1080, 1080)"
      )
      .run(`route-hash-${n}`, `a/route/${n}.jpg`).lastInsertRowid
  );
}

function mkCarousel(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: "carousel",
  });
}

function orderOf(postId: number): number[] {
  return q.getPostAssets(postId).map((a) => a.id);
}

const params = (postId: number | string) => ({ params: Promise.resolve({ id: String(postId) }) });

async function patch(postId: number | string, body: unknown) {
  return route.PATCH(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(postId)
  );
}

async function get(postId: number | string) {
  return route.GET(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets`),
    params(postId)
  );
}

test("GET returns the slides in order with what the lightbox needs", async () => {
  const ids = [mkAsset(), mkAsset(), mkAsset()];
  const post = mkCarousel(ids);

  const res = await get(post);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(
    body.assets.map((a: { id: number }) => a.id),
    ids
  );
  assert.deepEqual(Object.keys(body.assets[0]).sort(), [
    "cover_frame_ms",
    "height",
    "id",
    "media_kind",
    "width",
  ]);
});

test("PATCH saves a new order and reports it back", async () => {
  const ids = [mkAsset(), mkAsset(), mkAsset()];
  const post = mkCarousel(ids);

  const res = await patch(post, { asset_ids: [ids[2], ids[0], ids[1]] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).asset_ids, [ids[2], ids[0], ids[1]]);
  assert.deepEqual(orderOf(post), [ids[2], ids[0], ids[1]]);
});

test("an unknown post is a 404 on both verbs", async () => {
  assert.equal((await get(999999)).status, 404);
  assert.equal((await patch(999999, { asset_ids: [1] })).status, 404);
});

test("a non-numeric id is a 404, not a crash", async () => {
  assert.equal((await get("banana")).status, 404);
});

// The invariant. Each of these would change the slide count or the slide SET.
test("anything that is not a permutation is a 400 and writes nothing", async () => {
  const ids = [mkAsset(), mkAsset(), mkAsset()];
  const foreign = mkAsset();
  const post = mkCarousel(ids);

  for (const bad of [
    [ids[0], ids[1]],
    [...ids, foreign],
    [ids[0], ids[0], ids[1]],
    [ids[0], ids[1], foreign],
    [],
  ]) {
    const res = await patch(post, { asset_ids: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} should be a 400`);
    assert.deepEqual(orderOf(post), ids, "the saved order must be untouched");
  }
});

test("a malformed body is a 400, not a 500", async () => {
  const ids = [mkAsset(), mkAsset()];
  const post = mkCarousel(ids);

  assert.equal((await patch(post, {})).status, 400);
  assert.equal((await patch(post, { asset_ids: "1,2" })).status, 400);
  assert.equal((await patch(post, { asset_ids: [1.5, 2] })).status, 400);
  assert.deepEqual(orderOf(post), ids);
});

test("a post that is mid-publish is refused with 409 and is not rewritten", async () => {
  const ids = [mkAsset(), mkAsset()];
  const post = mkCarousel(ids);
  const channel = q.createChannel({
    platform: "instagram",
    account_name: `route-ch-${++seq}`,
    timezone: "America/Los_Angeles",
  });
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, status, scheduled_at)
     VALUES (?, ?, 'publishing', '2030-01-01T00:00:00Z')`
  ).run(post, channel);

  const res = await patch(post, { asset_ids: [ids[1], ids[0]] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "publishing");
  assert.deepEqual(orderOf(post), ids);
});

test("a queued send does NOT block a reorder — spec §4", async () => {
  const ids = [mkAsset(), mkAsset()];
  const post = mkCarousel(ids);
  const channel = q.createChannel({
    platform: "instagram",
    account_name: `route-queued-${++seq}`,
    timezone: "America/Los_Angeles",
  });
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, status, scheduled_at)
     VALUES (?, ?, 'scheduled', '2030-01-01T00:00:00Z')`
  ).run(post, channel);

  assert.equal((await patch(post, { asset_ids: [ids[1], ids[0]] })).status, 200);
  assert.deepEqual(orderOf(post), [ids[1], ids[0]]);
});

test("a single-image post can be 'reordered' to itself without error", async () => {
  const only = mkAsset();
  const post = q.createDraftPost({ caption: "", first_comment: "", asset_ids: [only] });
  assert.equal((await patch(post, { asset_ids: [only] })).status, 200);
});
