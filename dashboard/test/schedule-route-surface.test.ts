import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

// Regression test for a REAL incident: a post designated only for an Instagram Story was
// published to the public feed. The publication row was written surface='feed' because the
// post editor's sends panel sent bare channel_ids, and the route silently read those as
// feed targets. This route publishes, so a guessed surface is unrecoverable.

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { POST } = await import("../app/api/posts/[id]/schedule/route.ts");

let seq = 0;

function fixture() {
  const prefix = `sched${++seq}`;
  const ig = q.createChannel({
    platform: "instagram",
    account_name: `${prefix}-ig`,
    timezone: "America/Los_Angeles",
  } as Parameters<typeof q.createChannel>[0]);
  const assetId = Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path) VALUES (?, 'image', ?)",
      )
      .run(`${prefix}-hash`, `a/${prefix}.jpg`).lastInsertRowid,
  );
  const postId = q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: [assetId],
  });
  return { ig, postId, assetId };
}

async function schedule(postId: number, body: unknown) {
  return POST(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/schedule`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: String(postId) }) },
  );
}

function pubs(postId: number) {
  return db
    .prepare("SELECT surface, asset_id FROM publications WHERE post_id = ? ORDER BY id")
    .all(postId) as { surface: string; asset_id: number | null }[];
}

test("bare channel_ids are refused — a publishing route must not guess a surface", async () => {
  const { ig, postId } = fixture();
  const res = await schedule(postId, { channel_ids: [ig], post_now: true });

  assert.equal(res.status, 400, "channel_ids must not be silently treated as feed here");
  assert.match((await res.json()).error, /targets/i);
  assert.equal(pubs(postId).length, 0, "nothing may be scheduled by a refused request");
});

test("a story target schedules a story publication, not a feed one", async () => {
  const { ig, postId, assetId } = fixture();
  const res = await schedule(postId, {
    targets: [{ channel_id: ig, surface: "story" }],
    post_now: true,
  });

  assert.equal(res.status, 201);
  assert.deepEqual(pubs(postId), [{ surface: "story", asset_id: assetId }]);
});

test("a feed target still schedules one feed publication covering all assets", async () => {
  const { ig, postId } = fixture();
  const res = await schedule(postId, {
    targets: [{ channel_id: ig, surface: "feed" }],
    post_now: true,
  });

  assert.equal(res.status, 201);
  assert.deepEqual(pubs(postId), [{ surface: "feed", asset_id: null }]);
});

test("a reel target schedules one feed-shaped publication covering all assets", async () => {
  const { ig, postId } = fixture();
  const res = await schedule(postId, {
    targets: [{ channel_id: ig, surface: "reel" }],
    post_now: true,
  });

  assert.equal(res.status, 201);
  assert.deepEqual(pubs(postId), [{ surface: "reel", asset_id: null }]);
});

test("a target with no surface key is refused rather than guessed", async () => {
  // parseTargets' own comment: an unlisted (here, absent) value must fail loudly rather
  // than be guessed on a route that publishes.
  const { ig, postId } = fixture();
  const res = await schedule(postId, {
    targets: [{ channel_id: ig }],
    post_now: true,
  });

  assert.equal(res.status, 400);
  assert.equal(pubs(postId).length, 0);
});

test("an unknown surface is rejected rather than defaulted", async () => {
  const { ig, postId } = fixture();
  // "reel" used to be this test's example of an unknown surface, but migration 0027 and the
  // facebook-video work made it a real one — using "bogus" for a value that will never be
  // valid, per this project's convention (see worker/tests/test_migration_0027.py).
  const res = await schedule(postId, {
    targets: [{ channel_id: ig, surface: "bogus" }],
    post_now: true,
  });

  assert.equal(res.status, 400);
  assert.equal(pubs(postId).length, 0);
});
