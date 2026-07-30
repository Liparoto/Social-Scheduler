// Convert a wall-clock time entered for a specific IANA timezone into a UTC ISO
// string for storage. All scheduled_at values live in UTC; the channel timezone
// governs how they're entered and displayed.

export function zonedTimeToUtc(local: string, timeZone: string): string {
  // `local` is a datetime-local value like "2026-08-01T18:00" (no zone).
  // Interpret those wall-clock digits AS-IF UTC, then subtract the target zone's
  // offset at that moment (standard Intl offset trick).
  const asIfUtc = new Date(`${local}:00Z`);
  if (Number.isNaN(asIfUtc.getTime())) {
    throw new Error(`Invalid datetime: ${local}`);
  }
  const inZone = new Date(asIfUtc.toLocaleString("en-US", { timeZone }));
  const inUtc = new Date(asIfUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const offset = inZone.getTime() - inUtc.getTime();
  return new Date(asIfUtc.getTime() - offset).toISOString();
}

/**
 * Split a UTC ISO instant into {date, time} wall-clock strings in a given IANA
 * timezone, suitable for prefilling <input type="date"> / <input type="time">.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: the latter has historically
 * resolved to the h24 cycle in some ICU builds, rendering midnight as "24:00" —
 * which is not a valid <input type="time"> value and, worse, would round-trip
 * through rebaseWallClock() below as an invalid Date.
 */
export function splitInTz(iso: string | null, timeZone: string): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  try {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d); // en-CA -> YYYY-MM-DD
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d); // en-GB -> HH:MM
    return { date, time };
  } catch {
    return { date: "", time: "" };
  }
}

/**
 * Re-interpret an instant's WALL CLOCK from one timezone into another.
 *
 * Given a UTC instant that reads as 9:00 AM in `fromTz`, return the UTC instant
 * that reads as 9:00 AM in `toTz`. This is what "keep the same clock time" means
 * when a channel's timezone is corrected: the owner scheduled a 9:00 AM post and
 * still wants a 9:00 AM post, so the stored UTC instant has to move.
 *
 * Note this is genuinely DST-aware in both directions, because it re-derives the
 * offset at the *target* wall clock rather than reusing the source's offset — the
 * two can differ by an hour when the zones' transition dates don't line up.
 *
 * Returns the input unchanged when the zones match or either is unusable, so a
 * caller can never silently corrupt a schedule on a bad zone name.
 */
export function rebaseWallClock(iso: string, fromTz: string, toTz: string): string {
  if (fromTz === toTz) return iso;
  const { date, time } = splitInTz(iso, fromTz);
  if (!date || !time) return iso;
  try {
    return zonedTimeToUtc(`${date}T${time}`, toTz);
  } catch {
    return iso;
  }
}
