import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coveredBands, deriveBand, intervalNote, intervalStepMinutes, intervalTimesPerDay,
  parseCadence, serializeCadence, summarize, uncoveredBandWarning,
} from "./cadence";

const BT = { morning: "09:00", afternoon: "13:00", evening: "18:00" };
const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

test("parseCadence reads the original single-time shape", () => {
  const c = parseCadence('{"days":["mon","wed"],"time":"18:00"}');
  assert.equal(c.mode, "times");
  assert.deepEqual(c.slots, [{ time: "18:00", days: ["mon", "wed"] }]);
});

test("parseCadence reads the multi-time shape, giving each time the shared days", () => {
  const c = parseCadence('{"days":["sat"],"times":["09:00","18:00"]}');
  assert.equal(c.mode, "times");
  assert.deepEqual(c.slots, [
    { time: "09:00", days: ["sat"] },
    { time: "18:00", days: ["sat"] },
  ]);
});

test("parseCadence reads per-time days and an interval cadence", () => {
  const t = parseCadence('{"mode":"times","slots":[{"time":"18:00","days":["sat"]}]}');
  assert.equal(t.mode, "times");
  assert.deepEqual(t.slots, [{ time: "18:00", days: ["sat"] }]);
  const i = parseCadence(
    '{"mode":"interval","every_minutes":585,"window":{"from":"08:00","to":"21:00"},'
    + '"days":["mon"]}',
  );
  assert.equal(i.mode, "interval");
  assert.equal(i.everyMinutes, 585);
  assert.equal(i.from, "08:00");
  assert.deepEqual(i.days, ["mon"]);
});

test("parseCadence falls back to a sane default on garbage", () => {
  const c = parseCadence("not json");
  assert.equal(c.mode, "times");
  assert.equal(c.slots.length, 1);
});

test("serialize round-trips both modes", () => {
  const t = parseCadence('{"mode":"times","slots":[{"time":"18:00","days":["sat"]}]}');
  assert.deepEqual(parseCadence(serializeCadence(t)), t);
  const i = parseCadence('{"mode":"interval","every_minutes":585,"days":["mon"]}');
  assert.deepEqual(parseCadence(serializeCadence(i)), i);
});

test("deriveBand matches the worker: nearest, no wrap, ties to the earlier band", () => {
  assert.equal(deriveBand("12:30", BT), "afternoon");
  assert.equal(deriveBand("18:00", BT), "evening");
  assert.equal(deriveBand("23:00", BT), "evening");
  assert.equal(deriveBand("02:00", BT), "morning");
  assert.equal(deriveBand("11:00", BT), "morning");
});

test("coveredBands is the slot times in times mode; an hourly interval covers its window", () => {
  const t = parseCadence('{"mode":"times","slots":[{"time":"12:30","days":["mon"]}]}');
  assert.deepEqual([...coveredBands(t, BT)].sort(), ["afternoon"]);
  const i = parseCadence(
    '{"mode":"interval","every_minutes":60,"window":{"from":"08:00","to":"12:00"},'
    + '"days":["mon"]}',
  );
  assert.deepEqual([...coveredBands(i, BT)].sort(), ["afternoon", "morning"]);
});

test("coveredBands is empty for an interval with no days — an empty day list is invalid, not \"every day\"", () => {
  const i = parseCadence(
    '{"mode":"interval","every_minutes":60,"window":{"from":"08:00","to":"12:00"},'
    + '"days":[]}',
  );
  assert.equal(i.mode, "interval");
  assert.deepEqual(i.days, []);
  assert.deepEqual([...coveredBands(i, BT)], []);
});

const WINDOW = '"window":{"from":"08:00","to":"21:00"}';
const everyN = (n: number) =>
  parseCadence(
    `{"mode":"interval","every_minutes":${n},${WINDOW},"days":${JSON.stringify(ALL)}}`,
  );

test("intervalStepMinutes: reachable times are gcd(everyMinutes, 1440) apart", () => {
  assert.equal(intervalStepMinutes(1440), 1440);   // one time of day
  assert.equal(intervalTimesPerDay(1440), 1);
  assert.equal(intervalStepMinutes(720), 720);     // two
  assert.equal(intervalTimesPerDay(720), 2);
  assert.equal(intervalStepMinutes(585), 45);      // 9h45m -> 32, a genuine drift
  assert.equal(intervalTimesPerDay(585), 32);
});

test("coveredBands guarantees nothing for an interval that lands at one time a day", () => {
  // The form's own default. It reaches ONE clock time and which one depends on the phase —
  // the last scheduled send, which is in the database and unknowable here. Claiming the
  // window would report all three bands covered and silence the coverage warning entirely.
  assert.deepEqual([...coveredBands(everyN(1440), BT)], []);
});

test("coveredBands guarantees nothing for a 12h interval either", () => {
  // everyMinutes % 1440 !== 0, so the old predicate called this a drift. It is not: both
  // steps land at the same two clock times forever, and only one is ever in the window.
  assert.deepEqual([...coveredBands(everyN(720), BT)], []);
});

test("coveredBands still covers every window band for an interval that genuinely drifts", () => {
  assert.deepEqual([...coveredBands(everyN(585), BT)].sort(),
    ["afternoon", "evening", "morning"]);
});

test("intervalNote is keyed off the reachable times, not everyMinutes % 1440", () => {
  assert.match(intervalNote(1440), /always lands at the same time/);
  assert.match(intervalNote(720), /only 2 times of day, 12h apart/);
  assert.match(intervalNote(240), /only 6 times of day, 4h apart/);
  assert.match(intervalNote(585), /sweeps through every hour/);
});

test("uncoveredBandWarning agrees with itself on number, and on which mode it is", () => {
  // The live library has exactly one morning post, so the singular is the first thing the
  // owner reads.
  assert.equal(
    uncoveredBandWarning("morning", 1, "times"),
    "1 ready post is tagged morning — no morning time set, so it will not be auto-filled.",
  );
  assert.match(uncoveredBandWarning("evening", 17, "times"),
    /^17 ready posts are tagged evening — no evening time set, so they will not be/);
  assert.match(uncoveredBandWarning("evening", 17, "interval"),
    /not guaranteed to land in the evening, so they may not be auto-filled\.$/);
});

test("summarize says daily rather than listing seven days", () => {
  const t = parseCadence(
    `{"mode":"times","slots":[{"time":"12:30","days":${JSON.stringify(ALL)}},`
    + '{"time":"18:00","days":["sat","sun"]}]}',
  );
  assert.match(summarize(t), /12:30 daily/);
  assert.match(summarize(t), /18:00 Sat\/Sun/);
  const i = parseCadence(
    `{"mode":"interval","every_minutes":585,"window":{"from":"08:00","to":"21:00"},`
    + `"days":${JSON.stringify(ALL)}}`,
  );
  assert.match(summarize(i), /Every 9h 45m/);
  assert.match(summarize(i), /08:00–21:00/);
});
