import { zonedTimeToUtc } from "./time";

/**
 * Bulk cadence: N slots at a fixed interval (every `everyDays` days at `time`),
 * starting from `startDate`, each interpreted in the channel's timezone and returned
 * as UTC ISO strings. DST-safe because each slot re-derives its zone offset.
 */
export function intervalSlots(
  startDate: string, // "YYYY-MM-DD"
  time: string, // "HH:MM"
  everyDays: number,
  count: number,
  timeZone: string
): string[] {
  const [y, m, d] = startDate.split("-").map(Number);
  const slots: string[] = [];
  for (let i = 0; i < count; i++) {
    const base = new Date(Date.UTC(y, m - 1, d));
    base.setUTCDate(base.getUTCDate() + i * everyDays);
    const yy = base.getUTCFullYear();
    const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(base.getUTCDate()).padStart(2, "0");
    slots.push(zonedTimeToUtc(`${yy}-${mm}-${dd}T${time}`, timeZone));
  }
  return slots;
}
