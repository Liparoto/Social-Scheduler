import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();

const commonTag = q.createTopicTag("bulk-context-route-common");
const periodId = q.createPeriod({
  name: "Bulk context route period",
  recurs_yearly: true,
  start_month: 1,
  start_day: 1,
  end_month: 12,
  end_day: 31,
});
const postA = q.createDraftPost({
  caption: "bulk-context-route-a",
  first_comment: "",
  asset_ids: [],
  tag_ids: [commonTag.id],
  period_links: [{ periodId, mode: "green" }],
});
const postB = q.createDraftPost({
  caption: "bulk-context-route-b",
  first_comment: "",
  asset_ids: [],
  tag_ids: [commonTag.id],
  period_links: [{ periodId, mode: "green" }],
});
q.createDraftPost({
  caption: "bulk-context-route-c",
  first_comment: "",
  asset_ids: [],
});

const { POST } = await import("../app/api/posts/bulk-edit/context/route.ts");

function linkCount(table: "post_tags" | "post_periods"): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost:3939/api/posts/bulk-edit/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function postRaw(body: string) {
  return POST(
    new NextRequest("http://localhost:3939/api/posts/bulk-edit/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );
}

test("malformed JSON and invalid bodies return 400", async () => {
  const malformed = await postRaw("{");
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid request body." });

  for (const body of [null, [], "bad"]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid request body." });
  }
});

test("post_ids must be a non-empty array", async () => {
  for (const body of [{}, { post_ids: null }, { post_ids: [] }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Select at least one post." });
  }
});

test("every post id must be an integer", async () => {
  for (const invalidId of ["bad", 1.5, null]) {
    const response = await post({ post_ids: [postA, invalidId] });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "post_ids must contain integers." });
  }
});

test("an unknown post id is rejected before context is returned", async () => {
  const response = await post({ post_ids: [postA, 999999] });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Unknown post 999999." });
});

test("a duplicate selection returns deduplicated context without writing links", async () => {
  const beforeTags = linkCount("post_tags");
  const beforePeriods = linkCount("post_periods");

  const response = await post({ post_ids: [postA, postB, postA] });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    post_count: 2,
    tags: [{ tag_id: commonTag.id, count: 2 }],
    periods: [{ period_id: periodId, mode: "green", count: 2 }],
    content_statuses: [{ value: "draft", count: 2 }],
    content_kinds: [{ value: "evergreen", count: 2 }],
    cooldowns: [{ value: null, count: 2 }],
  });
  assert.equal(linkCount("post_tags"), beforeTags);
  assert.equal(linkCount("post_periods"), beforePeriods);
});
