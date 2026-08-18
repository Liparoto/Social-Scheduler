import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { config } = await import("../lib/config.ts");
const route = await import("../app/api/posts/[id]/assets/[assetId]/route.ts");

let seq = 0;

/** Writes a real byte on disk too, so the file-deletion half is actually exercised. */
function mkAsset(): number {
  const n = ++seq;
  const rel = `rm/${n}.jpg`;
  const abs = path.join(config.assetStorageDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x");
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, 'image', ?, 1080, 1080)"
      )
      .run(`rm-hash-${n}`, rel).lastInsertRowid
  );
}

function fileFor(assetId: number): string {
  return path.join(config.assetStorageDir, q.getAsset(assetId)!.storage_path!);
}

function mkPost(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: assetIds.length > 1 ? "carousel" : "single",
  });
}

async function del(postId: number | string, assetId: number | string, mode?: string) {
  const qs = mode ? `?mode=${mode}` : "";
  return route.DELETE(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets/${assetId}${qs}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: String(postId), assetId: String(assetId) }) }
  );
}

test("mode=post unlinks the slide and keeps the file", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);

  const res = await del(p, b, "post");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.asset_ids, [a]);
  assert.equal(body.post_type, "single");
  assert.equal(body.deleted_asset, false);
  assert.ok(q.getAsset(b), "the asset row survives");
  assert.ok(fs.existsSync(fileFor(b)), "the file survives");
});

test("mode defaults to post when it is missing or nonsense", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const res = await del(p, b);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted_asset, false);
  assert.ok(q.getAsset(b));
});

test("a typo'd or wrong-case mode falls back to the non-destructive one, never the destructive one", async () => {
  for (const mode of ["everywher", "Everywhere"]) {
    const a = mkAsset();
    const b = mkAsset();
    const p = mkPost([a, b]);
    const res = await del(p, b, mode);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).deleted_asset, false, `mode=${mode} must not delete the file`);
    assert.ok(q.getAsset(b), `mode=${mode} must leave the asset row alone`);
    assert.ok(fs.existsSync(fileFor(b)), `mode=${mode} must leave the file on disk`);
  }
});

test("mode=everywhere removes the row and the file from disk", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const filePath = fileFor(b);

  const res = await del(p, b, "everywhere");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted_asset, true);
  assert.equal(q.getAsset(b), undefined);
  assert.equal(fs.existsSync(filePath), false);
});

test("mode=everywhere is refused for a shared asset, changing NOTHING", async () => {
  const shared = mkAsset();
  const p = mkPost([shared, mkAsset()]);
  mkPost([shared, mkAsset()]);
  const filePath = fileFor(shared);

  const res = await del(p, shared, "everywhere");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "shared_asset");
  assert.match(body.error, /1 other post/);
  assert.ok(q.getPostSlides(p).some((s) => s.asset_id === shared), "still on the post");
  assert.ok(fs.existsSync(filePath), "file untouched");
});

test("the last slide cannot be removed", async () => {
  const a = mkAsset();
  const p = mkPost([a]);
  const res = await del(p, a, "post");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "last_slide");
  assert.equal(q.getPostSlides(p).length, 1);
});

test("a slide that isn't on this post is a 404", async () => {
  const p = mkPost([mkAsset(), mkAsset()]);
  const res = await del(p, mkAsset(), "post");
  assert.equal(res.status, 404);
});

test("an unknown post is a 404", async () => {
  const res = await del(999999, mkAsset(), "post");
  assert.equal(res.status, 404);
});

test("a live send is a 409 and removes nothing", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const channel = Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', 'live', 'x', 1)"
      )
      .run().lastInsertRowid
  );
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'publishing')"
  ).run(p, channel);

  const res = await del(p, b, "everywhere");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "live_send");
  assert.equal(q.getPostSlides(p).length, 2);
  assert.ok(fs.existsSync(fileFor(b)));
});

test("a slide with a queued Story send is refused in BOTH modes, and removes nothing", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const channel = Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', 'story-live', 'y', 1)"
      )
      .run().lastInsertRowid
  );
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled', 'story', ?)`
  ).run(p, channel, b);

  const post = await del(p, b, "post");
  assert.equal(post.status, 409);
  assert.equal((await post.json()).code, "story_queued");
  assert.ok(q.getPostSlides(p).some((s) => s.asset_id === b), "still on the post — mode=post");

  const everywhere = await del(p, b, "everywhere");
  assert.equal(everywhere.status, 409);
  assert.equal((await everywhere.json()).code, "story_queued");
  assert.ok(q.getAsset(b), "the asset row survives — mode=everywhere");
  assert.ok(fs.existsSync(fileFor(b)), "the file survives — mode=everywhere");
});

test("removing the middle slide leaves a gap-free order that can be appended to", async () => {
  const [a, b, c] = [mkAsset(), mkAsset(), mkAsset()];
  const p = mkPost([a, b, c]);
  assert.equal((await del(p, b, "post")).status, 200);
  const extra = mkAsset();
  assert.equal(q.addPostAssets(p, [extra], "carousel"), "ok");
  assert.deepEqual(q.getPostSlides(p).map((s) => s.asset_id), [a, c, extra]);
});

function mkChannel(name: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', ?, ?, 1)"
      )
      .run(name, `remote-${name}`).lastInsertRowid
  );
}

test("mode=everywhere is refused honestly when a FAILED Story send still names the slide", async () => {
  // The case the design cares about most: fixing the media before retrying is very often
  // exactly why a send failed. 'failed' is not 'scheduled'/'pending_approval', so the
  // story_queued rule doesn't fire — but publications.asset_id is ON DELETE RESTRICT, so
  // the asset DELETE cannot go through. This used to reach SQLite and come back as
  // "Another post picked this file up while you were editing", which was simply untrue.
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'failed', 'story', ?)`
  ).run(p, mkChannel("failed-story"), b);

  const res = await del(p, b, "everywhere");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "referenced_asset");
  assert.doesNotMatch(body.error, /another post/i, "must not blame a post that isn't involved");
  assert.doesNotMatch(body.error, /while you were editing/i, "must not blame a race");
  assert.ok(q.getPostSlides(p).some((s) => s.asset_id === b), "still on the post");
  assert.ok(fs.existsSync(fileFor(b)), "file untouched");

  // And the fallback the message points at actually works.
  const unlink = await del(p, b, "post");
  assert.equal(unlink.status, 200);
  assert.ok(q.getAsset(b), "the file itself is left alone");
});

test("mode=everywhere is refused when the slide is some video's cover image", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  db.prepare("UPDATE assets SET cover_asset_id = ? WHERE id = ?").run(b, a);

  const res = await del(p, b, "everywhere");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "referenced_asset");
  assert.match(body.error, /cover image/);
  assert.ok(q.getAsset(b), "the asset row survives");
  assert.ok(fs.existsSync(fileFor(b)), "the file survives");
});
