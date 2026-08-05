import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { POST } = await import("../app/api/posts/[id]/unmerge/route.ts");

let seq = 0;

function mkAsset() {
  const n = ++seq;
  return Number(
    db
      .prepare("INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)")
      .run(`route-hash-${n}`, `a/route/${n}.jpg`).lastInsertRowid
  );
}

function mkCarousel(slides = 2) {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: Array.from({ length: slides }, mkAsset),
    post_type: "carousel",
  });
}

function call(id: string | number) {
  return POST(new NextRequest(`http://localhost:3939/api/posts/${id}/unmerge`, { method: "POST" }), {
    params: Promise.resolve({ id: String(id) }),
  });
}

test("splitting a carousel returns 200 and every resulting post id", async () => {
  const original = mkCarousel(3);
  const res = await call(original);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.post_ids.length, 3);
  assert.equal(body.post_ids[0], original, "the original is first, so the UI can stay on it");
});

test("a missing post is 404 with a readable message", async () => {
  const res = await call(999999);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no longer exists/i);
});

test("a non-numeric id is 400, not a crash", async () => {
  const res = await call("not-a-number");
  assert.equal(res.status, 400);
});

test("a single-image post is 400", async () => {
  const post = q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: [mkAsset()],
  });
  const res = await call(post);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /only a carousel/i);
});

test("a queued send is 409, and the message names the fix", async () => {
  const original = mkCarousel(2);
  const channel = Number(
    db
      .prepare("INSERT INTO channels (platform, account_name, is_active) VALUES ('instagram', ?, 1)")
      .run(`route-ch-${++seq}`).lastInsertRowid
  );
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2030-01-01T00:00:00Z', 'scheduled')"
  ).run(original, channel);

  const res = await call(original);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /cancel or hold/i);
});
