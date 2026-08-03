import { test } from "node:test";
import assert from "node:assert/strict";
import { librarySeasonStatus, type LibrarySeasonPeriod } from "./library-season-status.ts";

const evaluationDate = "2026-08-03";

function recurring(
  id: number,
  name: string,
  mode: "green" | "blackout",
  startMonth: number,
  startDay: number,
  endMonth: number,
  endDay: number
): LibrarySeasonPeriod {
  return {
    id,
    name,
    mode,
    recurs_yearly: true,
    start_month: startMonth,
    start_day: startDay,
    end_month: endMonth,
    end_day: endDay,
    start_date: null,
    end_date: null,
  };
}

const matchingGreen = recurring(1, "Summer", "green", 6, 1, 8, 31);
const nonmatchingGreen = recurring(2, "Football Season", "green", 8, 20, 2, 15);
const matchingBlackout = recurring(3, "August Pause", "blackout", 8, 1, 8, 10);
const nonmatchingBlackout = recurring(4, "December Pause", "blackout", 12, 1, 12, 31);

test("ready with no periods is Live", () => {
  assert.equal(librarySeasonStatus("ready", [], evaluationDate), "Live");
});

test("ready with a matching green period is Live", () => {
  assert.equal(librarySeasonStatus("ready", [matchingGreen], evaluationDate), "Live");
});

test("ready with only a nonmatching green period is Dormant", () => {
  assert.equal(librarySeasonStatus("ready", [nonmatchingGreen], evaluationDate), "Dormant");
});

test("ready with a matching blackout is Blocked even when green matches", () => {
  assert.equal(
    librarySeasonStatus("ready", [matchingGreen, matchingBlackout], evaluationDate),
    "Blocked"
  );
});

test("ready with a nonmatching blackout and no green periods is Live", () => {
  assert.equal(librarySeasonStatus("ready", [nonmatchingBlackout], evaluationDate), "Live");
});

test("draft and retired retain lifecycle status regardless of season", () => {
  assert.equal(librarySeasonStatus("draft", [matchingBlackout], evaluationDate), "Draft");
  assert.equal(librarySeasonStatus("retired", [matchingGreen], evaluationDate), "Retired");
});
