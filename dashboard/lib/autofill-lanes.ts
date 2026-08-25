import {
  DAYS,
  type Cadence,
  type CadenceSlot,
  parseCadence,
  serializeCadence,
  summarize,
} from "./cadence";
import type { AutofillLane, Surface } from "./types";

/** One lane as the config panel wants it: camelCase, `enabled` as a real boolean, and the
 *  band counts for THAT surface travelling with it. Deliberately not the SQLite row —
 *  the panel is a client component and should never learn the column names. */
export interface LanePanelData {
  surface: Surface;
  enabled: boolean;
  cadenceConfig: string | null;
  minQueueDepth: number;
  targetQueueDepth: number;
  reuseMinAgeDays: number;
  /** Ready posts per time_of_day band FOR THIS SURFACE — see getBandCounts. Feeds the
   *  coverage warning: a band with posts but no reachable slot would silently stop being
   *  auto-filled. */
  bandCounts: Record<string, number>;
  /** Whether this owner can actually SEND to this surface right now. False only for a
   *  stranded lane — one still switched on for a surface no member can take any more (see
   *  toLanePanels). The panel shows those so they can be reached; nothing else may. */
  offered: boolean;
}

/** What an unconfigured lane starts as: off, with the same defaults migration 0028 gives
 *  a hand-created row. Deliberately NOT a copy of the feed lane — a Story cadence that
 *  silently inherited the feed's times would post at the wrong hour the moment it was
 *  switched on. */
export const DEFAULT_LANE = {
  enabled: false,
  cadenceConfig: null as string | null,
  minQueueDepth: 0,
  targetQueueDepth: 0,
  reuseMinAgeDays: 180,
  bandCounts: {} as Record<string, number>,
  // laneFor's fallback is only ever asked for a surface the panel is already offering.
  offered: true,
};

/** The lane for `surface`, or a fresh disabled default when there is no row for it yet.
 *  The fallback is the whole point: the panel must be able to show a surface the owner
 *  has never configured without borrowing another surface's settings. */
export function laneFor(lanes: LanePanelData[], surface: Surface): LanePanelData {
  return lanes.find((l) => l.surface === surface) ?? { surface, ...DEFAULT_LANE };
}

const SURFACE_LABELS: Record<Surface, string> = {
  feed: "Feed",
  story: "Story",
  reel: "Reel",
};

export function surfaceLabel(surface: Surface): string {
  return SURFACE_LABELS[surface] ?? surface;
}

/**
 * Build the panel's lane list from what the DB holds.
 *
 * One entry per surface the owner can actually SEND to, whether or not a row exists yet —
 * an unsaved Story lane still needs its real band counts, or its coverage warning could
 * never fire until after the first save. `bandCountsFor` is passed in rather than
 * imported so this stays a pure function the tests can drive without a database.
 *
 * A saved lane for a surface that is no longer on offer — the only Instagram member left
 * a mixed group, say — is kept ONLY while it is still enabled, marked `offered: false`.
 * Dropping it hid a lane that is still switched on: the worker does the right thing today
 * ("no active member can take a story — skipping"), but adding an Instagram channel back
 * months later resumes Stories on a cadence the owner could neither see nor switch off.
 * It is shown as it is and never auto-disabled — this function does not edit config.
 *
 * A saved-but-disabled lane on an unoffered surface stays hidden: it cannot run and cannot
 * start running, so there is nothing to tell the owner.
 */
export function toLanePanels(
  surfaces: Surface[],
  saved: AutofillLane[],
  bandCountsFor: (surface: Surface) => Record<string, number>,
): LanePanelData[] {
  const fromRow = (row: AutofillLane, offered: boolean): LanePanelData => ({
    surface: row.surface,
    enabled: row.enabled === 1,
    cadenceConfig: row.cadence_config,
    minQueueDepth: row.min_queue_depth,
    targetQueueDepth: row.target_queue_depth,
    reuseMinAgeDays: row.reuse_min_age_days,
    bandCounts: bandCountsFor(row.surface),
    offered,
  });

  const offered = surfaces.map((surface) => {
    const row = saved.find((l) => l.surface === surface);
    return row
      ? fromRow(row, true)
      : { surface, ...DEFAULT_LANE, bandCounts: bandCountsFor(surface) };
  });
  const stranded = saved
    .filter((l) => l.enabled === 1 && !surfaces.includes(l.surface))
    .map((l) => fromRow(l, false));
  return [...offered, ...stranded];
}

/** Which surfaces the panel's switch lists: everything on offer, plus any stranded lane
 *  that has to stay reachable. Offered first, so the switch reads the same as it always
 *  did and the odd one out is last. */
export function panelSurfaces(offered: Surface[], lanes: LanePanelData[]): Surface[] {
  const extra = lanes
    .map((l) => l.surface)
    .filter((s) => !offered.includes(s));
  return [...offered, ...extra];
}

/** The note on a stranded lane. Two facts the owner cannot work out from the panel: it is
 *  not running now, and it will start again on its own if a capable channel is ever added
 *  back — which is the only reason switching it off matters. */
export function unofferedLaneNote(surface: Surface, noun: string): string {
  return (
    `Nothing in this ${noun} can post a ${surfaceLabel(surface)} right now, so this is ` +
    `not running. It is still switched on, though — add a channel that can post a ` +
    `${surfaceLabel(surface)} and it will start filling again on this schedule. ` +
    `Switch it off and save to stop that.`
  );
}

