import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AutofillConfig,
  DEFAULT_INTERVAL,
  DEFAULT_LANE,
  DEFAULT_TIMES,
  laneFor,
} from "../components/autofill-config.tsx";
import { lanePatchBody, panelSummary, toLanePanels } from "../lib/autofill-lanes.ts";
import { DAYS, parseCadence, serializeCadence } from "../lib/cadence.ts";

// The two mode defaults are what the owner lands on the first time they switch modes — the
// stored cadence is one mode, so the OTHER mode has nothing to restore and falls back here.
// A cadence with no days is dropped by the worker (_parse_times / _parse_interval drop it,
// parse_cadence returns None) and the unit silently stops auto-filling with nothing in the
// UI saying so. Neither default may ship an empty day list.

test("both mode defaults carry all seven days, so switching modes cannot save a dead cadence", () => {
  const times = JSON.parse(serializeCadence(DEFAULT_TIMES));
  assert.equal(times.mode, "times");
  assert.equal(times.slots.length, 1);
  assert.deepEqual(times.slots[0].days, [...DAYS]);

  const interval = JSON.parse(serializeCadence(DEFAULT_INTERVAL));
  assert.equal(interval.mode, "interval");
  assert.deepEqual(interval.days, [...DAYS]);
});

test("both mode defaults survive a serialize/parse round trip unchanged", () => {
  assert.deepEqual(parseCadence(serializeCadence(DEFAULT_TIMES)), DEFAULT_TIMES);
  assert.deepEqual(parseCadence(serializeCadence(DEFAULT_INTERVAL)), DEFAULT_INTERVAL);
});

// ---------------------------------------------------------------------------
// Lanes. Auto-fill is now one cadence per (owner, SURFACE): a feed rotation and a Story
// rotation run side by side on the same account. The panel edits one lane at a time, so
// everything below is about picking the right lane and — more importantly — about what a
// surface that has never been configured is allowed to show.

test("a surface with no saved lane falls back to a disabled default, not to the feed's settings", () => {
  const lanes = [
    {
      surface: "feed" as const,
      enabled: true,
      cadenceConfig: '{"days":["mon"],"time":"18:00"}',
      minQueueDepth: 3,
      targetQueueDepth: 7,
      reuseMinAgeDays: 90,
      bandCounts: {},
    },
  ];
  const story = laneFor(lanes, "story");
  assert.equal(story.enabled, false, "an unconfigured lane must never start switched on");
  assert.equal(story.cadenceConfig, DEFAULT_LANE.cadenceConfig);
  assert.notEqual(story.targetQueueDepth, 7, "must not inherit the feed's depths");
});

test("laneFor returns the saved lane when there is one", () => {
  const lanes = [
    { surface: "story" as const, enabled: true, cadenceConfig: "{}", minQueueDepth: 1,
      targetQueueDepth: 4, reuseMinAgeDays: 30, bandCounts: { evening: 2 } },
  ];
  assert.equal(laneFor(lanes, "story").targetQueueDepth, 4);
  assert.deepEqual(laneFor(lanes, "story").bandCounts, { evening: 2 });
});

// toLanePanels is what the two server pages call. It exists so the panel is handed an
// entry for EVERY surface it offers — including one with no row in autofill_lanes yet —
// because the band-coverage warning needs that surface's real queue counts before the
// lane has ever been saved, and because the defaults must be stated in exactly one place.

test("toLanePanels gives every offered surface an entry, with that surface's own band counts", () => {
  const saved = [
    {
      id: 1, channel_id: 5, group_id: null, surface: "feed" as const, enabled: 1,
      cadence_config: '{"slots":[{"time":"18:00","days":["mon"]}]}',
      min_queue_depth: 3, target_queue_depth: 7, reuse_min_age_days: 90,
    },
  ];
  const counts: Record<string, Record<string, number>> = {
    feed: { evening: 4 },
    story: { morning: 2 },
  };
  const panels = toLanePanels(["feed", "story"], saved, (s) => counts[s] ?? {});

  assert.deepEqual(panels.map((p) => p.surface), ["feed", "story"]);
  const feed = laneFor(panels, "feed");
  assert.equal(feed.enabled, true, "enabled is 0/1 in SQLite and a boolean in the panel");
  assert.equal(feed.targetQueueDepth, 7);
  assert.deepEqual(feed.bandCounts, { evening: 4 });

  const story = laneFor(panels, "story");
  assert.equal(story.enabled, false);
  assert.equal(story.targetQueueDepth, DEFAULT_LANE.targetQueueDepth);
  assert.deepEqual(
    story.bandCounts,
    { morning: 2 },
    "an unsaved lane still needs real counts, or its coverage warning can never fire",
  );
});

test("toLanePanels never offers a surface the owner cannot send to", () => {
  const saved = [
    {
      id: 1, channel_id: 5, group_id: null, surface: "story" as const, enabled: 1,
      cadence_config: null, min_queue_depth: 1, target_queue_depth: 2,
      reuse_min_age_days: 30,
    },
  ];
  const panels = toLanePanels(["feed"], saved, () => ({}));
  assert.deepEqual(panels.map((p) => p.surface), ["feed"]);
});

// The collapsed header is the only thing most visits read. With two lanes it has to say
// what BOTH are doing, or the owner has to open and toggle the panel to find out whether
// Stories are running at all.

test("the collapsed summary names each surface when more than one is on offer", () => {
  const panels = toLanePanels(
    ["feed", "story"],
    [
      {
        id: 1, channel_id: 5, group_id: null, surface: "feed" as const, enabled: 1,
        cadence_config: '{"slots":[{"time":"18:00","days":["mon","tue","wed","thu","fri","sat","sun"]}]}',
        min_queue_depth: 3, target_queue_depth: 7, reuse_min_age_days: 90,
      },
    ],
    () => ({}),
  );
  const summary = panelSummary(panels, ["feed", "story"]);
  assert.match(summary, /Feed/);
  assert.match(summary, /Story/);
  assert.match(summary, /18:00/);
  assert.match(summary, /Story\s+Off/, "an unconfigured Story lane reads Off, not blank");
});

