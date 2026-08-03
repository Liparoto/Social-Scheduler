import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBulkEditPayload,
  bulkEditChangeLabels,
  type BulkEditDraft,
} from "./bulk-edit-form.ts";

const unchanged: BulkEditDraft = {
  tagAdds: [],
  tagRemoves: [],
  periodAdds: {},
  periodRemoves: {},
  contentStatus: "unchanged",
  contentKind: "unchanged",
  cooldownMode: "unchanged",
  cooldownDays: 30,
};

test("payload keeps add/remove intent explicit and omits unchanged scalars", () => {
  const payload = buildBulkEditPayload([7, 17, 18], {
    ...unchanged,
    tagAdds: [12],
    tagRemoves: [4, 9],
    periodAdds: { 6: "green", 8: "blackout" },
    periodRemoves: { 3: "green" },
  });

  assert.deepEqual(payload, {
    post_ids: [7, 17, 18],
    tags: { add: [12], remove: [4, 9] },
    periods: {
      add: [
        { periodId: 6, mode: "green" },
        { periodId: 8, mode: "blackout" },
      ],
      remove: [{ periodId: 3, mode: "green" }],
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
      tagAdds: [5],
      tagRemoves: [4],
      periodAdds: { 6: "green" },
      periodRemoves: { 7: "blackout" },
      contentStatus: "ready",
      contentKind: "one_time",
      cooldownMode: "custom",
      cooldownDays: 45,
    },
    [
      { id: 4, name: "Football" },
      { id: 5, name: "Summer" },
    ],
    [
      { id: 6, name: "Football Season" },
      { id: 7, name: "Holiday Blackout" },
    ]
  );

  assert.deepEqual(labels, [
    "add tag Summer",
    "remove tag Football",
    "attach Football Season as green",
    "detach Holiday Blackout as blackout",
    "set status to ready",
    "set kind to one-time",
    "set cooldown to 45 days",
  ]);
});
