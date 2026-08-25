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
import {
  activeSurface,
  initialCadence,
  lanePatchBody,
  newSlotDays,
  panelSummary,
  panelSurfaces,
  saveBlockedReason,
  unofferedLaneNote,
  toLanePanels,
} from "../lib/autofill-lanes.ts";
import { DAYS, type Cadence, parseCadence, serializeCadence } from "../lib/cadence.ts";

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
      offered: true,
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
      targetQueueDepth: 4, reuseMinAgeDays: 30, bandCounts: { evening: 2 }, offered: true },
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
  // A lane that is switched OFF for a surface no longer on offer stays hidden: it cannot
  // run and cannot start running, so there is nothing to say about it. (A lane still
  // switched ON is a different case, and is kept — see the stranded-lane tests below.)
  const saved = [
    {
      id: 1, channel_id: 5, group_id: null, surface: "story" as const, enabled: 0,
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

// ---------------------------------------------------------------------------
// What an UNCONFIGURED lane opens on. This is the half of "lanes are independent" that a
// static render cannot see: DEFAULT_LANE.cadenceConfig is null, so the editor used to fall
// back to a one-slot 18:00 cadence — and on this install the feed lane's cadence IS 18:00
// daily, which made the fallback indistinguishable from inheritance. Enable Story, press
// Save without touching the time, and Stories go out at the same instant as feed posts.
// An unconfigured lane now opens with NO time rows, so the owner has to state the time.

test("an unconfigured lane opens with no time rows at all, rather than a borrowed 18:00", () => {
  const cadence = initialCadence(laneFor([], "story"));
  assert.equal(cadence.mode, "times");
  assert.deepEqual(
    cadence.mode === "times" ? cadence.slots : null,
    [],
    "any pre-filled time here is a time the owner never chose",
  );
});

test("a lane with a SAVED cadence still opens on exactly what was saved", () => {
  const lanes = toLanePanels(
    ["feed"],
    [
      {
        id: 1, channel_id: 5, group_id: null, surface: "feed" as const, enabled: 1,
        cadence_config: '{"slots":[{"time":"07:30","days":["mon"]}]}',
        min_queue_depth: 3, target_queue_depth: 7, reuse_min_age_days: 90,
      },
    ],
    () => ({}),
  );
  assert.deepEqual(initialCadence(laneFor(lanes, "feed")), {
    mode: "times",
    slots: [{ time: "07:30", days: ["mon"] }],
  });
});

test("a saved interval lane is untouched — the empty start is times-mode only", () => {
  const lanes = toLanePanels(
    ["feed"],
    [
      {
        id: 1, channel_id: 5, group_id: null, surface: "feed" as const, enabled: 1,
        cadence_config: '{"mode":"interval","every_minutes":720,"window":{"from":"08:00","to":"20:00"},"days":["mon"]}',
        min_queue_depth: 3, target_queue_depth: 7, reuse_min_age_days: 90,
      },
    ],
    () => ({}),
  );
  const cadence = initialCadence(laneFor(lanes, "feed"));
  assert.equal(cadence.mode, "interval");
});

// A lane that is ON with no cadence is skipped by the worker with "no valid cadence" and
// looks broken from the dashboard, so it must not be savable in the first place.

test("an ENABLED lane with no times cannot be saved, and the reason says what to do", () => {
  const reason = saveBlockedReason(true, { mode: "times", slots: [] });
  assert.ok(reason, "an enabled lane with no cadence must not be silently savable");
  assert.match(String(reason), /time/i);
});

test("a lane that is switched OFF saves fine with no times — there is nothing to run", () => {
  assert.equal(saveBlockedReason(false, { mode: "times", slots: [] }), null);
});

test("nothing is blocked once a time exists, or in interval mode", () => {
  assert.equal(saveBlockedReason(true, DEFAULT_TIMES), null);
  assert.equal(saveBlockedReason(true, DEFAULT_INTERVAL), null);
});

// The first "+ Add a time" on an empty lane has no previous row to copy days from. All
// seven, not none: a slot with no days is DROPPED by the worker's _parse_times, leaving
// parse_cadence returning None and the lane silently not filling at all.

test("the first added time carries all seven days, not an empty day list", () => {
  assert.deepEqual(newSlotDays([]), [...DAYS]);
});

test("a later added time copies the days of the row above it, as it always did", () => {
  assert.deepEqual(newSlotDays([{ time: "09:00", days: ["mon", "fri"] }]), ["mon", "fri"]);
});

// And an unconfigured lane that is saved while still empty must stay unconfigured. Writing
// `{"slots":[]}` would parse back to the 18:00 default on the next load and quietly put the
// borrowed time back.

test("saving an empty times cadence writes NULL, so the lane stays unconfigured", () => {
  const body = lanePatchBody(laneFor([], "story"), {
    enabled: false,
    cadence: { mode: "times", slots: [] },
    minDepth: 0,
    target: 0,
    reuseDays: 180,
    bpp: 0,
  });
  assert.equal(body.cadence_config, null);
});

// ---------------------------------------------------------------------------
// A saved lane whose surface stopped being offered. Remove the only Instagram member from
// a mixed group and the Story lane's ROW survives while the panel stops listing it: the
// worker correctly does nothing ("no active member can take a story — skipping"), but the
// lane is still switched on, so re-adding an Instagram channel months later resumes Stories
// on a cadence the owner can neither see nor switch off. It stays reachable, and is never
// auto-disabled — the owner's config is theirs to change.

const STRANDED_STORY = {
  id: 9, channel_id: null, group_id: 3, surface: "story" as const, enabled: 1,
  cadence_config: '{"slots":[{"time":"12:00","days":["mon"]}]}',
  min_queue_depth: 1, target_queue_depth: 4, reuse_min_age_days: 30,
};

test("an ENABLED lane on a surface no longer offered is still shown, so it can be switched off", () => {
  const panels = toLanePanels(["feed"], [STRANDED_STORY], () => ({}));
  assert.deepEqual(panels.map((p) => p.surface), ["feed", "story"]);
  const story = laneFor(panels, "story");
  assert.equal(story.enabled, true, "shown as it is — never quietly turned off for them");
  assert.equal(story.cadenceConfig, STRANDED_STORY.cadence_config);
});

test("the unoffered lane is marked as such, and the offered ones are not", () => {
  const panels = toLanePanels(["feed"], [STRANDED_STORY], () => ({}));
  assert.equal(laneFor(panels, "feed").offered, true);
  assert.equal(laneFor(panels, "story").offered, false);
});

test("a DISABLED lane on a surface no longer offered stays hidden — nothing to warn about", () => {
  const panels = toLanePanels(
    ["feed"],
    [{ ...STRANDED_STORY, enabled: 0 }],
    () => ({}),
  );
  assert.deepEqual(panels.map((p) => p.surface), ["feed"]);
});

test("a surface that is neither offered nor saved is never invented", () => {
  const panels = toLanePanels(["feed"], [], () => ({}));
  assert.deepEqual(panels.map((p) => p.surface), ["feed"]);
});

test("an offered surface is unaffected, saved or not", () => {
  const panels = toLanePanels(["feed", "story"], [STRANDED_STORY], () => ({}));
  assert.deepEqual(panels.map((p) => p.surface), ["feed", "story"], "no duplicate story");
  assert.equal(laneFor(panels, "story").offered, true);
  assert.equal(laneFor(panels, "story").enabled, true);
  assert.equal(laneFor(panels, "feed").offered, true, "unsaved but offered is still offered");
});

// The switch has to list the stranded lane too, or "still in the panel" means nothing.

test("the surface switch lists offered surfaces plus any stranded lane, offered first", () => {
  const panels = toLanePanels(["feed"], [STRANDED_STORY], () => ({}));
  assert.deepEqual(panelSurfaces(["feed"], panels), ["feed", "story"]);
  assert.deepEqual(
    panelSurfaces(["feed", "story"], toLanePanels(["feed", "story"], [STRANDED_STORY], () => ({}))),
    ["feed", "story"],
    "an offered surface is never listed twice",
  );
  assert.deepEqual(panelSurfaces(["feed"], toLanePanels(["feed"], [], () => ({}))), ["feed"]);
});

test("the note says why it cannot run and what switching it off buys, in plain words", () => {
  const note = unofferedLaneNote("story", "group");
  assert.match(note, /Story/);
  assert.match(note, /group/);
  // The two things the owner cannot work out on their own: it is not running now, and it
  // WILL start again by itself if a capable channel is ever added.
  assert.match(note, /not running|cannot run/i);
  assert.match(note, /again|resume/i);
  assert.doesNotMatch(note, /surface|lane|autofill_lanes/i, "panel copy is plain English");
});

test("the collapsed panel of a feed-only group still reports a stranded Story lane", () => {
  // The one part of the wiring a static render CAN see: the panel keys off offered
  // surfaces PLUS stranded lanes, so the summary names a lane props.surfaces omits.
  const html = renderToStaticMarkup(
    React.createElement(AutofillConfig, {
      target: { kind: "group" as const, id: 3 },
      lanes: toLanePanels(["feed"], [STRANDED_STORY], () => ({})),
      surfaces: ["feed"] as const,
      bppEveryDays: 0,
      bppPoolSize: 0,
      bandTimes: { morning: "09:00", afternoon: "13:00", evening: "18:00" },
    }),
  );
  assert.match(html, /Story/, "a lane that is still switched on must not vanish");
  assert.match(html, /12:00/, "and its cadence has to be visible, not just its name");
});

// ---------------------------------------------------------------------------
// Every cadence shape the WORKER will refuse. worker/scheduling.py's parse_cadence is the
// authority: _parse_times drops any slot whose time is unparseable OR whose day list is
// empty, and returns None when nothing survives; _parse_interval returns None for a
// non-positive every_minutes and for an explicitly empty `days` key. A lane skipped with
// "no valid cadence" sits switched on in the dashboard and fills nothing — which is
// exactly what the pre-lane default did (cadence.ts's DEFAULT is 18:00 with days: []).
//
// saveBlockedReason judges the SERIALIZED cadence, because serializeCadence is what the
// worker will actually read.

test("a time with no days selected is blocked — this is the old default's exact shape", () => {
  const reason = saveBlockedReason(true, {
    mode: "times",
    slots: [{ time: "18:00", days: [] }],
  });
  assert.ok(reason, "the worker drops a slot with no days, leaving no valid cadence");
  assert.match(String(reason), /day/i, "name the actual problem, not 'invalid cadence'");
});

test("several times, none of them with a day, is still blocked", () => {
  assert.match(
    String(saveBlockedReason(true, {
      mode: "times",
      slots: [{ time: "09:00", days: [] }, { time: "18:00", days: [] }],
    })),
    /day/i,
  );
});

test("one time with a day is enough — the worker keeps that slot and drops the rest", () => {
  assert.equal(
    saveBlockedReason(true, {
      mode: "times",
      slots: [{ time: "09:00", days: [] }, { time: "18:00", days: ["sat"] }],
    }),
    null,
  );
});

test("a blank time on the only row is blocked, and says so rather than blaming the days", () => {
  // serializeCadence drops it (mirroring _parse_hhmm), so the saved cadence has no slots.
  const reason = saveBlockedReason(true, { mode: "times", slots: [{ time: "", days: [...DAYS] }] });
  assert.ok(reason);
  assert.match(String(reason), /time/i);
});

// Interval mode. Reachable: the form's DayToggles let every day be unchecked, and
// serializeCadence ALWAYS writes the `days` key — which is the case _parse_interval
// explicitly rejects rather than widening to all week.

// DEFAULT_INTERVAL is typed as the Cadence UNION, so spreading it loses the discriminant.
// Narrowed once here rather than cast at every use.
const INTERVAL = DEFAULT_INTERVAL as Extract<Cadence, { mode: "interval" }>;

test("an interval with every day unchecked is blocked", () => {
  const reason = saveBlockedReason(true, { ...INTERVAL, days: [] });
  assert.ok(reason, "an explicitly empty day list makes _parse_interval return None");
  assert.match(String(reason), /day/i);
});

test("an interval of zero is blocked", () => {
  const reason = saveBlockedReason(true, { ...INTERVAL, everyMinutes: 0 });
  assert.ok(reason, "_parse_interval refuses every_minutes <= 0");
  assert.doesNotMatch(String(reason), /day/i, "the days are fine — say what is wrong");
});

test("an interval keeps saving on any single day, and on a short-but-positive gap", () => {
  assert.equal(saveBlockedReason(true, { ...INTERVAL, days: ["wed"] }), null);
  // 5 minutes is under the form's own 15-minute floor but is a cadence the worker WILL
  // run. This gate is about "no valid cadence", not about every rule the panel has.
  assert.equal(saveBlockedReason(true, { ...INTERVAL, everyMinutes: 5 }), null);
});

// The escape hatch. Turning something OFF must never be blocked, whatever state it is in —
// a lane the owner is switching off is precisely the one most likely to be half-configured.

test("a DISABLED lane saves in every blocked shape", () => {
  const broken: Cadence[] = [
    { mode: "times", slots: [] },
    { mode: "times", slots: [{ time: "18:00", days: [] }] },
    { mode: "times", slots: [{ time: "", days: [...DAYS] }] },
    { ...INTERVAL, days: [] },
    { ...INTERVAL, everyMinutes: 0 },
  ];
  for (const cadence of broken) {
    assert.equal(saveBlockedReason(false, cadence), null,
      `switching a lane off must never be blocked: ${JSON.stringify(cadence)}`);
  }
});

// ---------------------------------------------------------------------------
// Item 2's own exit path. `surface` is client state; `shown` is derived from props. Switch
// the stranded Story lane off and Save, and router.refresh() re-renders WITHOUT remounting:
// props.lanes loses the Story entry, so `shown` drops to ["feed"] and the switch disappears
// — while `surface` is still "story". Keyed on that stale value, the editor stays mounted
// on a lane laneFor can no longer find, falls back to DEFAULT_LANE (offered: true, so even
// the note goes), and a second Save writes cadence_config null and depths 0 over the row
// the owner just disabled. The successful exit becomes a trap that then overwrites the row.
//
// The fix is a derivation, not more state: a selection that is no longer shown falls back
// to the first surface that is.

test("a selected surface that is still shown is left alone", () => {
  assert.equal(activeSurface(["feed", "story"], "story"), "story");
  assert.equal(activeSurface(["feed", "story"], "feed"), "feed");
});

test("a selection that stops being shown falls back — this is the switched-off stranded lane", () => {
  assert.equal(
    activeSurface(["feed"], "story"),
    "feed",
    "after the Story row is disabled the editor must land on Feed, not on a ghost lane",
  );
});

test("an empty shown list still resolves to a real surface rather than undefined", () => {
  assert.equal(activeSurface([], "story"), "feed");
});

test("a row whose time is blank also saves as NULL, not as an empty slot list", () => {
  // The `empty` test has to judge the SERIALIZED cadence, not the rows in hand:
  // serializeCadence drops a slot whose time is not HH:MM, so one blank row yields
  // {"mode":"times","slots":[]} — which parseCadence reads back as the phantom 18:00 on
  // the next load. Enabled lanes are blocked from saving this, but a DISABLED one is not,
  // and that is enough to put the borrowed time back.
  const body = lanePatchBody(laneFor([], "story"), {
    enabled: false,
    cadence: { mode: "times", slots: [{ time: "", days: [...DAYS] }] },
    minDepth: 0,
    target: 0,
    reuseDays: 180,
    bpp: 0,
  });
  assert.equal(body.cadence_config, null);
});

test("an interval cadence is never mistaken for an empty one", () => {
  const body = lanePatchBody(laneFor([], "feed"), {
    enabled: true, cadence: DEFAULT_INTERVAL, minDepth: 0, target: 0, reuseDays: 180, bpp: 0,
  });
  assert.equal(body.cadence_config, serializeCadence(DEFAULT_INTERVAL));
});
