import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { POST } = await import("../app/api/posts/targets/bulk/route.ts");

// Bulk re-target is how a newly added account gets folded into existing content. It used to
// pre-check every post's caption and return 400 on the FIRST one over a limit, before any
// write — so one long caption in a selection of fifty meant nothing happened at all, and the
// message named only that one post. The caption check itself is right and must stay: adding
// a stricter platform to a post whose caption does not fit it queues a send that dies at the
// worker. What was wrong is that one bad post spoke for the whole batch.

let seq = 0;

function makeChannel(platform: string): number {
  return Number(
    db
      .prepare("INSERT INTO channels (platform, account_name) VALUES (?, ?)")
      .run(platform, `bulk-target-${platform}-${++seq}`).lastInsertRowid
  );
}

function makePost(caption: string): number {
  return q.createDraftPost({ caption, first_comment: "", asset_ids: [] });
}

async function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3939/api/posts/targets/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function targetCount(postId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM post_targets WHERE post_id = ?")
      .get(postId) as { n: number }
  ).n;
}

// Threads caps captions at 500. Instagram enforces no limit here, which is what makes a
// mixed selection possible in the first place.
const TOO_LONG = "x".repeat(600);
const FINE = "short enough";

test("one over-limit post no longer stops the rest of the batch", async () => {
  const threads = makeChannel("threads");
  const good = [makePost(FINE), makePost(FINE)];
  const bad = makePost(TOO_LONG);

  const response = await post({
    post_ids: [good[0], bad, good[1]],
    channel_ids: [threads],
    action: "add",
  });
  const body = await response.json();

  assert.equal(response.status, 200, "partial success is a success — work was done");
  assert.equal(body.updated, 2);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0].post_id, bad);
  assert.match(body.skipped[0].reason, /Threads \(600\/500\)/);

  // The half that could be applied WAS applied — the old behaviour wrote nothing at all.
  assert.equal(targetCount(good[0]), 1);
  assert.equal(targetCount(good[1]), 1);
  // And the offender was genuinely left alone, not quietly queued to fail at publish.
  assert.equal(targetCount(bad), 0);
});

test("every offender is reported, not just the first", async () => {
  const threads = makeChannel("threads");
  const bad = [makePost(TOO_LONG), makePost(TOO_LONG), makePost(TOO_LONG)];
  const good = makePost(FINE);

  const body = await (
    await post({ post_ids: [...bad, good], channel_ids: [threads], action: "add" })
  ).json();

  assert.equal(body.updated, 1);
  assert.deepEqual(
    body.skipped
      .map((s: { post_id: number }) => s.post_id)
      .sort((a: number, b: number) => a - b),
    [...bad].sort((a, b) => a - b),
    "naming one post at a time turns a fifty-post batch into fifty round trips"
  );
});

test("a batch where nothing can be applied is still a 400", async () => {
  const threads = makeChannel("threads");
  const bad = [makePost(TOO_LONG), makePost(TOO_LONG)];

  const response = await post({
    post_ids: bad,
    channel_ids: [threads],
    action: "add",
  });
  const body = await response.json();

  // Nothing happened, so this is not a success. A 200 with updated:0 would show a green
  // "Added 0 accounts" notice and read as if it had worked.
  assert.equal(response.status, 400);
  assert.match(body.error, /2 post/);
  for (const id of bad) assert.equal(targetCount(id), 0);
});

test("a clean batch reports no skips", async () => {
  const threads = makeChannel("threads");
  const posts = [makePost(FINE), makePost(FINE)];

  const response = await post({
    post_ids: posts,
    channel_ids: [threads],
    action: "add",
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.updated, 2);
  assert.deepEqual(body.skipped, []);
});

test("removing a channel never caption-checks", async () => {
  // Removing can only relax constraints, so an over-limit caption must not block it —
  // otherwise a post could get stuck targeting a channel it cannot satisfy.
  const threads = makeChannel("threads");
  const bad = makePost(TOO_LONG);
  db.prepare("INSERT INTO post_targets (post_id, channel_id) VALUES (?, ?)").run(bad, threads);
  assert.equal(targetCount(bad), 1);

  const response = await post({
    post_ids: [bad],
    channel_ids: [threads],
    action: "remove",
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.updated, 1);
  assert.equal(targetCount(bad), 0);
});

test("an unknown post id is ignored rather than counted as updated", async () => {
  const threads = makeChannel("threads");
  const real = makePost(FINE);

  const body = await (
    await post({ post_ids: [real, 999_999], channel_ids: [threads], action: "add" })
  ).json();

  assert.equal(body.updated, 1, "the count has to mean posts that actually changed");
  assert.deepEqual(body.skipped, [], "a missing post is not a caption problem");
});

test("the caption check still uses the worst variant, not just the base caption", async () => {
  // captionsForPlatform rotates through a platform's variants by post count, so a second
  // variant that a .find() would never reach can still be the one that publishes.
  const threads = makeChannel("threads");
  const p = makePost(FINE);
  db.prepare(
    "INSERT INTO caption_variants (post_id, platform, body, sort_order) VALUES (?, 'threads', ?, 0)"
  ).run(p, TOO_LONG);

  const response = await post({
    post_ids: [p],
    channel_ids: [threads],
    action: "add",
  });

  assert.equal(response.status, 400, "the variant is what would publish, so it is what counts");
  assert.equal(targetCount(p), 0);
});
