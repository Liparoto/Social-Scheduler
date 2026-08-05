import { test } from "node:test";
import assert from "node:assert/strict";
import { isPostDirty, type DirtyCheckInput } from "./post-editor-dirty.ts";

// A clean editor: every field equals what the component was initialised with.
function clean(over: Partial<DirtyCheckInput> = {}): DirtyCheckInput {
  return {
    captions: [{ platform: "", body: "hello" }],
    initialCaptions: [{ platform: "", body: "hello" }],
    targets: [{ channel_id: 1, surface: "feed" }],
    initialTargets: [{ channel_id: 1, surface: "feed" }],
    tagIds: [3, 1],
    initialTagIds: [1, 3],
    status: "draft",
    initialStatus: "draft",
    kind: "evergreen",
    initialKind: "evergreen",
    cooldown: "",
    initialCooldownDays: null,
    ...over,
  };
}

test("an untouched editor is not dirty", () => {
  assert.equal(isPostDirty(clean()), false);
});

// ---- the four fields the guard already covered -----------------------------------

test("an edited caption is dirty", () => {
  assert.equal(isPostDirty(clean({ captions: [{ platform: "", body: "changed" }] })), true);
});

test("whitespace-only caption churn is NOT dirty", () => {
  // save() trims, so trailing space is not a real change and must not block the guard.
  assert.equal(isPostDirty(clean({ captions: [{ platform: "", body: "hello  " }] })), false);
});

test("an added channel target is dirty", () => {
  assert.equal(
    isPostDirty(
      clean({
        targets: [
          { channel_id: 1, surface: "feed" },
          { channel_id: 2, surface: "feed" },
        ],
      })
    ),
    true
  );
});

test("the same channel on a different surface is dirty", () => {
  // Feed and Story are independent destinations — swapping one for the other is a change.
  assert.equal(isPostDirty(clean({ targets: [{ channel_id: 1, surface: "story" }] })), true);
});

test("reordered tags are NOT dirty", () => {
  assert.equal(isPostDirty(clean({ tagIds: [1, 3] })), false);
});

test("an added tag is dirty", () => {
  assert.equal(isPostDirty(clean({ tagIds: [1, 3, 7] })), true);
});

test("a changed content status is dirty", () => {
  assert.equal(isPostDirty(clean({ status: "ready" })), true);
});

// ---- the two fields the guard MISSED (the bug) ------------------------------------

test("changing Evergreen to One-time is dirty", () => {
  // The bug: save() persists content_kind, but the guard never compared it — so
  // "Post now" stayed enabled and published the stale kind, and "Split into separate
  // posts" copied the stale kind into every new post.
  assert.equal(isPostDirty(clean({ kind: "one_time" })), true);
});

test("setting a cooldown override where there was none is dirty", () => {
  assert.equal(isPostDirty(clean({ cooldown: "30", initialCooldownDays: null })), true);
});

test("clearing a cooldown override is dirty", () => {
  assert.equal(isPostDirty(clean({ cooldown: "", initialCooldownDays: 30 })), true);
});

test("changing a cooldown override is dirty", () => {
  assert.equal(isPostDirty(clean({ cooldown: "45", initialCooldownDays: 30 })), true);
});

// ---- cooldown normalization: the state is a string, the column is number | null ----

test("an unchanged cooldown is NOT dirty despite string-vs-number", () => {
  // The editor holds "30"; the row holds 30. Comparing them raw would report dirty
  // forever on every post that has a cooldown set.
  assert.equal(isPostDirty(clean({ cooldown: "30", initialCooldownDays: 30 })), false);
});

test("whitespace around an unchanged cooldown is NOT dirty", () => {
  // save() does cooldown.trim() === "" ? null : Number(cooldown) — match it exactly.
  assert.equal(isPostDirty(clean({ cooldown: " 30 ", initialCooldownDays: 30 })), false);
});

test("blank and null mean the same thing — use the channel default", () => {
  assert.equal(isPostDirty(clean({ cooldown: "   ", initialCooldownDays: null })), false);
});
