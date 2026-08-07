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

/** Which bands a slot from this cadence could land in — the slot times in times mode, every
 *  minute of the window in interval mode (the send time drifts, so all of it is reachable).
 *  Mirrors Cadence.candidate_local_times() in worker/scheduling.py. */
export function coveredBands(c: Cadence, bandTimes: Record<string, string>): Set<string> {
  const out = new Set<string>();
  if (c.mode === "times") {
    for (const slot of c.slots) {
      if (slot.days.length) out.add(deriveBand(slot.time, bandTimes));
    }
    return out;
  }
  // An explicitly empty day list is invalid — worker/scheduling.py's _parse_interval
  // rejects it and skips the unit entirely, so no minute of the window is actually
  // reachable. Without this check the loop below would report the whole window as
  // covered for a cadence that can never fire, silencing the warning that exists to
  // catch precisely this.
  if (!c.days.length) return out;
  const start = minutesOf(c.from) ?? 0;
  const end = minutesOf(c.to) ?? 1439;
  const minutes = start <= end
    ? Array.from({ length: end - start + 1 }, (_, i) => start + i)
    : [
        ...Array.from({ length: 1440 - start }, (_, i) => start + i),
        ...Array.from({ length: end + 1 }, (_, i) => i),
      ];
  for (const m of minutes) {
    const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    out.add(deriveBand(hhmm, bandTimes));
  }
  return out;
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
