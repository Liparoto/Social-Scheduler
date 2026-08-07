export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const BAND_ORDER = ["morning", "afternoon", "evening"] as const;

export type Band = (typeof BAND_ORDER)[number];
export type CadenceSlot = { time: string; days: string[] };
export type Cadence =
  | { mode: "times"; slots: CadenceSlot[] }
  | { mode: "interval"; everyMinutes: number; from: string; to: string; days: string[] };

const DEFAULT: Cadence = { mode: "times", slots: [{ time: "18:00", days: [] }] };

function minutesOf(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function cleanDays(days: unknown): string[] {
  if (!Array.isArray(days)) return [];
  return DAYS.filter((d) => days.includes(d));
}

/** Mirrors worker/time_of_day.py derive_band: nearest band time by absolute clock-minute
 *  distance, NO midnight wraparound, ties to the earlier band. Kept identical so the label
 *  the form prints can never disagree with the slot the worker actually fills. */
export function deriveBand(time: string, bandTimes: Record<string, string>): Band {
  const at = minutesOf(time) ?? 0;
  let best: Band = BAND_ORDER[0];
  let bestDistance: number | null = null;
  for (const band of BAND_ORDER) {
    const target = minutesOf(bandTimes[band]) ?? 0;
    const distance = Math.abs(at - target);
    if (bestDistance === null || distance < bestDistance) {
      bestDistance = distance;
      best = band;
    }
  }
  return best;
}

export function parseCadence(raw: string | null): Cadence {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw || "");
  } catch {
    return DEFAULT;
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return DEFAULT;

  if (cfg.mode === "interval") {
    const window = (cfg.window ?? {}) as Record<string, string>;
    return {
      mode: "interval",
      everyMinutes: Number(cfg.every_minutes) > 0 ? Number(cfg.every_minutes) : 1440,
      from: minutesOf(window.from) === null ? "00:00" : window.from,
      to: minutesOf(window.to) === null ? "23:59" : window.to,
      days: "days" in cfg ? cleanDays(cfg.days) : [...DAYS],
    };
  }

  if (Array.isArray(cfg.slots)) {
    const slots = (cfg.slots as Record<string, unknown>[])
      .filter((s) => s && minutesOf(s.time as string) !== null)
      .map((s) => ({ time: s.time as string, days: cleanDays(s.days) }));
    return slots.length ? { mode: "times", slots } : DEFAULT;
  }

  // The two shapes that predate per-time days: every time shares one day list.
  const shared = cleanDays(cfg.days);
  const times = Array.isArray(cfg.times) && cfg.times.length
    ? (cfg.times as string[])
    : cfg.time
      ? [cfg.time as string]
      : ["18:00"];
  return {
    mode: "times",
    slots: times
      .filter((t) => minutesOf(t) !== null)
      .map((t) => ({ time: t, days: [...shared] })),
  };
}

export function serializeCadence(c: Cadence): string {
  if (c.mode === "interval") {
    return JSON.stringify({
      mode: "interval",
      every_minutes: c.everyMinutes,
      window: { from: c.from, to: c.to },
      days: c.days,
    });
  }
  return JSON.stringify({
    mode: "times",
    slots: [...c.slots]
      .filter((s) => minutesOf(s.time) !== null)
      .sort((a, b) => (minutesOf(a.time) ?? 0) - (minutesOf(b.time) ?? 0)),
  });
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x;
}

/** How far apart, in minutes, the clock times an interval cadence can land on are.
 *
 *  Stepping by `everyMinutes` only ever reaches the residues of that interval modulo a day,
 *  and those sit exactly gcd(everyMinutes, 1440) minutes apart across the whole 24 hours.
 *  Every 24h -> 1440 (one time of day). Every 12h -> 720 (two). Every 9h45m -> 45 (32). */
export function intervalStepMinutes(everyMinutes: number): number {
  return gcd(everyMinutes, 1440) || 1440;
}

/** How many distinct clock times an interval cadence can ever land on. */
export function intervalTimesPerDay(everyMinutes: number): number {
  return 1440 / intervalStepMinutes(everyMinutes);
}

