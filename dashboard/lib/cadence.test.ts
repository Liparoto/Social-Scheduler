import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coveredBands, deriveBand, parseCadence, serializeCadence, summarize,
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

test("coveredBands is the slot times in times mode, the window in interval mode", () => {
  const t = parseCadence('{"mode":"times","slots":[{"time":"12:30","days":["mon"]}]}');
  assert.deepEqual([...coveredBands(t, BT)].sort(), ["afternoon"]);
  const i = parseCadence(
    '{"mode":"interval","every_minutes":60,"window":{"from":"08:00","to":"12:00"},'
    + '"days":["mon"]}',
  );
  assert.deepEqual([...coveredBands(i, BT)].sort(), ["afternoon", "morning"]);
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
