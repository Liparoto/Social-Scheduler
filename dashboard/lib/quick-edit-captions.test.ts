import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captionVariantsToSave,
  captionsKey,
  captionsToDrafts,
  genericCaptionLimit,
  overLimitGenericCaptions,
  syncedPostCaption,
  usableCaptions,
  type CaptionDraft,
} from "./quick-edit-captions.ts";

// ---- posts.caption sync ----------------------------------------------------------
// The column the Library card, the caption search and the publish fallback all read.

test("a generic variant becomes posts.caption", () => {
  assert.equal(
    syncedPostCaption([{ platform: null, body: "Golden hour", sort_order: 0 }]),
    "Golden hour"
  );
});

test("platform-only variants leave posts.caption alone — it is still the fallback", () => {
  assert.equal(
    syncedPostCaption([{ platform: "threads", body: "Short one", sort_order: 0 }]),
    undefined
  );
});

test("clearing every variant clears posts.caption", () => {
  assert.equal(syncedPostCaption([]), null);
});

test("a generic variant alongside platform ones still wins", () => {
  assert.equal(
    syncedPostCaption([
      { platform: "threads", body: "Short one", sort_order: 0 },
      { platform: null, body: "The real one", sort_order: 1 },
    ]),
    "The real one"
  );
});

// ---- the limit a generic caption is actually held to ------------------------------

test("the strictest targeted platform sets the generic limit", () => {
  const resolved = genericCaptionLimit(["threads", "discord"], [{ platform: "", body: "hi" }], "single");
  assert.equal(resolved?.limit, 500);
  assert.deepEqual(resolved?.platforms, ["threads"]);
  assert.equal(resolved?.label, "Threads");
});

test("a platform with its own variant no longer constrains the generic one", () => {
  const drafts: CaptionDraft[] = [
    { platform: "", body: "generic" },
    { platform: "threads", body: "threads-specific" },
  ];
  const resolved = genericCaptionLimit(["threads", "discord"], drafts, "single");
  assert.equal(resolved?.limit, 2000);
  assert.deepEqual(resolved?.platforms, ["discord"]);
});

test("an empty platform-specific row does not excuse its platform", () => {
  const drafts: CaptionDraft[] = [
    { platform: "", body: "generic" },
    { platform: "threads", body: "   " },
  ];
  assert.equal(genericCaptionLimit(["threads"], drafts, "single")?.limit, 500);
});

test("platforms with no configured limit are skipped, not counted as zero", () => {
  // Instagram carries no captionChars entry today.
  const resolved = genericCaptionLimit(["instagram", "threads"], [{ platform: "", body: "hi" }], "single");
  assert.equal(resolved?.limit, 500);
  assert.deepEqual(resolved?.platforms, ["threads"]);
});

test("a post targeting only unlimited platforms gets no counter", () => {
  assert.equal(genericCaptionLimit(["instagram"], [{ platform: "", body: "hi" }], "single"), null);
});

test("a post with no targets gets no counter", () => {
  assert.equal(genericCaptionLimit([], [{ platform: "", body: "hi" }], "single"), null);
});

test("the limit follows post_type where a platform's limit depends on it", () => {
  const drafts: CaptionDraft[] = [{ platform: "", body: "hi" }];
  assert.equal(genericCaptionLimit(["telegram"], drafts, "text")?.limit, 4096);
  assert.equal(genericCaptionLimit(["telegram"], drafts, "single")?.limit, 1024);
});

test("ties name every platform sharing the strictest limit", () => {
  const resolved = genericCaptionLimit(["threads", "threads"], [{ platform: "", body: "hi" }], "single");
  assert.deepEqual(resolved?.platforms, ["threads"]);
});

test("an over-limit generic caption is reported against its real limit", () => {
  const drafts: CaptionDraft[] = [{ platform: "", body: "x".repeat(501) }];
  assert.deepEqual(overLimitGenericCaptions(["threads"], drafts, "single"), [
    { length: 501, limit: 500, label: "Threads" },
  ]);
});

test("a generic caption inside the limit reports nothing", () => {
  const drafts: CaptionDraft[] = [{ platform: "", body: "x".repeat(500) }];
  assert.deepEqual(overLimitGenericCaptions(["threads"], drafts, "single"), []);
});

test("an over-limit generic caption is fine once no target falls back to it", () => {
  const drafts: CaptionDraft[] = [
    { platform: "", body: "x".repeat(501) },
    { platform: "threads", body: "short" },
  ];
  assert.deepEqual(overLimitGenericCaptions(["threads"], drafts, "single"), []);
});

// ---- drafts, payload and the dirty check -----------------------------------------

test("blank rows are scaffolding, not captions", () => {
  const drafts: CaptionDraft[] = [
    { platform: "", body: "real" },
    { platform: "threads", body: "  " },
  ];
  assert.equal(usableCaptions(drafts).length, 1);
  assert.deepEqual(captionVariantsToSave(drafts), [
    { platform: null, body: "real", sort_order: 0 },
  ]);
});

test("the payload trims bodies and renumbers sort_order", () => {
  const drafts: CaptionDraft[] = [
    { platform: "", body: "  generic  " },
    { platform: "", body: "" },
    { platform: "threads", body: "threads copy" },
  ];
  assert.deepEqual(captionVariantsToSave(drafts), [
    { platform: null, body: "generic", sort_order: 0 },
    { platform: "threads", body: "threads copy", sort_order: 1 },
  ]);
});

test("whitespace and blank rows read as clean", () => {
  const opened: CaptionDraft[] = [{ platform: "", body: "Golden hour" }];
  const edited: CaptionDraft[] = [
    { platform: "", body: "Golden hour  " },
    { platform: "", body: "" },
  ];
  assert.equal(captionsKey(opened), captionsKey(edited));
});

test("reordering variants reads as dirty — the worker rotates in sort order", () => {
  const a: CaptionDraft[] = [
    { platform: "", body: "one" },
    { platform: "", body: "two" },
  ];
  const b: CaptionDraft[] = [
    { platform: "", body: "two" },
    { platform: "", body: "one" },
  ];
  assert.notEqual(captionsKey(a), captionsKey(b));
});

test("changing a body reads as dirty", () => {
  assert.notEqual(
    captionsKey([{ platform: "", body: "before" }]),
    captionsKey([{ platform: "", body: "after" }])
  );
});

test("moving a caption to a platform reads as dirty", () => {
  assert.notEqual(
    captionsKey([{ platform: "", body: "same text" }]),
    captionsKey([{ platform: "threads", body: "same text" }])
  );
});

test("an uncaptioned post opens with one empty row to type into", () => {
  assert.deepEqual(captionsToDrafts([]), [{ platform: "", body: "" }]);
});

test("saved variants round-trip into drafts", () => {
  assert.deepEqual(
    captionsToDrafts([
      { platform: null, body: "generic", sort_order: 0 },
      { platform: "threads", body: "threads copy", sort_order: 1 },
    ]),
    [
      { platform: "", body: "generic" },
      { platform: "threads", body: "threads copy" },
    ]
  );
});
