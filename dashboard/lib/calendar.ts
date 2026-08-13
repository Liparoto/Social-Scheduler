/**
 * Calendar date maths, and where a send belongs on the grid.
 *
 * Everything here works on plain YYYY-MM-DD calendar dates rather than instants. A grid
 * square is a calendar day, not a span of time, and doing the arithmetic on Date objects
 * in local time is how "add one day" becomes 23 or 25 hours across a DST boundary and a
 * week quietly shows the same day twice. Date.UTC has no such transitions, so it is the
 * right tool even though none of these values is really UTC.
 */
import { splitInTz } from "./time";
import { sendTime } from "./send-time";

const DAY_MS = 86_400_000;

function parse(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function key(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  return key(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function toUtcMs(date: string): number {
  const p = parse(date);
  if (!p) return NaN;
  return Date.UTC(p.y, p.m - 1, p.d);
}

/** Days in a month, 1-indexed month. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date: string, n: number): string {
  const ms = toUtcMs(date);
  if (Number.isNaN(ms)) return date;
  return fromUtcMs(ms + n * DAY_MS);
}

/** The Sunday on or before `date`. */
export function startOfWeek(date: string): string {
  const ms = toUtcMs(date);
  if (Number.isNaN(ms)) return date;
  return fromUtcMs(ms - new Date(ms).getUTCDay() * DAY_MS);
}

/** The seven days of `date`'s week, Sunday first. */
export function weekDays(date: string): string[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** "YYYY-MM" — which month a cell belongs to, for dimming the grid's edges. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * Six rows of seven days covering `date`'s month.
 *
 * Always six rows, even when five would cover the month: a grid that changes height as
 * you page makes the whole page jump under the cursor, and the next month's button moves
 * out from under you mid-click.
 */
export function monthGrid(date: string): string[][] {
  const p = parse(date);
  if (!p) return [];
  const first = key(p.y, p.m, 1);
  const start = startOfWeek(first);
  return Array.from({ length: 6 }, (_, row) =>
    Array.from({ length: 7 }, (_, col) => addDays(start, row * 7 + col))
  );
}

/**
 * Page by whole months, clamping the day to one the target month actually has.
 *
 * Without the clamp, +1 month from 31 January asks for 31 February, which rolls over into
 * March and skips a month entirely every time you page past a short one.
 */
export function shiftMonth(date: string, delta: number): string {
  const p = parse(date);
  if (!p) return date;
  const zeroBased = p.m - 1 + delta;
  const y = p.y + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12 + 1;
  return key(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** Today, as a calendar date in the given zone. */
export function todayInTz(timeZone: string, now: Date = new Date()): string {
  return splitInTz(now.toISOString(), timeZone).date;
}

export interface DatedSend {
  status: string;
  scheduled_at: string;
  published_at: string | null;
  channel_timezone: string;
}

/**
 * The calendar date a send belongs on: the day it happened (or is due) in ITS OWN
 * channel's timezone.
 *
 * Both halves of that matter. `sendTime` picks the real publish time for a send that has
 * already gone out, so a post that slipped overnight appears on the morning it actually
 * landed. And the channel's zone — not the grid's — decides the day, because every other
 * screen states times in channel-local terms; bucketing on UTC would file an evening
 * Eastern send under the following day.
 */
export function dayOf(row: DatedSend): string {
  return splitInTz(sendTime(row).iso, row.channel_timezone).date;
}

/**
 * Group sends by their day, preserving the order they arrived in — the query already
 * sorted them, and re-sorting here would fight it.
 *
 * A row whose date cannot be resolved is dropped rather than guessed at: better absent
 * than confidently on the wrong day, and it must not throw, or one bad channel row would
 * blank the entire calendar.
 */
export function bucketByDay<T extends DatedSend>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const day = dayOf(row);
    if (!day) continue;
    const bucket = out.get(day);
    if (bucket) bucket.push(row);
    else out.set(day, [row]);
  }
  return out;
}
