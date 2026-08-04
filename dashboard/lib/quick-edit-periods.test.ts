import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collapsePeriodLinks,
  periodLinksToSave,
  periodModesKey,
  type PeriodLinkRow,
} from "./quick-edit-periods.ts";

// A post carrying both modes on period 5 — representable in post_periods, and produced
// today by bulk edit's independent attach and by merging carousels.
const dualMode: PeriodLinkRow[] = [
  { id: 3, mode: "green" },
  { id: 5, mode: "blackout" },
  { id: 5, mode: "green" },
];

test("a period carrying two modes collapses to one for display", () => {
  assert.deepEqual(collapsePeriodLinks(dualMode), { 3: "green", 5: "green" });
});

test("an untouched dialog reads as clean even when a period carries two modes", () => {
  const opened = collapsePeriodLinks(dualMode);
  assert.equal(periodModesKey(opened), periodModesKey({ ...opened }));
});

test("the dirty key ignores the order periods were clicked in", () => {
  assert.equal(
    periodModesKey({ 5: "green", 3: "blackout" }),
    periodModesKey({ 3: "blackout", 5: "green" })
  );
});

test("saving an untouched post preserves the mode the dialog could not show", () => {
  const links = periodLinksToSave(dualMode, collapsePeriodLinks(dualMode));
  assert.deepEqual(links, [
    { periodId: 3, mode: "green" },
    { periodId: 5, mode: "blackout" },
    { periodId: 5, mode: "green" },
  ]);
});

test("changing a two-mode period replaces it — that edit is deliberate", () => {
  const links = periodLinksToSave(dualMode, { 3: "green", 5: "blackout" });
  assert.deepEqual(links, [
    { periodId: 3, mode: "green" },
    { periodId: 5, mode: "blackout" },
  ]);
});

test("switching a two-mode period off removes both of its links", () => {
  const links = periodLinksToSave(dualMode, { 3: "green" });
  assert.deepEqual(links, [{ periodId: 3, mode: "green" }]);
});

test("ordinary one-mode posts round-trip unchanged", () => {
  const rows: PeriodLinkRow[] = [
    { id: 1, mode: "green" },
    { id: 2, mode: "blackout" },
  ];
  assert.deepEqual(periodLinksToSave(rows, collapsePeriodLinks(rows)), [
    { periodId: 1, mode: "green" },
    { periodId: 2, mode: "blackout" },
  ]);
});

test("attaching a period the post did not have adds just that link", () => {
  const rows: PeriodLinkRow[] = [{ id: 1, mode: "green" }];
  assert.deepEqual(periodLinksToSave(rows, { 1: "green", 4: "blackout" }), [
    { periodId: 1, mode: "green" },
    { periodId: 4, mode: "blackout" },
  ]);
});

test("detaching every period sends an empty list, not a no-op", () => {
  const rows: PeriodLinkRow[] = [{ id: 1, mode: "green" }];
  assert.deepEqual(periodLinksToSave(rows, {}), []);
});

test("flipping a one-mode period's mode replaces it", () => {
  const rows: PeriodLinkRow[] = [{ id: 1, mode: "green" }];
  assert.deepEqual(periodLinksToSave(rows, { 1: "blackout" }), [
    { periodId: 1, mode: "blackout" },
  ]);
});