/** Which bands a slot from this cadence is GUARANTEED to land in.
 *
 *  Times mode: the bands of its slot times, exactly — the same answer the worker gets.
 *
 *  Interval mode: NOT the whole window. The reachable clock times are only the
 *  `intervalTimesPerDay` residues of the interval, and WHICH ones depends on the phase — the
 *  last scheduled send, which lives in the database and is unknowable from a form. So this
 *  answers the only honest question available here: which bands are covered for EVERY
 *  possible phase. A 24h interval guarantees nothing, so nothing is suppressed and the
 *  coverage warning stands; an interval that genuinely drifts (residues <= 60 min apart)
 *  guarantees every band its window touches, exactly as before.
 *
 *  This DIVERGES from worker/autofill.py `_covered_bands` on purpose, and only in interval
 *  mode: the worker has `after`, so it computes the exact reachable set instead of this lower
 *  bound. `deriveBand` itself still mirrors the worker's `derive_band` byte for byte. */
export function coveredBands(c: Cadence, bandTimes: Record<string, string>): Set<string> {
  const out = new Set<string>();
  if (c.mode === "times") {
    for (const slot of c.slots) {
      if (slot.days.length) out.add(deriveBand(slot.time, bandTimes));
    }
    return out;
  }
  // An explicitly empty day list is invalid — worker/scheduling.py's _parse_interval
  // rejects it and skips the unit entirely, so nothing is reachable at all. Without this
  // check the sweep below would report bands as covered for a cadence that can never fire,
  // silencing the warning that exists to catch precisely this.
  if (!c.days.length) return out;
  const start = minutesOf(c.from) ?? 0;
  const end = minutesOf(c.to) ?? 1439;
  const inWindow = (m: number) =>
    start <= end ? m >= start && m <= end : m >= start || m <= end;

  const step = intervalStepMinutes(c.everyMinutes);
  let guaranteed: Set<string> | null = null;
  for (let phase = 0; phase < step; phase++) {
    const bands = new Set<string>();
    for (let m = phase; m < 1440; m += step) {
      if (!inWindow(m)) continue;
      const hhmm =
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      bands.add(deriveBand(hhmm, bandTimes));
    }
    // Intersect: a band only counts as covered if no phase can miss it.
    if (guaranteed === null) {
      guaranteed = bands;
    } else {
      const previous: Set<string> = guaranteed;
      guaranteed = new Set<string>([...previous].filter((b) => bands.has(b)));
    }
    if (!guaranteed.size) return guaranteed;
  }
  return guaranteed ?? out;
}

/** The sentence under the interval inputs saying what this interval actually does.
 *
 *  Three cases, keyed off how far apart the reachable clock times are — NOT off
 *  `everyMinutes % 1440`, which is true only for whole days and so promised a sweep for
 *  every 12h, an interval that lands at one time forever. */
export function intervalNote(everyMinutes: number): string {
  const step = intervalStepMinutes(everyMinutes);
  const perDay = 1440 / step;
  if (perDay === 1) {
    return "A whole number of days — this always lands at the same time."
      + " Use “At set times” unless you meant to drift.";
  }
  if (step > 60) {
    return `This lands at only ${perDay} times of day, ${gapLabel(step)} apart —`
      + " and which ones depends on when the last send was scheduled, so tagged posts may"
      + " not be reachable.";
  }
  return "The post time drifts by this interval each time, so it sweeps through every hour"
    + " of the window over several days instead of landing at a fixed time.";
}

/** The coverage warning for one band with content and no reachable slot. Mode-aware: in
 *  times mode the cadence definitively has no such time; in interval mode it may or may not
 *  land there depending on a phase the dashboard cannot see, so the wording says "may". */
export function uncoveredBandWarning(
  band: string,
  count: number,
  mode: Cadence["mode"],
): string {
  const subject = count === 1 ? `1 ready post is tagged ${band}` : `${count} ready posts are tagged ${band}`;
  const them = count === 1 ? "it" : "they";
  return mode === "times"
    ? `${subject} — no ${band} time set, so ${them} will not be auto-filled.`
    : `${subject} — this interval is not guaranteed to land in the ${band}, so ${them} may not be auto-filled.`;
}

function gapLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function labelDays(days: string[]): string {
  if (days.length === 7) return "daily";
  if (!days.length) return "no days";
  return DAYS.filter((d) => days.includes(d))
    .map((d) => d[0].toUpperCase() + d.slice(1))
    .join("/");
}

export function summarize(c: Cadence): string {
  if (c.mode === "interval") {
    const h = Math.floor(c.everyMinutes / 60);
    const m = c.everyMinutes % 60;
    return `Every ${h}h ${m}m, ${c.from}–${c.to}, ${labelDays(c.days)}`;
  }
  return [...c.slots]
    .sort((a, b) => (minutesOf(a.time) ?? 0) - (minutesOf(b.time) ?? 0))
    .map((s) => `${s.time} ${labelDays(s.days)}`)
    .join(", ");
}
