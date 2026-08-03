import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coverageLabel,
  coverageState,
  removableIds,
} from "./bulk-edit-context.ts";

test("coverage state distinguishes all, some, and none", () => {
  assert.equal(coverageState(3, 3), "all");
  assert.equal(coverageState(1, 3), "some");
  assert.equal(coverageState(0, 3), "none");
});

test("non-positive totals never report full coverage", () => {
  assert.equal(coverageState(0, 0), "none");
  assert.equal(coverageState(-1, 0), "none");
  assert.equal(coverageState(1, 0), "some");
  assert.equal(coverageState(2, -3), "some");
});

test("coverage labels summarize all, partial, and absent coverage", () => {
  assert.equal(coverageLabel(3, 3), "All 3");
  assert.equal(coverageLabel(1, 3), "1 of 3");
  assert.equal(coverageLabel(0, 3), "None");
});

test("coverage labels clamp invalid negative values", () => {
  assert.equal(coverageLabel(-2, 3), "None");
  assert.equal(coverageLabel(1, 0), "Some");
  assert.equal(coverageLabel(1, -3), "Some");
  assert.equal(coverageLabel(0, -3), "None");
});

test("removable ids put full coverage first and omit absent ids", () => {
  assert.deepEqual(
    removableIds([4, 9, 12], { 4: 1, 9: 3, 12: 0 }, 3),
    [9, 4],
  );
});

test("removable ids sort by count, preserve tie order, and do not mutate input", () => {
  const ids = [8, 5, 2, 7, 6];
  const original = [...ids];

  assert.deepEqual(
    removableIds(ids, { 8: 2, 5: 3, 2: 2, 6: -1 }, 3),
    [5, 8, 2],
  );
  assert.deepEqual(ids, original);
});
