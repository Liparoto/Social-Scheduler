// Same loader-order note as post-media-editor's: media-manager pulls in media-lightbox,
// which imports createPortal from bare "react-dom".
import "react-dom";

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaManager } from "../components/media-manager.tsx";
import type { AssetWithUsage } from "../lib/queries.ts";

// /media's whole job is to say what can be freed. It decides that from listAssetsWithUsage(),
// while the DELETE guard lets any foreign key veto — so the page must never offer a Delete
// button for something the server will refuse. migration 0016 added a second way to be
// referenced (assets.cover_asset_id: a video pointing at its Reels cover image), which
// carries no post_assets row, so post_count alone called it "Unused" and counted its bytes
// as reclaimable. These tests pin the page's side of that agreement.

function asset(over: Partial<AssetWithUsage> = {}): AssetWithUsage {
  return {
    id: 1, content_hash: "h1", media_kind: "image", original_filename: "photo.jpg",
    storage_path: "a/1.jpg", publish_path: null, thumbnail_path: null, mime_type: "image/jpeg",
    width: 1080, height: 1350, byte_size: 1_000_000, duration_ms: null, cover_frame_ms: null,
    created_at: "2026-08-21T00:00:00+00:00",
    post_count: 0, cover_use_count: 0, first_post_id: null, first_post_status: null,
    ...over,
  };
}

const render = (assets: AssetWithUsage[]) =>
  renderToStaticMarkup(React.createElement(MediaManager, { assets }));

test("an asset used only as a Reels cover is not offered for deletion", () => {
  const html = render([asset({ id: 7, cover_use_count: 1 })]);
  assert.match(html, /Used as a Reels cover/, "it says WHY there is no delete button");
  assert.doesNotMatch(html, /Unused/, "it is referenced — calling it unused is the bug");
  assert.doesNotMatch(html, /aria-label="Delete photo.jpg"/,
    "the server would refuse this delete, so the button must not exist");
});

test("a cover's bytes are not counted as reclaimable space", () => {
  // 1 MB in a post, 1 MB as a cover, 1 MB genuinely free. Only the last is reclaimable.
  const html = render([
    asset({ id: 1, post_count: 1, first_post_id: 42, first_post_status: "draft" }),
    asset({ id: 2, cover_use_count: 1, original_filename: "cover.jpg" }),
    asset({ id: 3, original_filename: "free.jpg" }),
  ]);
  assert.match(html, /1 unused/, "exactly one file is free, not two");
  assert.doesNotMatch(html, /2 unused/);
});

test("a genuinely unused asset still gets its Delete button", () => {
  // The guard must not overreach: this is the case the page exists for.
  const html = render([asset({ id: 9, original_filename: "free.jpg" })]);
  assert.match(html, /Unused/);
  assert.match(html, /aria-label="Delete free.jpg"/);
});

test("an asset that is BOTH in a post and a cover keeps its post link", () => {
  const html = render([
    asset({ id: 4, post_count: 1, cover_use_count: 1, first_post_id: 42, first_post_status: "draft" }),
  ]);
  assert.match(html, /post #42/, "the post link is the more useful of the two facts");
  assert.match(html, /also used as a Reels cover/i, "but the cover use is still disclosed");
  assert.doesNotMatch(html, /aria-label="Delete photo.jpg"/);
});

test("a cover shared by several videos says how many", () => {
  const html = render([asset({ id: 5, cover_use_count: 3 })]);
  assert.match(html, /Used as a Reels cover \(3 videos\)/);
});

// The link target, not just the text: "In post #null" was the shape this would have taken
// if covers had simply been folded into the existing `used` branch.
test("no asset ever links to post #null", () => {
  const html = render([
    asset({ id: 6, cover_use_count: 1 }),
    asset({ id: 7, original_filename: "free.jpg" }),
  ]);
  assert.doesNotMatch(html, /null/);
});
