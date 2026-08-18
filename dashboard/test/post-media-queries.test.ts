import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();

let seq = 0;

function mkAsset(kind: "image" | "video" = "image"): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, ?, ?, 1080, 1080)"
      )
      .run(`pmq-hash-${n}`, kind, `a/pmq/${n}.jpg`).lastInsertRowid
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

function mkChannel(platform: string): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES (?, ?, ?, 1)"
      )
      .run(platform, `acct-${n}`, `remote-${n}`).lastInsertRowid
  );
}

function slideIds(postId: number): number[] {
  return q.getPostSlides(postId).map((s) => s.asset_id);
}

test("getPostSlides returns slides in order with their media kind", () => {
  const a = mkAsset();
  const b = mkAsset("video");
  const post = mkPost([a, b]);
  assert.deepEqual(q.getPostSlides(post), [
    { asset_id: a, media_kind: "image" },
    { asset_id: b, media_kind: "video" },
  ]);
});

test("addPostAssets appends after the existing slides and sets post_type", () => {
  const post = mkPost([mkAsset()]);
  const extra = mkAsset();
  assert.equal(q.addPostAssets(post, [extra], "carousel"), "ok");
  assert.equal(slideIds(post).at(-1), extra);
  assert.equal(q.getPost(post)!.post_type, "carousel");
});

test("removePostAsset unlinks the slide and leaves the asset alone", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  assert.equal(q.removePostAsset(post, b, "single", false), "ok");
  assert.deepEqual(slideIds(post), [a]);
  assert.ok(q.getAsset(b), "the asset row must survive a remove-from-post");
});

test("removePostAsset with alsoDeleteAsset removes the row too", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  assert.equal(q.removePostAsset(post, b, "single", true), "ok");
  assert.deepEqual(slideIds(post), [a]);
  assert.equal(q.getAsset(b), undefined);
});

test("a live send blocks both writes, and nothing changes", () => {
  const a = mkAsset();
  const b = mkAsset();
  const post = mkPost([a, b]);
  const channel = mkChannel("instagram");
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(post, channel);

  assert.equal(q.addPostAssets(post, [mkAsset()], "carousel"), "has_live");
  assert.equal(q.removePostAsset(post, b, "single", false), "has_live");
  assert.deepEqual(slideIds(post), [a, b]);
});

test("countOtherPostsUsingAsset excludes the post being edited", () => {
  const shared = mkAsset();
  const one = mkPost([shared, mkAsset()]);
  assert.equal(q.countOtherPostsUsingAsset(one, shared), 0);
  mkPost([shared, mkAsset()]);
  assert.equal(q.countOtherPostsUsingAsset(one, shared), 1);
});

test("removePostAsset refuses to delete an asset another post still holds", () => {
  const shared = mkAsset();
  const post = mkPost([shared, mkAsset()]);
  mkPost([shared, mkAsset()]);
  assert.equal(q.removePostAsset(post, shared, "single", true), "still_used");
  assert.deepEqual(slideIds(post).includes(shared), true, "the link must survive a refusal");
  assert.ok(q.getAsset(shared));
});

test("an untargeted draft falls back to Instagram's stricter cap", () => {
  const post = mkPost([mkAsset()]);
  assert.deepEqual(
    q.getPostCompatChannels(post).map((c) => c.platform),
    ["instagram"]
  );
});

test("getPostCompatChannels unions targets and queued sends", () => {
  const post = mkPost([mkAsset()]);
  const target = mkChannel("threads");
  const queued = mkChannel("facebook");
  db.prepare("INSERT INTO post_targets (post_id, channel_id) VALUES (?, ?)").run(post, target);
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled')"
  ).run(post, queued);
  assert.deepEqual(
    q.getPostCompatChannels(post).map((c) => c.platform).sort(),
    ["facebook", "threads"]
  );
});

test("removing a middle slide then appending closes the gap without a UNIQUE collision", () => {
  const a = mkAsset();
  const b = mkAsset();
  const c = mkAsset();
  const post = mkPost([a, b, c]);
  assert.equal(q.removePostAsset(post, b, "carousel", false), "ok");
  assert.deepEqual(slideIds(post), [a, c]);
  const d = mkAsset();
  assert.equal(q.addPostAssets(post, [d], "carousel"), "ok");
  assert.deepEqual(slideIds(post), [a, c, d]);
});
