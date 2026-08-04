import { test } from "node:test";
import assert from "node:assert/strict";
import { groupQueueRows, cancelableIds, type GroupableRow } from "./queue-groups.ts";

const AT = "2026-08-10T18:00:00.000Z";

function row(over: Partial<GroupableRow> & { id: number }): GroupableRow {
  return {
    post_id: 1,
    channel_id: 1,
    surface: "feed",
    scheduled_at: AT,
    status: "scheduled",
    ...over,
  };
}

test("feed rows are never grouped, even when they share everything else", () => {
  const groups = groupQueueRows([row({ id: 1 }), row({ id: 2 })]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.isStoryGroup), [false, false]);
});

test("story slides of one fan-out become a single group", () => {
  const groups = groupQueueRows([
    row({ id: 1, surface: "story" }),
    row({ id: 2, surface: "story" }),
    row({ id: 3, surface: "story" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isStoryGroup, true);
  assert.deepEqual(groups[0].rows.map((r) => r.id), [1, 2, 3]);
});

test("a lone story send is not a group — a heading over one row is noise", () => {
  const groups = groupQueueRows([row({ id: 1, surface: "story" })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isStoryGroup, false);
});

test("the same post storied at two different times stays two groups", () => {
  const groups = groupQueueRows([
    row({ id: 1, surface: "story" }),
    row({ id: 2, surface: "story" }),
    row({ id: 3, surface: "story", scheduled_at: "2026-08-11T18:00:00.000Z" }),
    row({ id: 4, surface: "story", scheduled_at: "2026-08-11T18:00:00.000Z" }),
  ]);
  assert.equal(groups.length, 2, "a morning and an evening Story are separate sends");
  assert.deepEqual(groups.map((g) => g.rows.length), [2, 2]);
});

test("the same post storied to two channels stays two groups", () => {
  const groups = groupQueueRows([
    row({ id: 1, surface: "story" }),
    row({ id: 2, surface: "story" }),
    row({ id: 3, surface: "story", channel_id: 2 }),
    row({ id: 4, surface: "story", channel_id: 2 }),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.rows.map((r) => r.id)), [[1, 2], [3, 4]]);
});

test("grouping never reorders the queue — a group sits where its first row was", () => {
  const groups = groupQueueRows([
    row({ id: 10 }),
    row({ id: 11, surface: "story", post_id: 2 }),
    row({ id: 12 }),
    row({ id: 13, surface: "story", post_id: 2 }),
  ]);
  // The story group takes the position of id 11, and id 13 joins it rather than
  // appearing after id 12.
  assert.deepEqual(
    groups.map((g) => g.rows.map((r) => r.id)),
    [[10], [11, 13], [12]],
  );
});

test("interleaved story groups don't merge across posts", () => {
  const groups = groupQueueRows([
    row({ id: 1, surface: "story", post_id: 5 }),
    row({ id: 2, surface: "story", post_id: 9 }),
    row({ id: 3, surface: "story", post_id: 5 }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.rows.map((r) => r.id)),
    [[1, 3], [2]],
  );
});

// ---- cancelableIds ---------------------------------------------------------------
test("only still-cancelable sends are offered to a bulk cancel", () => {
  const ids = cancelableIds([
    row({ id: 1, status: "scheduled" }),
    row({ id: 2, status: "posted" }),
    row({ id: 3, status: "pending_approval" }),
    row({ id: 4, status: "failed" }),
    row({ id: 5, status: "canceled" }),
    row({ id: 6, status: "publishing" }),
  ]);
  assert.deepEqual(ids, [1, 3], "posted/failed/canceled/publishing must not be canceled");
});

test("a fully-posted story group offers nothing to cancel", () => {
  assert.deepEqual(cancelableIds([row({ id: 1, status: "posted" })]), []);
});
