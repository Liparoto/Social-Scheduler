import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const { POST } = await import("../app/api/posts/bulk-edit/route.ts");

let fixtureSeq = 0;

function makePosts(count: number): number[] {
  return Array.from({ length: count }, () =>
    q.createDraftPost({
      caption: `bulk-route-${++fixtureSeq}`,
      first_comment: "",
      asset_ids: [],
    })
  );
}

function linkCount(table: "post_tags" | "post_periods"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3939/api/posts/bulk-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

test("a valid batch updates all selected posts and returns actual counts", async () => {
  const postIds = makePosts(3);
  const tag = q.createTopicTag(`route-valid-${fixtureSeq}`);

  const response = await post({
    post_ids: postIds,
    tags: { add: [tag.id], remove: [] },
    content_status: "ready",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    tags_added: 3,
    tags_removed: 0,
    periods_added: 0,
    periods_removed: 0,
    posts_updated: 3,
  });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM post_tags WHERE tag_id = ?").get(tag.id) as { n: number }).n,
    3
  );
  assert.ok(postIds.every((id) => q.getPost(id)?.content_status === "ready"));
});

test("an invalid period rejects the whole request before a valid tag is written", async () => {
  const postIds = makePosts(3);
  const tag = q.createTopicTag(`route-atomic-${fixtureSeq}`);
  const beforeTags = linkCount("post_tags");
  const beforePeriods = linkCount("post_periods");

  const response = await post({
    post_ids: postIds,
    tags: { add: [tag.id], remove: [] },
    periods: { add: [{ periodId: 999999, mode: "green" }], remove: [] },
  });

  assert.equal(response.status, 400);
  assert.equal(linkCount("post_tags"), beforeTags);
  assert.equal(linkCount("post_periods"), beforePeriods);
});

test("an unknown post id rejects the request without writing", async () => {
  const tag = q.createTopicTag(`route-unknown-${++fixtureSeq}`);
  const before = linkCount("post_tags");

  const response = await post({
    post_ids: [999999],
    tags: { add: [tag.id], remove: [] },
  });

  assert.equal(response.status, 400);
  assert.equal(linkCount("post_tags"), before);
});

test("empty post_ids and invalid scalars return 400", async () => {
  assert.equal((await post({ post_ids: [] })).status, 400);
  const [postId] = makePosts(1);
  assert.equal((await post({ post_ids: [postId], content_status: "published" })).status, 400);
  assert.equal((await post({ post_ids: [postId], content_kind: "seasonal" })).status, 400);
  assert.equal((await post({ post_ids: [postId], cooldown_days: -1 })).status, 400);
});

test("null add/remove lists are rejected instead of treated as empty", async () => {
  const [postId] = makePosts(1);
  assert.equal(
    (await post({ post_ids: [postId], tags: { add: null, remove: [] } })).status,
    400
  );
  assert.equal(
    (await post({ post_ids: [postId], periods: { add: [], remove: null } })).status,
    400
  );
});
