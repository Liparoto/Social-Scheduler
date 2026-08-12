/**
 * Splitting the queue into "still to go out" and "done".
 *
 * The two halves were already sorted apart and read in opposite directions (upcoming runs
 * forward, history runs backward), but nothing on screen said so — the boundary was an
 * invisible seam somewhere in a 49-row table, and the reversal looked like a glitch rather
 * than a rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitQueueSections, isFinished } from "./queue-sections.ts";

const row = (id: number, status: string) => ({ id, status });

test("a send that has not gone out is not finished", () => {
  for (const s of ["scheduled", "failed", "publishing", "pending_approval"]) {
    assert.equal(isFinished(s), false, `${s} should be unfinished`);
  }
});

test("a send that is over — posted or abandoned — is finished", () => {
  // Canceled belongs here despite never going out: it is not waiting on anything and
  // there is nothing left to do to it.
  assert.equal(isFinished("posted"), true);
  assert.equal(isFinished("canceled"), true);
});

test("an unknown status counts as unfinished, so it is never filed under Done", () => {
  // A status added to the schema but not here should surface among live work rather than
  // be quietly buried in history where nobody looks.
  assert.equal(isFinished("some_future_status"), false);
});

test("the queue splits into two sections, upcoming first", () => {
  const sections = splitQueueSections([
    row(1, "failed"),
    row(2, "scheduled"),
    row(3, "posted"),
    row(4, "canceled"),
  ]);

  assert.deepEqual(
    sections.map((s) => [s.key, s.rows.map((r) => r.id)]),
    [
      ["unfinished", [1, 2]],
      ["finished", [3, 4]],
    ]
  );
});

test("row order inside a section is preserved exactly", () => {
  // The SQL already sorted these — each half in its own direction. Sectioning must not
  // re-sort or it would silently undo that.
  const sections = splitQueueSections([
    row(9, "scheduled"),
    row(5, "scheduled"),
    row(7, "posted"),
    row(2, "posted"),
  ]);

  assert.deepEqual(sections[0].rows.map((r) => r.id), [9, 5]);
  assert.deepEqual(sections[1].rows.map((r) => r.id), [7, 2]);
});

test("rows are still split correctly when the two halves are interleaved", () => {
  // Defensive: sectioning must not depend on the sort having grouped them already,
  // otherwise a future ORDER BY change turns into a silently mislabelled table.
  const sections = splitQueueSections([
    row(1, "posted"),
    row(2, "scheduled"),
    row(3, "posted"),
  ]);

  assert.deepEqual(sections[0].rows.map((r) => r.id), [2]);
  assert.deepEqual(sections[1].rows.map((r) => r.id), [1, 3]);
});

test("a section with no rows is dropped, so no empty heading appears", () => {
  const onlyPosted = splitQueueSections([row(1, "posted")]);
  assert.deepEqual(onlyPosted.map((s) => s.key), ["finished"]);

  const onlyUpcoming = splitQueueSections([row(1, "scheduled")]);
  assert.deepEqual(onlyUpcoming.map((s) => s.key), ["unfinished"]);
});

test("an empty queue produces no sections at all", () => {
  assert.deepEqual(splitQueueSections([]), []);
});

test("each section carries a title and its own count", () => {
  const sections = splitQueueSections([
    row(1, "scheduled"),
    row(2, "scheduled"),
    row(3, "posted"),
  ]);

  assert.equal(sections[0].title, "In the queue");
  assert.equal(sections[0].rows.length, 2);
  assert.equal(sections[1].title, "Done");
  assert.equal(sections[1].rows.length, 1);
});
