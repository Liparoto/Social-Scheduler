/**
 * The first comment's dashboard surface: setting it AFTER a post exists, and asking for
 * a failed one to be retried.
 *
 * Both gaps this covers were real. `first_comment` used to be writable only at creation
 * time, so any post created by bulk import or slide extraction could never get one. And
 * a retry has to be a request the worker picks up, never a write from here — the post is
 * already live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();

const { PATCH, GET } = await import("../app/api/posts/[id]/content/route.ts");
const { POST: RETRY_COMMENT } = await import(
  "../app/api/publications/[id]/retry-comment/route.ts"
);

function patch(postId: number, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/posts/${postId}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(postId) }) }
  );
}

function storedFirstComment(postId: number): string | null {
  return (
    db.prepare("SELECT first_comment FROM posts WHERE id = ?").get(postId) as {
      first_comment: string | null;
    }
  ).first_comment;
}

function makePost(caption: string) {
  return q.createDraftPost({ caption, first_comment: "", asset_ids: [] });
}

// ---- PATCH: the gap that made this unreachable on imported posts ----------------------
test("a first comment can be added to a post that was created without one", async () => {
  const postId = makePost("fc-route-add");
  assert.equal(storedFirstComment(postId), null);

  const res = await patch(postId, { first_comment: "#tags #here" });

  assert.equal(res.status, 200);
  assert.equal(storedFirstComment(postId), "#tags #here");
});

test("a first comment can be changed and cleared", async () => {
  const postId = makePost("fc-route-change");
  await patch(postId, { first_comment: "#old" });
  await patch(postId, { first_comment: "#new" });
  assert.equal(storedFirstComment(postId), "#new");

  await patch(postId, { first_comment: "" });
  // Cleared collapses to NULL, not "", so "no first comment" is one value everywhere —
  // the worker treats both the same, but the column should not carry two spellings.
  assert.equal(storedFirstComment(postId), null);
});

test("whitespace is trimmed, and whitespace-only is no comment at all", async () => {
  const postId = makePost("fc-route-trim");
  await patch(postId, { first_comment: "   #spaced   " });
  assert.equal(storedFirstComment(postId), "#spaced");

  await patch(postId, { first_comment: "   \n  " });
  assert.equal(storedFirstComment(postId), null);
});

test("an over-length first comment is refused, and nothing is written", async () => {
  const postId = makePost("fc-route-toolong");
  await patch(postId, { first_comment: "#keep" });

  const res = await patch(postId, { first_comment: "x".repeat(2201) });

  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /2200/);
  assert.equal(storedFirstComment(postId), "#keep"); // untouched
});

test("exactly at the limit is accepted", async () => {
  const postId = makePost("fc-route-atlimit");
  const res = await patch(postId, { first_comment: "y".repeat(2200) });
  assert.equal(res.status, 200);
  assert.equal(storedFirstComment(postId)?.length, 2200);
});

test("omitting first_comment leaves the existing one alone", async () => {
  // Every field on this route is optional — a caller saving only tags must not wipe it.
  const postId = makePost("fc-route-omitted");
  await patch(postId, { first_comment: "#keepme" });

  await patch(postId, { content_status: "ready" });

  assert.equal(storedFirstComment(postId), "#keepme");
});

test("GET returns the saved first comment so an editor can load it", async () => {
  const postId = makePost("fc-route-get");
  await patch(postId, { first_comment: "#loaded" });

  const res = await GET(new NextRequest(`http://localhost/api/posts/${postId}/content`), {
    params: Promise.resolve({ id: String(postId) }),
  });

  assert.equal((await res.json()).first_comment, "#loaded");
});

// ---- Retry: a request the worker picks up, never a write from here --------------------
function makePublication(status: string, firstCommentStatus: string, isDryRun = 0) {
  const postId = makePost(`fc-retry-${status}-${firstCommentStatus}-${Math.random()}`);
  const channelId = (
    db
      .prepare(
        `INSERT INTO channels (platform, account_name, remote_account_id, access_token)
         VALUES ('instagram', 'FC Test', 'IG1', 'tok') RETURNING id`
      )
      .get() as { id: number }
  ).id;
  return (
    db
      .prepare(
        `INSERT INTO publications
           (post_id, channel_id, scheduled_at, status, first_comment_status, is_dry_run,
            remote_post_id)
         VALUES (?, ?, '2026-08-05T00:00:00Z', ?, ?, ?, 'media-1') RETURNING id`
      )
      .get(postId, channelId, status, firstCommentStatus, isDryRun) as { id: number }
  ).id;
}

function retryFlag(pubId: number): number {
  return (
    db
      .prepare("SELECT first_comment_retry_requested AS f FROM publications WHERE id = ?")
      .get(pubId) as { f: number }
  ).f;
}

async function retry(pubId: number) {
  return RETRY_COMMENT(new Request("http://localhost", { method: "POST" }), {
    params: Promise.resolve({ id: String(pubId) }),
  });
}

test("retrying a failed comment sets the request flag for the worker", async () => {
  const pubId = makePublication("posted", "failed");

  const res = await retry(pubId);

  assert.equal(res.status, 200);
  assert.equal(retryFlag(pubId), 1);
  // The route must NOT touch the status itself — the worker owns that transition.
  const row = db
    .prepare("SELECT status, first_comment_status FROM publications WHERE id = ?")
    .get(pubId) as { status: string; first_comment_status: string };
  assert.equal(row.status, "posted");
  assert.equal(row.first_comment_status, "failed");
});

test("an already-posted comment cannot be retried", async () => {
  // The safety property: retrying here would put a SECOND comment on a live post.
  const pubId = makePublication("posted", "posted");
  const res = await retry(pubId);
  assert.equal(res.status, 409);
  assert.equal(retryFlag(pubId), 0);
});

test("a send that never went out cannot have its comment retried", async () => {
  const pubId = makePublication("scheduled", "failed");
  const res = await retry(pubId);
  assert.equal(res.status, 409);
  assert.equal(retryFlag(pubId), 0);
});

test("a dry-run send cannot have its comment retried", async () => {
  // Nothing was published, so there is no live media to comment on.
  const pubId = makePublication("posted", "failed", 1);
  const res = await retry(pubId);
  assert.equal(res.status, 409);
  assert.equal(retryFlag(pubId), 0);
});

test("an unknown publication is a 409, not a crash", async () => {
  const res = await retry(999999);
  assert.equal(res.status, 409);
});
