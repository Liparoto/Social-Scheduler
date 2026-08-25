import { parseCadence, summarize } from "./cadence";
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
 * A saved lane for a surface that is no longer on offer (an Instagram channel left the
 * group, say) is dropped here: the panel would have no switch to reach it with.
 */
export function toLanePanels(
  surfaces: Surface[],
  saved: AutofillLane[],
  bandCountsFor: (surface: Surface) => Record<string, number>,
): LanePanelData[] {
  return surfaces.map((surface) => {
    const row = saved.find((l) => l.surface === surface);
    const bandCounts = bandCountsFor(surface);
    if (!row) return { surface, ...DEFAULT_LANE, bandCounts };
    return {
      surface,
      enabled: row.enabled === 1,
      cadenceConfig: row.cadence_config,
      minQueueDepth: row.min_queue_depth,
      targetQueueDepth: row.target_queue_depth,
      reuseMinAgeDays: row.reuse_min_age_days,
      bandCounts,
    };
  });
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
