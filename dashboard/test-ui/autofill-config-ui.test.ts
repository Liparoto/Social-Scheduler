import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_INTERVAL, DEFAULT_TIMES } from "../components/autofill-config.tsx";
import { DAYS, parseCadence, serializeCadence } from "../lib/cadence.ts";

// The two mode defaults are what the owner lands on the first time they switch modes — the
// stored cadence is one mode, so the OTHER mode has nothing to restore and falls back here.
// A cadence with no days is dropped by the worker (_parse_times / _parse_interval drop it,
// parse_cadence returns None) and the unit silently stops auto-filling with nothing in the
// UI saying so. Neither default may ship an empty day list.

test("both mode defaults carry all seven days, so switching modes cannot save a dead cadence", () => {
  const times = JSON.parse(serializeCadence(DEFAULT_TIMES));
  assert.equal(times.mode, "times");
  assert.equal(times.slots.length, 1);
  assert.deepEqual(times.slots[0].days, [...DAYS]);

  const interval = JSON.parse(serializeCadence(DEFAULT_INTERVAL));
  assert.equal(interval.mode, "interval");
  assert.deepEqual(interval.days, [...DAYS]);
});

test("both mode defaults survive a serialize/parse round trip unchanged", () => {
  assert.deepEqual(parseCadence(serializeCadence(DEFAULT_TIMES)), DEFAULT_TIMES);
  assert.deepEqual(parseCadence(serializeCadence(DEFAULT_INTERVAL)), DEFAULT_INTERVAL);
});
