/**
 * Archiving a post out of the Library.
 *
 * The gap this closes was real and had no workaround: deletePost() refuses any post with a
 * 'posted'/'publishing' publication — correctly, since erasing it would erase the record of
 * something that is live on Instagram — which left test posts and mistakes permanently in
 * the Library with no way out from the UI.
 *
 * The two rules worth pinning down here are the ones that are easy to "helpfully" break
 * later: archiving must NOT be an automation gate of its own (content_status still decides
 * what auto-fill may pick up, and archiving only OFFERS to set it), and unarchiving must
 * restore visibility and nothing else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();

const { POST: ARCHIVE } = await import("../app/api/posts/[id]/archive/route.ts");
const { DELETE: DELETE_POST } = await import("../app/api/posts/[id]/route.ts");

let seq = 0;

function mkPost(caption: string): number {
  return q.createDraftPost({ caption, first_comment: "", asset_ids: [] });
}

function mkChannel(): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', ?, ?, 1)"
      )
      .run(`arch-acct-${n}`, `arch-remote-${n}`).lastInsertRowid
  );
}

function mkPublication(postId: number, status: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO publications (post_id, channel_id, scheduled_at, status)
         VALUES (?, ?, '2026-01-01T00:00:00Z', ?)`
      )
      .run(postId, mkChannel(), status).lastInsertRowid
  );
}

function archive(postId: number | string, body: unknown) {
  return ARCHIVE(
    new NextRequest(`http://localhost/api/posts/${postId}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(postId) }) }
  );
}

function stored(postId: number) {
  return db
    .prepare("SELECT archived_at, content_status, content_kind FROM posts WHERE id = ?")
    .get(postId) as {
    archived_at: string | null;
    content_status: string;
    content_kind: string;
  };
}

const inLibrary = (postId: number) => q.listPosts().some((p) => p.id === postId);

// ---- The whole point: a way out for the post delete refuses to touch -------------------

test("a post with a live send can be archived, though it still cannot be deleted", async () => {
  const postId = mkPost("archive-live-send");
  mkPublication(postId, "posted");

  const del = await DELETE_POST(new Request("http://localhost/api/posts/1"), {
    params: Promise.resolve({ id: String(postId) }),
  });
  assert.equal(del.status, 409, "delete stays blocked — that guard is not what this changes");

  const res = await archive(postId, { archived: true });

  assert.equal(res.status, 200);
  assert.ok(stored(postId).archived_at, "archived_at is stamped");
  assert.equal(inLibrary(postId), false, "and the post leaves the Library listing");
});

test("archiving destroys nothing — the post, its sends and its metrics all survive", async () => {
  const postId = mkPost("archive-keeps-history");
  const pubId = mkPublication(postId, "posted");
  db
    .prepare(
      "INSERT INTO post_metrics (publication_id, fetched_at, reach) VALUES (?, '2026-01-02T00:00:00Z', 1234)"
    )
    .run(pubId);

  await archive(postId, { archived: true });

  assert.ok(q.getPost(postId), "the post row is still there");
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM publications WHERE post_id = ?").get(postId) as {
        n: number;
      }
    ).n,
    1,
    "its publication survives — this is not a delete"
  );
  assert.equal(
    (
      db.prepare("SELECT reach FROM post_metrics WHERE publication_id = ?").get(pubId) as {
        reach: number;
      }
    ).reach,
    1234,
    "and so do its metrics, which is the entire reason archiving exists"
  );
});

// ---- Visibility, not eligibility -------------------------------------------------------

test("archiving on its own does NOT change content_status", async () => {
  const postId = mkPost("archive-leaves-status");
  q.updatePostContentModel(postId, { content_status: "ready" });

  await archive(postId, { archived: true });

  assert.equal(
    stored(postId).content_status,
    "ready",
    "auto-fill eligibility lives in content_status and must stay visible there — " +
      "archiving is not allowed to become a second, invisible gate"
  );
});

test("archiving applies the content_status the dialog asked for, in the same step", async () => {
  const postId = mkPost("archive-sets-retired");
  q.updatePostContentModel(postId, { content_status: "ready", content_kind: "evergreen" });

  await archive(postId, { archived: true, content_status: "retired", content_kind: "one_time" });

  const row = stored(postId);
  assert.ok(row.archived_at);
  assert.equal(row.content_status, "retired");
  assert.equal(row.content_kind, "one_time");
});

test("unarchiving restores visibility and nothing else", async () => {
  const postId = mkPost("archive-round-trip");
  q.updatePostContentModel(postId, { content_status: "ready" });
  await archive(postId, { archived: true, content_status: "retired" });

  const res = await archive(postId, { archived: false, content_status: "ready" });

  assert.equal(res.status, 200);
  assert.equal(stored(postId).archived_at, null);
  assert.equal(inLibrary(postId), true);
  assert.equal(
    stored(postId).content_status,
    "retired",
    "unarchive must not guess a content_status back — quietly making a retired post " +
      "Ready again would put it back in auto-fill's reach without anyone asking"
  );
});

// ---- Listing scope ---------------------------------------------------------------------

test("listPosts scopes to active, archived, or both", async () => {
  const live = mkPost("archive-scope-live");
  const gone = mkPost("archive-scope-gone");
  await archive(gone, { archived: true });

  const ids = (scope?: "active" | "archived" | "all") =>
    q.listPosts(undefined, scope).map((p) => p.id);

  assert.ok(ids().includes(live));
  assert.ok(!ids().includes(gone), "default scope is the Library — archived posts are absent");
  assert.ok(ids("archived").includes(gone));
  assert.ok(!ids("archived").includes(live));
  assert.ok(ids("all").includes(live) && ids("all").includes(gone));
});

test("the archived listing still carries everything a Library card renders", async () => {
  const postId = mkPost("archive-row-shape");
  mkPublication(postId, "posted");
  await archive(postId, { archived: true });

  const row = q.listPosts(undefined, "archived").find((p) => p.id === postId);
  assert.ok(row);
  assert.equal(row.posted_count, 1, "its posting history is still readable from the archive");
  assert.ok(row.archived_at, "and the row says it is archived, so the view can badge it");
});

// ---- Bad input is a readable error, not a constraint crash ------------------------------

test("an unknown content_status is a 400, not a raw SQLite CHECK failure", async () => {
  const postId = mkPost("archive-bad-status");
  const res = await archive(postId, { archived: true, content_status: "nonsense" });

  assert.equal(res.status, 400);
  assert.equal(stored(postId).archived_at, null, "and nothing was written");
});

test("an unknown content_kind is a 400", async () => {
  const postId = mkPost("archive-bad-kind");
  const res = await archive(postId, { archived: true, content_kind: "sometimes" });

  assert.equal(res.status, 400);
  assert.equal(stored(postId).archived_at, null);
});

test("a request with no usable body is a 400 — it must not silently unarchive", async () => {
  const postId = mkPost("archive-bodyless");
  await archive(postId, { archived: true });

  // What a dropped, truncated or retried-without-body request looks like server-side.
  const res = await ARCHIVE(
    new NextRequest(`http://localhost/api/posts/${postId}/archive`, { method: "POST" }),
    { params: Promise.resolve({ id: String(postId) }) }
  );

  assert.equal(res.status, 400);
  assert.ok(
    stored(postId).archived_at,
    "the post must still be archived — a missing field is an error, not 'set it to false'"
  );
});

test("a missing post is a 404 and a non-numeric id is a 400", async () => {
  assert.equal((await archive(999_999, { archived: true })).status, 404);
  assert.equal((await archive("abc", { archived: true })).status, 400);
});
