import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

makeTestDb();
const q = await import("./queries.ts");

test("bulk edit context deduplicates posts and groups every metadata value", () => {
  const commonTag = q.createTopicTag("bulk-context-common");
  const singleTag = q.createTopicTag("bulk-context-single");
  const periodId = q.createPeriod({
    name: "Bulk context period",
    recurs_yearly: true,
    start_month: 1,
    start_day: 1,
    end_month: 12,
    end_day: 31,
  });

  const postA = q.createDraftPost({
    caption: "bulk-context-a",
    first_comment: "",
    asset_ids: [],
    content_status: "ready",
    content_kind: "evergreen",
    cooldown_days: null,
    tag_ids: [commonTag.id, singleTag.id],
    period_links: [
      { periodId, mode: "green" },
      { periodId, mode: "blackout" },
    ],
  });
  const postB = q.createDraftPost({
    caption: "bulk-context-b",
    first_comment: "",
    asset_ids: [],
    content_status: "ready",
    content_kind: "evergreen",
    cooldown_days: null,
    tag_ids: [commonTag.id],
    period_links: [{ periodId, mode: "green" }],
  });
  const postC = q.createDraftPost({
    caption: "bulk-context-c",
    first_comment: "",
    asset_ids: [],
    content_status: "draft",
    content_kind: "evergreen",
    cooldown_days: 90,
    tag_ids: [commonTag.id],
    period_links: [{ periodId, mode: "green" }],
  });

  assert.deepEqual(q.getBulkEditContext([postA, postB, postC, postA]), {
    post_count: 3,
    tags: [
      { tag_id: commonTag.id, count: 3 },
      { tag_id: singleTag.id, count: 1 },
    ],
    periods: [
      { period_id: periodId, mode: "blackout", count: 1 },
      { period_id: periodId, mode: "green", count: 3 },
    ],
    content_statuses: [
      { value: "draft", count: 1 },
      { value: "ready", count: 2 },
    ],
    content_kinds: [{ value: "evergreen", count: 3 }],
    cooldowns: [
      { value: null, count: 2 },
      { value: 90, count: 1 },
    ],
  });
});

test("bulk edit context safely handles an empty selection", () => {
  assert.deepEqual(q.getBulkEditContext([]), {
    post_count: 0,
    tags: [],
    periods: [],
    content_statuses: [],
    content_kinds: [],
    cooldowns: [],
  });
});

test("existing post ids use one deduplicated deterministic result", () => {
  const postA = q.createDraftPost({
    caption: "bulk-existing-a",
    first_comment: "",
    asset_ids: [],
  });
  const postB = q.createDraftPost({
    caption: "bulk-existing-b",
    first_comment: "",
    asset_ids: [],
  });

  assert.deepEqual(q.getExistingPostIds([postB, 999999, postA, postB]), [postA, postB]);
  assert.deepEqual(q.getExistingPostIds([]), []);
});
