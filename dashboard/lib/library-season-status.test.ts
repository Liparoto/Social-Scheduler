import { test } from "node:test";
import assert from "node:assert/strict";
import {
  librarySeasonBadgeDetails,
  librarySeasonStatus,
  type LibrarySeasonPeriod,
} from "./library-season-status.ts";

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
const malformedOneOff: LibrarySeasonPeriod = {
  id: 5,
  name: "Broken launch",
  mode: "green",
  recurs_yearly: false,
  start_month: null,
  start_day: null,
  end_month: null,
  end_day: null,
  start_date: "2026-02-30",
  end_date: "2026-03-02",
};

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

test("a malformed linked period marks a ready card invalid without affecting another card", () => {
  const verdicts = [
    librarySeasonStatus("ready", [malformedOneOff], evaluationDate),
    librarySeasonStatus("ready", [], evaluationDate),
  ];

  assert.deepEqual(verdicts, ["Invalid period", "Live"]);
});

test("draft and retired do not evaluate malformed linked periods", () => {
  assert.equal(librarySeasonStatus("draft", [malformedOneOff], evaluationDate), "Draft");
  assert.equal(librarySeasonStatus("retired", [malformedOneOff], evaluationDate), "Retired");
});

test("unexpected programming errors still escape the verdict helper", () => {
  const programmingError = new TypeError("unexpected getter failure");
  const period = { ...matchingGreen };
  Object.defineProperty(period, "recurs_yearly", {
    get() {
      throw programmingError;
    },
  });

  assert.throws(
    () => librarySeasonStatus("ready", [period], evaluationDate),
    (error) => error === programmingError
  );
});

test("ready badge details provide a stable description relationship and worker caveat", () => {
  assert.deepEqual(
    librarySeasonBadgeDetails(42, "Dormant", evaluationDate, "America/Los_Angeles"),
    {
      descriptionId: "post-42-season-status-description",
      description:
        "Advisory season status for 2026-08-03 in America/Los_Angeles. " +
        "The worker evaluates eligibility using each target channel's timezone.",
      badgeProps: {
        tabIndex: 0,
        title:
          "Advisory season status for 2026-08-03 in America/Los_Angeles. " +
          "The worker evaluates eligibility using each target channel's timezone.",
        "aria-describedby": "post-42-season-status-description",
      },
    }
  );
});

test("invalid badge details tell assistive technology that period configuration must be fixed", () => {
  const details = librarySeasonBadgeDetails(
    43,
    "Invalid period",
    evaluationDate,
    "America/Los_Angeles"
  );

  assert.equal(details.descriptionId, "post-43-season-status-description");
  assert.match(details.description, /Invalid period configuration/);
  assert.match(details.description, /must be fixed/);
  assert.match(details.description, /2026-08-03/);
  assert.match(details.description, /America\/Los_Angeles/);
  assert.equal(details.badgeProps["aria-describedby"], details.descriptionId);
  assert.equal(details.badgeProps.tabIndex, 0);
});
