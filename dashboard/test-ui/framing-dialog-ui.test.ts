import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FramingDialog } from "../components/framing-dialog.tsx";
import type { Asset } from "../lib/types.ts";

// renderToStaticMarkup gives markup only — no clicks, no layout. Interaction and appearance
// are browser-verified; these pin structure, the honest cost text, and the regression that
// this entire project exists to prevent.

const landscape: Asset = {
  id: 1, content_hash: "h", media_kind: "image", original_filename: null,
  storage_path: "a.jpg", public_url: null, thumbnail_path: null, mime_type: "image/jpeg",
  width: 4032, height: 3024, byte_size: 1000, publish_path: "pub/a.jpg",
  conform_mode: "crop", needs_review: 0, duration_ms: null, cover_frame_ms: null,
  has_audio: 0, created_at: "2026-08-04", story_path: null, story_mode: "blurred",
};

const vertical: Asset = { ...landscape, width: 1320, height: 2346 };

function render(asset: Asset, scheduledSendCount = 0) {
  return renderToStaticMarkup(
    React.createElement(FramingDialog, { asset, scheduledSendCount, onClose: () => {} }),
  );
}

test("both surfaces are offered, with all four options", () => {
  const html = render(landscape);
  assert.match(html, />Feed</);
  assert.match(html, />Story</);
  assert.match(html, />Crop</);
  assert.match(html, />Pad</);
  assert.match(html, />Blurred fill</);
  assert.match(html, />Crop to fill</);
});

test("the source dimensions are shown, so 'why is this being reframed' is answerable", () => {
  assert.match(render(landscape), /4032/);
  assert.match(render(landscape), /3024/);
});

test("the cost of cropping is stated from the REAL dimensions", () => {
  // 4032x3024 cropped to 9:16 loses ~58%. A generic "some cropping may occur" is exactly
  // the vagueness that made the old 40px preview useless.
  assert.match(render(landscape), /58%/);
});

test("previews use object-contain, never object-cover", () => {
  // object-cover CROPS the preview — which is how Crop and Pad came to render identically
  // in the old control. This is the bug, asserted directly.
  const html = render(landscape);
  assert.match(html, /object-contain/);
  assert.doesNotMatch(html, /object-cover/);
});

test("an already-9:16 source says so and offers no story options", () => {
  const html = render(vertical);
  assert.match(html, /already 9:16/i);
  assert.doesNotMatch(html, />Blurred fill</, "nothing to choose when the source fits");
});

test("scheduled sends are named as a consequence of changing framing", () => {
  assert.match(render(landscape, 2), /2 scheduled sends will use the new framing/);
});

test("one scheduled send reads as singular", () => {
  assert.match(render(landscape, 1), /1 scheduled send will use the new framing/);
});

test("no scheduled sends means no warning", () => {
  assert.doesNotMatch(render(landscape, 0), /will use the new framing/);
});

test("already-posted sends are stated as unaffected", () => {
  assert.match(render(landscape, 2), /already[- ]posted/i);
});

// ---- The regression this whole project exists to prevent -------------------------
test("the controls are present even when a choice has already been made", () => {
  const chosen: Asset = {
    ...landscape,
    needs_review: 0,
    story_path: "story/h-crop.jpg",
    story_mode: "crop",
  };
  const html = render(chosen);
  assert.match(html, />Blurred fill</, "framing must never become one-way");
  assert.match(html, />Crop to fill</);
  assert.match(html, />Crop</);
  assert.match(html, />Pad</);
});

test("a video asset offers no framing at all — sharp cannot reframe one", () => {
  const video: Asset = { ...landscape, media_kind: "video", width: 1080, height: 1920 };
  const html = render(video);
  assert.doesNotMatch(html, />Blurred fill</);
});
