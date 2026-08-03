import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";
import { librarySeasonStatus } from "./library-season-status.ts";

test("listPosts includes complete recurring and one-off period windows", async () => {
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
    recurs_yearly: false,
    start_date: "2026-12-20",
    end_date: "2027-01-02",
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
    {
      id: holidays,
      name: "Holiday Blackout",
      mode: "blackout",
      recurs_yearly: 0,
      start_month: null,
      start_day: null,
      end_month: null,
      end_day: null,
      start_date: "2026-12-20",
      end_date: "2027-01-02",
    },
    {
      id: spring,
      name: "Spring Campaign",
      mode: "green",
      recurs_yearly: 1,
      start_month: 3,
      start_day: 1,
      end_month: 5,
      end_day: 31,
      start_date: null,
      end_date: null,
    },
  ]);

  const malformed = q.createPeriod({
    name: "Malformed one-off",
    recurs_yearly: false,
    start_date: "2026-02-30",
    end_date: "2026-03-02",
  });
  const malformedPostId = q.createDraftPost({
    caption: "Malformed seasonal post",
    first_comment: "",
    post_type: "text",
    asset_ids: [],
    period_links: [{ periodId: malformed, mode: "green" }],
  });
  const livePostId = q.createDraftPost({
    caption: "Unaffected post",
    first_comment: "",
    post_type: "text",
    asset_ids: [],
  });
  q.updatePostContentModel(malformedPostId, { content_status: "ready" });
  q.updatePostContentModel(livePostId, { content_status: "ready" });

  const statuses = q
    .listPosts()
    .filter((row) => row.id === malformedPostId || row.id === livePostId)
    .sort((a, b) => a.id - b.id)
    .map((row) => librarySeasonStatus(row.content_status, row.periods, "2026-08-03"));
  assert.deepEqual(statuses, ["Invalid period", "Live"]);
});