test("a single-surface panel's summary is unprefixed, exactly as before lanes existed", () => {
  const panels = toLanePanels(["feed"], [], () => ({}));
  assert.equal(panelSummary(panels, ["feed"]), "Off");
  assert.ok(!panelSummary(panels, ["feed"]).includes("Feed"),
    "a Telegram-only channel must not grow a surface label it can do nothing with");
});

// renderToStaticMarkup gives markup only — it cannot click the Feed·Story switch, so the
// switch itself is browser-verified and the lane logic above is tested as pure functions.
// What these pin is the collapsed panel: the one part of it a static render CAN see, and
// the part every visit to the page reads.

test("the collapsed panel reports both lanes without being opened", () => {
  const lanes = toLanePanels(
    ["feed", "story"],
    [
      {
        id: 1, channel_id: 5, group_id: null, surface: "feed" as const, enabled: 1,
        cadence_config: '{"slots":[{"time":"18:00","days":["mon"]}]}',
        min_queue_depth: 3, target_queue_depth: 7, reuse_min_age_days: 90,
      },
    ],
    () => ({}),
  );
  const html = renderToStaticMarkup(
    React.createElement(AutofillConfig, {
      target: { kind: "channel" as const, id: 5 },
      lanes,
      surfaces: ["feed", "story"] as const,
      bppEveryDays: 0,
      bppPoolSize: 0,
      bandTimes: { morning: "09:00", afternoon: "13:00", evening: "18:00" },
    }),
  );
  assert.match(html, /Auto-fill/);
  assert.match(html, /Feed/);
  assert.match(html, /Story/);
  assert.match(html, /18:00/);
  // Collapsed: no editor, and so no lane can be saved by accident from a closed panel.
  assert.doesNotMatch(html, /<input/);
});

test("a single-surface channel's collapsed panel is exactly what it always was", () => {
  const html = renderToStaticMarkup(
    React.createElement(AutofillConfig, {
      target: { kind: "channel" as const, id: 9 },
      lanes: toLanePanels(["feed"], [], () => ({})),
      surfaces: ["feed"] as const,
      bppEveryDays: 0,
      bppPoolSize: 0,
      bandTimes: { morning: "09:00", afternoon: "13:00", evening: "18:00" },
    }),
  );
  assert.match(html, /Auto-fill/);
  assert.match(html, /Off/);
  assert.doesNotMatch(html, /Story/, "no Story lane is offered where none can fire");
  assert.doesNotMatch(html, /Feed/, "and no surface label appears where there is no choice");
});

// ---------------------------------------------------------------------------
// The PATCH body. This is the half of "BPP is feed-only" that can actually corrupt saved
// state: BPP recycling is an OWNER-level dial (migration 0028 deliberately kept the bpp_*
// columns off the lane), so a Story save that echoed it back would let a panel rewrite a
// setting it never showed. Omitted, not sent-unchanged — the routes only write a key that
// is present.

const LANE_PATCH_KEYS = [
  "surface",
  "autofill_enabled",
  "cadence_config",
  "min_queue_depth",
  "target_queue_depth",
  "reuse_min_age_days",
  "bpp_every_days",
];

const patchInput = {
  enabled: true,
  cadence: DEFAULT_TIMES,
  minDepth: 3,
  target: 7,
  reuseDays: 90,
  bpp: 14,
};

test("a Story save omits bpp_every_days entirely, rather than echoing it back", () => {
  const body = lanePatchBody(laneFor([], "story"), patchInput);
  assert.equal(body.surface, "story", "without this the routes default the write to feed");
  assert.equal(
    "bpp_every_days" in body,
    false,
    "present-but-unchanged is not good enough: the routes write any key that is present",
  );
});

test("a feed save carries bpp_every_days", () => {
  const body = lanePatchBody(laneFor([], "feed"), patchInput);
  assert.equal("bpp_every_days" in body, true);
  assert.equal(body.bpp_every_days, 14);
});

test("the body never carries a key the routes do not accept", () => {
  // upsertAutofillLane THROWS on a key outside its five writable fields, so an extra key
  // here is a 500 on save, not a silently ignored field.
  for (const surface of ["feed", "story"] as const) {
    for (const key of Object.keys(lanePatchBody(laneFor([], surface), patchInput))) {
      assert.ok(LANE_PATCH_KEYS.includes(key), `unexpected key in the PATCH body: ${key}`);
    }
  }
});

test("the serialized body is exactly what the panel sent before it was extracted", () => {
  // Pins the shape AND the key order, so the extraction cannot quietly change the wire
  // payload the two PATCH routes already parse.
  assert.equal(
    JSON.stringify(lanePatchBody(laneFor([], "feed"), patchInput)),
    `{"surface":"feed","autofill_enabled":true,"cadence_config":${JSON.stringify(
      serializeCadence(DEFAULT_TIMES),
    )},"min_queue_depth":3,"target_queue_depth":7,"reuse_min_age_days":90,"bpp_every_days":14}`,
  );
  assert.equal(
    JSON.stringify(lanePatchBody(laneFor([], "story"), patchInput)),
    `{"surface":"story","autofill_enabled":true,"cadence_config":${JSON.stringify(
      serializeCadence(DEFAULT_TIMES),
    )},"min_queue_depth":3,"target_queue_depth":7,"reuse_min_age_days":90}`,
  );
});
