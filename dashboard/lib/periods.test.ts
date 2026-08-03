import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inSeason,
  localDate,
  periodContains,
  type PeriodWindow,
} from "./periods.ts";

function recurring(
  startMonth: number,
  startDay: number,
  endMonth: number,
  endDay: number
): PeriodWindow {
  return {
    recurs_yearly: 1,
    start_month: startMonth,
    start_day: startDay,
    end_month: endMonth,
    end_day: endDay,
    start_date: null,
    end_date: null,
  };
}

function oneOff(startDate: string, endDate: string): PeriodWindow {
  return {
    recurs_yearly: 0,
    start_month: null,
    start_day: null,
    end_month: null,
    end_day: null,
    start_date: startDate,
    end_date: endDate,
  };
}

test("a recurring window that crosses New Year includes both boundaries", () => {
  const football = recurring(8, 25, 2, 15);

  assert.equal(periodContains(football, "2026-12-01"), true);
  assert.equal(periodContains(football, "2026-08-01"), false);
  assert.equal(periodContains(football, "2026-02-20"), false);
  assert.equal(periodContains(football, "2026-08-25"), true);
  assert.equal(periodContains(football, "2026-02-15"), true);
});

test("a non-wrapping recurring window is inclusive and excludes outside dates", () => {
  const summer = recurring(6, 1, 8, 31);

  assert.equal(periodContains(summer, "2026-06-01"), true);
  assert.equal(periodContains(summer, "2026-07-15"), true);
  assert.equal(periodContains(summer, "2026-08-31"), true);
  assert.equal(periodContains(summer, "2026-05-31"), false);
  assert.equal(periodContains(summer, "2026-09-01"), false);
});

test("a one-off date window is inclusive", () => {
  const launch = oneOff("2026-07-01", "2026-07-07");

  assert.equal(periodContains(launch, "2026-07-01"), true);
  assert.equal(periodContains(launch, "2026-07-04"), true);
  assert.equal(periodContains(launch, "2026-07-07"), true);
  assert.equal(periodContains(launch, "2026-06-30"), false);
  assert.equal(periodContains(launch, "2026-07-08"), false);
});

test("blackout wins when green and blackout periods overlap", () => {
  const winter = recurring(12, 1, 2, 28);
  const decemberBlackout = recurring(12, 1, 12, 31);

  assert.equal(inSeason([winter], [decemberBlackout], "2026-12-10"), false);
});

test("green periods require one match when any are configured", () => {
  const winter = recurring(12, 1, 2, 28);

  assert.equal(inSeason([winter], [], "2026-01-15"), true);
  assert.equal(inSeason([winter], [], "2026-07-01"), false);
});

test("no green periods means in season unless a blackout matches", () => {
  const decemberBlackout = recurring(12, 1, 12, 31);

  assert.equal(inSeason([], [], "2026-07-01"), true);
  assert.equal(inSeason([], [decemberBlackout], "2026-07-01"), true);
  assert.equal(inSeason([], [decemberBlackout], "2026-12-10"), false);
});

test("local date is derived from an explicit instant and IANA timezone", () => {
  const instant = new Date("2026-01-02T01:30:00.000Z");

  assert.equal(localDate(instant, "America/New_York"), "2026-01-01");
  assert.equal(localDate(instant, "Asia/Tokyo"), "2026-01-02");
});
