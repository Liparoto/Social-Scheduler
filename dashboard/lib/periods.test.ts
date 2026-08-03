import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasValidOneOffPeriodDates,
  inSeason,
  isIsoCalendarDate,
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

test("recurring fields must be present integers at runtime", () => {
  const base = recurring(6, 1, 8, 31);
  const malformed = [
    { ...base, start_month: null },
    { ...base, end_day: undefined } as unknown as PeriodWindow,
    { ...base, start_day: 1.5 },
  ];

  for (const period of malformed) {
    assert.throws(() => periodContains(period, "2026-07-01"), TypeError);
  }
});

test("integer month-day combinations retain Python's numeric comparison behavior", () => {
  const aprilThirtyFirst = recurring(4, 31, 5, 2);

  assert.equal(periodContains(aprilThirtyFirst, "2026-04-30"), false);
  assert.equal(periodContains(aprilThirtyFirst, "2026-05-01"), true);
});

test("a one-off date window is inclusive", () => {
  const launch = oneOff("2026-07-01", "2026-07-07");

  assert.equal(periodContains(launch, "2026-07-01"), true);
  assert.equal(periodContains(launch, "2026-07-04"), true);
  assert.equal(periodContains(launch, "2026-07-07"), true);
  assert.equal(periodContains(launch, "2026-06-30"), false);
  assert.equal(periodContains(launch, "2026-07-08"), false);
});

test("impossible evaluation dates are rejected", () => {
  const summer = recurring(6, 1, 8, 31);

  assert.throws(() => periodContains(summer, "2026-02-30"), RangeError);
  assert.throws(() => inSeason([], [], "2026-02-29"), RangeError);
});

test("impossible one-off start and end dates are rejected", () => {
  assert.throws(
    () => periodContains(oneOff("2026-02-30", "2026-03-02"), "2026-03-01"),
    RangeError
  );
  assert.throws(
    () => periodContains(oneOff("2026-02-28", "2026-02-30"), "2026-03-01"),
    RangeError
  );
});

test("leap day is accepted only in a leap year", () => {
  const leapDay = oneOff("2028-02-29", "2028-02-29");

  assert.equal(periodContains(leapDay, "2028-02-29"), true);
  assert.throws(
    () => periodContains(oneOff("2027-02-29", "2027-02-29"), "2027-02-28"),
    RangeError
  );
});

test("strict ISO calendar validation rejects impossible one-off write dates", () => {
  assert.equal(isIsoCalendarDate("2026-02-30"), false);
  assert.equal(isIsoCalendarDate("2026-2-03"), false);
  assert.equal(isIsoCalendarDate("2028-02-29"), true);
});

test("one-off write validation checks the complete merged PATCH shape", () => {
  const current = { start_date: "2026-02-28", end_date: "2026-03-02" };

  assert.equal(hasValidOneOffPeriodDates(current), true);
  assert.equal(
    hasValidOneOffPeriodDates({ ...current, start_date: "2026-02-30" }),
    false
  );
  assert.equal(
    hasValidOneOffPeriodDates({ ...current, end_date: "2026-03-40" }),
    false
  );
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

test("local date follows Pacific calendar boundaries across spring DST", () => {
  assert.equal(
    localDate(new Date("2026-03-08T07:30:00.000Z"), "America/Los_Angeles"),
    "2026-03-07"
  );
  assert.equal(
    localDate(new Date("2026-03-08T08:30:00.000Z"), "America/Los_Angeles"),
    "2026-03-08"
  );
});

test("local date follows Pacific calendar boundaries across fall DST", () => {
  assert.equal(
    localDate(new Date("2026-11-01T06:30:00.000Z"), "America/Los_Angeles"),
    "2026-10-31"
  );
  assert.equal(
    localDate(new Date("2026-11-01T07:30:00.000Z"), "America/Los_Angeles"),
    "2026-11-01"
  );
});

test("local date rejects invalid timezones and invalid instants", () => {
  assert.throws(() => localDate(new Date(), "Not/A_Timezone"), RangeError);
  assert.throws(() => localDate(new Date(Number.NaN), "America/Los_Angeles"), RangeError);
});
