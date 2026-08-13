/**
 * Calendar date maths.
 *
 * All of this works on plain YYYY-MM-DD calendar dates, never on instants. That is the
 * whole trick: a calendar grid has no timezone of its own, and doing the arithmetic on
 * Date objects in local time is how "add one day" turns into 23 or 25 hours across a DST
 * boundary and a week silently shows the same day twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  startOfWeek,
  weekDays,
  monthGrid,
  shiftMonth,
  monthOf,
  bucketByDay,
} from "./calendar.ts";

// ---- addDays -------------------------------------------------------------------------
test("adding days crosses months and years", () => {
  assert.equal(addDays("2026-08-12", 1), "2026-08-13");
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
});

test("adding days is unaffected by daylight saving", () => {
  // US DST ends 2026-11-01. On a local-time Date this arithmetic yields 25 hours and can
  // land back on the same calendar day.
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-11-01", 1), "2026-11-02");
  // And spring forward, 2026-03-08.
  assert.equal(addDays("2026-03-07", 1), "2026-03-08");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
});

test("a leap day is a real day", () => {
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2028-02-29", 1), "2028-03-01");
  // And not one in a common year.
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
});

// ---- weeks ---------------------------------------------------------------------------
test("a week starts on the Sunday on or before the date", () => {
  // 2026-08-12 is a Wednesday; the Sunday before it is the 9th.
  assert.equal(startOfWeek("2026-08-12"), "2026-08-09");
  // A Sunday is already its own week start.
  assert.equal(startOfWeek("2026-08-09"), "2026-08-09");
  // A Saturday belongs to the week that began six days earlier.
  assert.equal(startOfWeek("2026-08-15"), "2026-08-09");
});

test("a week is seven consecutive days from that Sunday", () => {
  assert.deepEqual(weekDays("2026-08-12"), [
    "2026-08-09",
    "2026-08-10",
    "2026-08-11",
    "2026-08-12",
    "2026-08-13",
    "2026-08-14",
    "2026-08-15",
  ]);
});

// ---- month grid ----------------------------------------------------------------------
test("a month grid is always six rows of seven, so paging never resizes the page", () => {
  for (const anchor of ["2026-08-12", "2026-02-03", "2026-11-30", "2028-02-15"]) {
    const grid = monthGrid(anchor);
    assert.equal(grid.length, 6, `${anchor} should have 6 rows`);
    for (const week of grid) assert.equal(week.length, 7);
  }
});

test("the grid starts on the Sunday on or before the 1st and runs unbroken", () => {
  // August 2026 starts on a Saturday, so the grid opens on Sunday 26 July.
  const grid = monthGrid("2026-08-12");
  assert.equal(grid[0][0], "2026-07-26");
  assert.equal(grid[0][6], "2026-08-01");

  const flat = grid.flat();
  for (let i = 1; i < flat.length; i++) {
    assert.equal(flat[i], addDays(flat[i - 1], 1), `gap before ${flat[i]}`);
  }
});

test("a month that begins on a Sunday still shows leading days, not a jump", () => {
  // 2026-11-01 is a Sunday. The grid must still be six unbroken rows.
  const grid = monthGrid("2026-11-15");
  assert.equal(grid[0][0], "2026-11-01");
  assert.equal(grid.flat().length, 42);
});

test("monthOf reports which month a cell belongs to, for dimming the edges", () => {
  assert.equal(monthOf("2026-08-01"), "2026-08");
  assert.equal(monthOf("2026-07-26"), "2026-07");
});

// ---- paging --------------------------------------------------------------------------
test("paging by month crosses the year boundary", () => {
  assert.equal(shiftMonth("2026-12-15", 1), "2027-01-15");
  assert.equal(shiftMonth("2026-01-15", -1), "2025-12-15");
});

test("paging from a long month into a short one clamps to a real date", () => {
  // The classic bug: +1 month from 31 January is not 31 February.
  assert.equal(shiftMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftMonth("2028-01-31", 1), "2028-02-29"); // leap year
  assert.equal(shiftMonth("2026-03-31", -1), "2026-02-28");
});

test("paging forward then back returns to the same month", () => {
  // Not necessarily the same DAY — clamping is lossy — but the month must round-trip,
  // or the next/prev buttons drift a month every time you pass February.
  assert.equal(monthOf(shiftMonth(shiftMonth("2026-01-31", 1), -1)), "2026-01");
});

// ---- bucketing -----------------------------------------------------------------------
const send = (id: number, status: string, scheduled: string, published: string | null, tz: string) => ({
  id,
  status,
  scheduled_at: scheduled,
  published_at: published,
  channel_timezone: tz,
});

test("a send lands on its own channel's local date", () => {
  // 03:30 UTC on the 13th is still the evening of the 12th in New York. Bucketing on the
  // UTC date would file it under a day the owner never scheduled anything for.
  const rows = [send(1, "scheduled", "2026-08-13T03:30:00Z", null, "America/New_York")];

  const buckets = bucketByDay(rows);

  assert.deepEqual([...buckets.keys()], ["2026-08-12"]);
  assert.deepEqual(buckets.get("2026-08-12")?.map((r) => r.id), [1]);
});

test("a posted send lands on the day it actually went out", () => {
  // Scheduled the 11th, slipped to the 12th. It belongs on the 12th — the same rule the
  // WHEN column follows (lib/send-time).
  const rows = [
    send(1, "posted", "2026-08-11T19:30:00Z", "2026-08-12T14:20:00Z", "America/Los_Angeles"),
  ];

  const buckets = bucketByDay(rows);

  assert.deepEqual([...buckets.keys()], ["2026-08-12"]);
});

test("two channels in different zones can land on different days", () => {
  const rows = [
    send(1, "scheduled", "2026-08-13T03:30:00Z", null, "America/New_York"),
    send(2, "scheduled", "2026-08-13T03:30:00Z", null, "UTC"),
  ];

  const buckets = bucketByDay(rows);

  assert.deepEqual(buckets.get("2026-08-12")?.map((r) => r.id), [1]);
  assert.deepEqual(buckets.get("2026-08-13")?.map((r) => r.id), [2]);
});

test("sends on one day keep the order they arrived in", () => {
  // The query already sorted them; re-sorting here would fight it.
  const rows = [
    send(7, "scheduled", "2026-08-12T20:00:00Z", null, "UTC"),
    send(3, "scheduled", "2026-08-12T09:00:00Z", null, "UTC"),
  ];

  assert.deepEqual(bucketByDay(rows).get("2026-08-12")?.map((r) => r.id), [7, 3]);
});

test("a send with an unusable timezone is dropped rather than misplaced", () => {
  // Better absent than confidently on the wrong day — and it cannot throw, or one bad
  // channel row would blank the whole calendar.
  const rows = [send(1, "scheduled", "not-a-date", null, "UTC")];
  assert.equal(bucketByDay(rows).size, 0);
});
