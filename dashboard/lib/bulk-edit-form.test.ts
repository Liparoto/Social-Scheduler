import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBulkEditPayload,
  bulkEditChangeLabels,
  type BulkEditDraft,
} from "./bulk-edit-form.ts";

const unchanged: BulkEditDraft = {
  tagAction: "add",
  tagIds: [],
  periodAction: "add",
  periodModes: {},
  contentStatus: "unchanged",
  contentKind: "unchanged",
  cooldownMode: "unchanged",
  cooldownDays: 30,
};

test("payload keeps add/remove intent explicit and omits unchanged scalars", () => {
  const payload = buildBulkEditPayload([7, 17, 18], {
    ...unchanged,
    tagAction: "remove",
    tagIds: [4, 9],
    periodAction: "add",
    periodModes: { 6: "green", 8: "blackout" },
  });

  assert.deepEqual(payload, {
    post_ids: [7, 17, 18],
    tags: { add: [], remove: [4, 9] },
    periods: {
      add: [
        { periodId: 6, mode: "green" },
        { periodId: 8, mode: "blackout" },
      ],
      remove: [],
    },
  });
});

test("cooldown default becomes null while an untouched form is a no-op", () => {
  assert.deepEqual(buildBulkEditPayload([1], unchanged), { post_ids: [1] });
  assert.deepEqual(
    buildBulkEditPayload([1], { ...unchanged, cooldownMode: "default" }),
    { post_ids: [1], cooldown_days: null }
  );
});

test("confirmation labels name the exact actions", () => {
  const labels = bulkEditChangeLabels(
    {
      ...unchanged,
      tagAction: "remove",
      tagIds: [4],
      periodAction: "add",
      periodModes: { 6: "green" },
      contentStatus: "ready",
      contentKind: "one_time",
      cooldownMode: "custom",
      cooldownDays: 45,
    },
    [{ id: 4, name: "Football" }],
    [{ id: 6, name: "Football Season" }]
  );

  assert.deepEqual(labels, [
    "remove tag Football",
    "attach Football Season as green",
    "set status to ready",
    "set kind to one-time",
    "set cooldown to 45 days",
  ]);
});
