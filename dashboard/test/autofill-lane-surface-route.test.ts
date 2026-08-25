import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

// Auto-fill config is stored per (owner, surface) since migration 0028, and the PATCH
// body names which surface it is configuring. Both routes used to coerce an
// unrecognized `surface` to "feed", so a typo like "stories" wrote the STORY panel's
// cadence and depths onto the live FEED lane — a silent wrong-lane write on routes that
// already answer 400 for a bad `color_hue` or a stray `timezone`.
//
// An ABSENT surface is a different case and must stay "feed": that request shape
// predates lanes and feed is its correct reading.

makeTestDb();
const q = await import("../lib/queries.ts");
const channelRoute = await import("../app/api/channels/[id]/route.ts");
const groupRoute = await import("../app/api/channel-groups/[id]/route.ts");

let seq = 0;

function patchChannel(id: number, body: unknown) {
  return channelRoute.PATCH(
    new NextRequest(`http://localhost:3939/api/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
}

function patchGroup(id: number, body: unknown) {
  return groupRoute.PATCH(
    new NextRequest(`http://localhost:3939/api/channel-groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id: String(id) }) },
  );
}

function newChannel() {
  return q.createChannel({
    platform: "instagram",
    account_name: `lane-surface-${++seq}`,
    timezone: "America/Los_Angeles",
  } as Parameters<typeof q.createChannel>[0]);
}

function newGroup() {
  return q.createChannelGroup({
    name: `lane-surface-group-${++seq}`,
    timezone: "America/Los_Angeles",
  });
}

test("channel PATCH: an absent surface still means the feed lane", async () => {
  const id = newChannel();
  const res = await patchChannel(id, { autofill_enabled: 1, min_queue_depth: 4 });

  assert.equal(res.status, 200);
  const lanes = q.getAutofillLanes({ kind: "channel", id });
  assert.deepEqual(
    lanes.map((l) => l.surface),
    ["feed"],
    "a body with no surface predates lanes and must configure the feed",
  );
  assert.equal(lanes[0].min_queue_depth, 4);
});

test("channel PATCH: an invalid surface is a 400, never a write to the feed lane", async () => {
  const id = newChannel();
  await patchChannel(id, { autofill_enabled: 1, min_queue_depth: 4 }); // real feed lane

  const res = await patchChannel(id, { surface: "stories", min_queue_depth: 99 });

  assert.equal(res.status, 400, "'stories' is not a surface — refuse it");
  const body = (await res.json()) as { error?: string };
  assert.match(String(body.error), /surface/i);
  const lanes = q.getAutofillLanes({ kind: "channel", id });
  assert.deepEqual(lanes.map((l) => l.surface), ["feed"]);
  assert.equal(
    lanes[0].min_queue_depth,
    4,
    "the typo must not have landed on the live feed lane",
  );
});

test("group PATCH: an absent surface still means the feed lane", async () => {
  const id = newGroup();
  const res = await patchGroup(id, { autofill_enabled: 1, target_queue_depth: 6 });

  assert.equal(res.status, 200);
  const lanes = q.getAutofillLanes({ kind: "group", id });
  assert.deepEqual(lanes.map((l) => l.surface), ["feed"]);
  assert.equal(lanes[0].target_queue_depth, 6);
});

test("group PATCH: an invalid surface is a 400, never a write to the feed lane", async () => {
  const id = newGroup();
  await patchGroup(id, { autofill_enabled: 1, target_queue_depth: 6 });

  const res = await patchGroup(id, { surface: "storys", target_queue_depth: 99 });

  assert.equal(res.status, 400, "'storys' is not a surface — refuse it");
  const body = (await res.json()) as { error?: string };
  assert.match(String(body.error), /surface/i);
  const lanes = q.getAutofillLanes({ kind: "group", id });
  assert.equal(lanes[0].target_queue_depth, 6);
});

test("a valid non-feed surface still writes its own lane and leaves the feed alone", async () => {
  const id = newChannel();
  await patchChannel(id, { surface: "feed", autofill_enabled: 1, min_queue_depth: 4 });
  const res = await patchChannel(id, {
    surface: "story",
    autofill_enabled: 1,
    min_queue_depth: 2,
  });

  assert.equal(res.status, 200);
  const lanes = q.getAutofillLanes({ kind: "channel", id });
  const bySurface = Object.fromEntries(lanes.map((l) => [l.surface, l.min_queue_depth]));
  assert.deepEqual(bySurface, { feed: 4, story: 2 });
});
