import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

test("listPosts includes named green and blackout periods", async () => {
  makeTestDb();
  const q = await import("./queries.ts");

  const spring = q.createPeriod({
    name: "Spring Campaign",
    recurs_yearly: true,
    start_month: 3,
    start_day: 1,
    end_month: 5,
    end_day: 31,
  });
  const holidays = q.createPeriod({
    name: "Holiday Blackout",
    recurs_yearly: true,
    start_month: 12,
    start_day: 20,
    end_month: 1,
    end_day: 2,
  });
  const postId = q.createDraftPost({
    caption: "Seasonal post",
    first_comment: "",
    post_type: "text",
    asset_ids: [],
    period_links: [
      { periodId: spring, mode: "green" },
      { periodId: holidays, mode: "blackout" },
    ],
  });

  const post = q.listPosts().find((row) => row.id === postId);
  assert.deepEqual(post?.periods, [
    { id: holidays, name: "Holiday Blackout", mode: "blackout" },
    { id: spring, name: "Spring Campaign", mode: "green" },
  ]);
});
