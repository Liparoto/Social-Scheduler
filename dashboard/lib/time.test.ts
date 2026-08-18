import { test } from "node:test";
import assert from "node:assert/strict";
import { splitInTz, rebaseWallClock, zonedTimeToUtc } from "./time.ts";

// ---------------------------------------------------------------------------
// splitInTz
// ---------------------------------------------------------------------------

test("splitInTz reads the wall clock in the target zone", () => {
  // 13:00Z on Jul 15 is 09:00 in New York (EDT, UTC-4).
  assert.deepEqual(splitInTz("2026-07-15T13:00:00.000Z", "America/New_York"), {
    date: "2026-07-15",
    time: "09:00",
  });
});

test("splitInTz renders midnight as 00:00, never 24:00", () => {
  // 05:00Z is exactly midnight in Chicago (CDT, UTC-5). Some ICU builds resolve
  // hour12:false to the h24 cycle and emit "24:00" here, which is not a valid
  // <input type="time"> value and is an invalid Date when re-parsed.
  assert.deepEqual(splitInTz("2026-08-02T05:00:00.000Z", "America/Chicago"), {
    date: "2026-08-02",
    time: "00:00",
  });
});

test("splitInTz survives a bad zone instead of throwing", () => {
  assert.deepEqual(splitInTz("2026-08-02T09:00:00.000Z", "Amrica/New_York"), {
    date: "",
    time: "",
  });
});

// ---------------------------------------------------------------------------
// rebaseWallClock — the "keep the same clock time" rule
// ---------------------------------------------------------------------------

test("rebases a 9am send from UTC to Central", () => {
  // Reads as 09:00 UTC; must still read as 09:00 in Chicago (CDT, UTC-5) => 14:00Z.
  assert.equal(
    rebaseWallClock("2026-08-02T09:00:00.000Z", "UTC", "America/Chicago"),
    "2026-08-02T14:00:00+00:00"
  );
});

test("rebasing to the same zone is a no-op", () => {
  const iso = "2026-08-02T09:00:00.000Z";
  assert.equal(rebaseWallClock(iso, "America/Denver", "America/Denver"), iso);
});

test("a bad target zone leaves the instant untouched", () => {
  // Never silently corrupt a real schedule because a zone name was wrong.
  const iso = "2026-08-02T09:00:00.000Z";
  assert.equal(rebaseWallClock(iso, "UTC", "Not/AZone"), iso);
  assert.equal(rebaseWallClock(iso, "Not/AZone", "UTC"), iso);
});

test("the shift is derived per-instant, not fixed per zone pair (DST)", () => {
  // New York observes DST; Phoenix does not. So a 9am New York send lands on a
  // DIFFERENT offset from Phoenix depending on the time of year. A naive
  // implementation that cached one offset for the pair would get one of these
  // an hour wrong.

  // Summer: 09:00 EDT (UTC-4) == 13:00Z  ->  09:00 MST (UTC-7) == 16:00Z (+3h)
  assert.equal(
    rebaseWallClock("2026-07-15T13:00:00.000Z", "America/New_York", "America/Phoenix"),
    "2026-07-15T16:00:00+00:00"
  );

  // Winter: 09:00 EST (UTC-5) == 14:00Z  ->  09:00 MST (UTC-7) == 16:00Z (+2h)
  assert.equal(
    rebaseWallClock("2026-01-15T14:00:00.000Z", "America/New_York", "America/Phoenix"),
    "2026-01-15T16:00:00+00:00"
  );
});

test("round-trips against zonedTimeToUtc", () => {
  // rebaseWallClock is defined as "split in A, re-enter in B", so entering the
  // rebased instant by hand in B must produce the same thing.
  const original = "2026-11-03T14:30:00.000Z";
  const rebased = rebaseWallClock(original, "America/New_York", "America/Los_Angeles");
  const { date, time } = splitInTz(original, "America/New_York");
  assert.equal(rebased, zonedTimeToUtc(`${date}T${time}`, "America/Los_Angeles"));
});

// ---------------------------------------------------------------------------
// Storage format — must match what the Python worker writes
// ---------------------------------------------------------------------------

test("zonedTimeToUtc stores the worker's canonical UTC format", () => {
  // Two writers share publications.scheduled_at: this app and the Python worker
  // (datetime.isoformat() -> "…+00:00"). JS toISOString() emits "….000Z" — the same
  // instant in different text. Auto-fill counts a group's SLOTS by comparing that
  // text, so a mismatch makes one slot look like two and the queue stops refilling.
  assert.equal(zonedTimeToUtc("2026-08-18T12:30", "America/Los_Angeles"), "2026-08-18T19:30:00+00:00");
});

test("canonical format survives a rebase", () => {
  assert.equal(
    rebaseWallClock("2026-08-02T09:00:00+00:00", "UTC", "America/Chicago"),
    "2026-08-02T14:00:00+00:00"
  );
});

test("canonical format has no fractional seconds", () => {
  // ".000" is exactly the character run that split the two writers apart.
  assert.match(zonedTimeToUtc("2026-01-05T00:00", "UTC"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
});
