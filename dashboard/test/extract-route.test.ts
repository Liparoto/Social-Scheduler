import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { POST } = await import("../app/api/posts/[id]/extract/route.ts");

let seq = 0;

function mkAsset() {
  const n = ++seq;
  return Number(
    db
      .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)")
      .run(`ext-hash-${n}`, `a/ext/${n}.jpg`).lastInsertRowid
  );
}

function mkCarousel(slides = 3) {
  const ids = Array.from({ length: slides }, mkAsset);
  const post = q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: ids,
    post_type: "carousel",
  });
  return { post, ids };
}

function call(id: string | number, body: unknown) {
  return POST(
    new NextRequest(`http://localhost:3939/api/posts/${id}/extract`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: String(id) }) }
  );
}

test("extracting a slide returns 200 and every resulting post id", async () => {
  const { post, ids } = mkCarousel(3);
  const res = await call(post, { asset_ids: [ids[1]] });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.post_ids.length, 2);
  assert.equal(body.post_ids[0], post, "the original is first, so the UI can stay on it");
});

test("a missing post is 404", async () => {
  const res = await call(999999, { asset_ids: [1] });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no longer exists/i);
});

test("a non-numeric id is 400", async () => {
  const res = await call("not-a-number", { asset_ids: [1] });
  assert.equal(res.status, 400);
});

test("a missing asset_ids array is 400, not a crash", async () => {
  const { post } = mkCarousel(3);
  const res = await call(post, {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /asset_ids/i);
});

test("asset_ids containing a non-integer is 400", async () => {
  const { post } = mkCarousel(3);
  const res = await call(post, { asset_ids: ["nope"] });
  assert.equal(res.status, 400);
});

test("selecting nothing is 400 with a readable message", async () => {
  const { post } = mkCarousel(3);
  const res = await call(post, { asset_ids: [] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at least one/i);
});

test("selecting every slide is 400 and names the other action", async () => {
  const { post, ids } = mkCarousel(3);
  const res = await call(post, { asset_ids: ids });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /split into separate posts/i);
});

test("a queued send is 409", async () => {
  const { post, ids } = mkCarousel(3);
  const channel = Number(
    db
      .prepare("INSERT INTO channels (platform, account_name, is_active) VALUES ('instagram', ?, 1)")
      .run(`ext-ch-${++seq}`).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2030-01-01T00:00:00Z', 'scheduled')"
  ).run(post, channel);

  const res = await call(post, { asset_ids: [ids[1]] });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cancel or hold/i);
});