/** One lane in a line: its cadence and the depths it fills between, or "Off". */
export function laneSummary(lane: LanePanelData): string {
  if (!lane.enabled) return "Off";
  return `${summarize(parseCadence(lane.cadenceConfig))} · keep ≥${lane.minQueueDepth}, fill to ${lane.targetQueueDepth}`;
}

/**
 * The line on the collapsed panel — the only thing most visits read.
 *
 * With two lanes it names both, because "is anything posting Stories?" is otherwise a
 * question you can only answer by opening the panel and flipping the switch. With one
 * surface it drops the label entirely, so a Telegram-only channel reads exactly as it
 * did before lanes existed.
 */
export function panelSummary(lanes: LanePanelData[], surfaces: Surface[]): string {
  if (surfaces.length <= 1) return laneSummary(laneFor(lanes, surfaces[0] ?? "feed"));
  return surfaces
    .map((s) => `${surfaceLabel(s)} ${laneSummary(laneFor(lanes, s))}`)
    .join(" — ");
}

/**
 * The cadence a lane's editor OPENS on.
 *
 * An unconfigured lane (`cadenceConfig === null`) opens on times mode with NO rows, and the
 * owner adds the first one. It cannot open on a default time, because on a real install the
 * default time IS another lane's time: this install's feed lane fills at 18:00 daily, so a
 * Story lane pre-filled with 18:00 is indistinguishable from one that inherited the feed's
 * cadence — switch it on, press Save without touching the field, and Stories go out at the
 * same instant as feed posts. Lanes are independent precisely so that cannot happen.
 *
 * This is deliberately NOT `parseCadence(null)`: parseCadence has to answer *something* for
 * a malformed string a real row might hold, and 18:00 is a reasonable answer there. "Never
 * configured" is a different question, and only the lane knows it.
 */
export function initialCadence(lane: LanePanelData): Cadence {
  if (!lane.cadenceConfig) return { mode: "times", slots: [] };
  return parseCadence(lane.cadenceConfig);
}

/**
 * Why Save is refused, or null when it is allowed.
 *
 * A lane that is ON with no times has no valid cadence: the worker's `_parse_times` finds
 * nothing to merge, `parse_cadence` returns None, and the lane is skipped with "no valid
 * cadence" — switched on in the dashboard and filling nothing, which reads as broken. So
 * the empty start above must not be savable while the lane is enabled.
 *
 * Switched OFF is fine: an off lane with no times is exactly the unconfigured state, and
 * the owner may well be saving only its queue depths.
 */
export function saveBlockedReason(enabled: boolean, cadence: Cadence): string | null {
  if (!enabled) return null;
  if (cadence.mode === "times" && cadence.slots.length === 0) return "Add a time first";
  return null;
}

/** The days a newly added time row starts with: the row above it, or — for the FIRST row
 *  on an empty lane — all seven. Not an empty list: a slot with no days is dropped by the
 *  worker's `_parse_times`, so a lane whose only time had no days would silently not fill,
 *  with nothing in the UI saying so. */
export function newSlotDays(slots: CadenceSlot[]): string[] {
  const last = slots[slots.length - 1];
  return last ? [...last.days] : [...DAYS];
}

/** What the panel's Save button collects, before it becomes a request body. */
export interface LaneDraft {
  enabled: boolean;
  cadence: Cadence;
  minDepth: number;
  target: number;
  reuseDays: number;
  bpp: number;
}

/**
 * The PATCH body for saving ONE lane, on either the channel or the channel-group route.
 *
 * Two rules live here rather than in the JSX, because both are write-path correctness and
 * neither is reachable by a static render:
 *
 *  - `surface` is always named. The routes treat a body without one as feed (it predates
 *    lanes), so omitting it would silently write the Story panel's values onto the feed.
 *  - `bpp_every_days` is OMITTED on a non-feed lane, not sent unchanged. BPP recycling is
 *    an owner-level, feed-only dial — migration 0028 deliberately left the bpp_* columns
 *    off the lane — and the routes write any key that is present, so echoing it back would
 *    let the Story panel rewrite a setting it never showed.
 *
 * Every key here must be one the routes accept: upsertAutofillLane THROWS on a field
 * outside its five writable columns, so a stray key is a 500 on save.
 */
export function lanePatchBody(lane: LanePanelData, draft: LaneDraft) {
  // An empty times cadence saves as NULL, not as `{"slots":[]}`. The lane is still
  // unconfigured, and it has to READ as unconfigured on the next load — parseCadence
  // answers 18:00 for a slot list it finds empty, which would quietly put the borrowed
  // time back the moment the owner saved an off lane's queue depths.
  const empty = draft.cadence.mode === "times" && draft.cadence.slots.length === 0;
  return {
    surface: lane.surface,
    autofill_enabled: draft.enabled,
    cadence_config: empty ? null : serializeCadence(draft.cadence),
    min_queue_depth: draft.minDepth,
    target_queue_depth: draft.target,
    reuse_min_age_days: draft.reuseDays,
    ...(lane.surface === "feed" ? { bpp_every_days: draft.bpp } : {}),
  };
}
