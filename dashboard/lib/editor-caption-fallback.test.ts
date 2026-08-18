import { test } from "node:test";
import assert from "node:assert/strict";
import { editorCaptionVariants } from "./quick-edit-captions.ts";

// Regression: a post created with `caption` but no `caption_variants` rows — reachable
// through POST /api/posts/draft, which treats the two as independent fields — opened in the
// Library's quick-edit dialog with an EMPTY caption box. Saving anything from that dialog
// (even just a tag change) then sent caption_variants: [], which made syncedPostCaption()
// return null and wiped posts.caption. The post published fine right up until someone
// opened it and pressed Save.
//
// The worker already resolves this the right way (_select_caption falls back to
// posts.caption), so the editor read is made to agree with what actually publishes.

test("a post with a caption but no variants seeds the editor from posts.caption", () => {
  assert.deepEqual(editorCaptionVariants([], "Golden hour at the clinic"), [
    { platform: null, body: "Golden hour at the clinic", sort_order: 0 },
  ]);
});

test("saved variants win — posts.caption is only the fallback", () => {
  const saved = [{ platform: null, body: "The real variant", sort_order: 0 }];

  assert.deepEqual(editorCaptionVariants(saved, "stale column value"), saved);
});

test("platform-specific variants are not joined by a synthesised generic row", () => {
  // posts.caption IS the live fallback for any targeted platform without its own variant,
  // but inventing a generic row here would write that fallback into caption_variants and
  // change what publishes. Left exactly as saved.
  const saved = [{ platform: "threads", body: "Short one", sort_order: 0 }];

  assert.deepEqual(editorCaptionVariants(saved, "generic fallback"), saved);
});

test("a genuinely uncaptioned post still opens empty", () => {
  assert.deepEqual(editorCaptionVariants([], null), []);
  assert.deepEqual(editorCaptionVariants([], "   "), []);
});
