// Same loader-order note as post-media-editor's: media-manager pulls in media-lightbox,
// which imports createPortal from bare "react-dom".
import "react-dom";

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaManager, postLabel } from "../components/media-manager.tsx";
import type { AssetPostRef, AssetWithUsage } from "../lib/queries.ts";

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
    post_count: 0, cover_use_count: 0, posts: [],
    ...over,
  };
}

/** A post an asset is used in. `post_count` must agree with `posts.length`, as the query
 *  guarantees — a fixture where they disagree would test a state that cannot happen. */
function usedIn(...posts: AssetPostRef[]): Partial<AssetWithUsage> {
  return { post_count: posts.length, posts };
}

const ref = (post_id: number, caption: string | null, status = "draft"): AssetPostRef => ({
  post_id, caption, status,
});

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
    asset({ id: 1, ...usedIn(ref(42, "In a post")) }),
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
    asset({ id: 4, cover_use_count: 1, ...usedIn(ref(42, "Both at once")) }),
  ]);
  assert.match(html, /href="\/library\/42"/, "the post link is the more useful of the two facts");
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

// ---- Every post an asset is used in must be reachable --------------------------------
// The card used to link ONE post — whichever had the lowest id — and render the rest as the
// plain text "+N more", which was not a link. For an asset reused across posts, the normal
// case for evergreen recycling, most of its posts could not be navigated to at all.

test("every post an asset is used in gets its own link", () => {
  const html = render([
    asset({ id: 1, ...usedIn(ref(7, "First post"), ref(9, "Second post")) }),
  ]);

  assert.match(html, /href="\/library\/7"/);
  assert.match(html, /href="\/library\/9"/, "this is the link that did not exist before");
  assert.doesNotMatch(html, /\+\d+ more<\/p>/, "'+N more' as dead text is the bug");
});

test("posts beyond the first few collapse behind a real button, not dead text", () => {
  const html = render([
    asset({
      id: 1,
      ...usedIn(
        ref(1, "One"), ref(2, "Two"), ref(3, "Three"), ref(4, "Four"), ref(5, "Five")
      ),
    }),
  ]);

  assert.match(html, /In 5 posts:/, "the full count is stated even when not all are shown");
  assert.match(html, /<button[^>]*>\+3 more<\/button>/,
    "a button can be pressed; the old text could not");
  // The first two are links straight away, so the common case needs no interaction.
  assert.match(html, /href="\/library\/1"/);
  assert.match(html, /href="\/library\/2"/);
});

test("a post is labelled by its caption, not its id", () => {
  const html = render([asset({ id: 1, ...usedIn(ref(47, "Spring sale — last chance")) })]);

  assert.match(html, /Spring sale — last chance/);
  assert.doesNotMatch(html, /post #47/, "a bare id gives nothing to recognise it by");
});

test("a single post still reads as a sentence", () => {
  const html = render([asset({ id: 1, ...usedIn(ref(3, "Only post", "posted")) })]);

  assert.match(html, /In /, "one post keeps the inline 'In …' phrasing");
  assert.match(html, /\(posted\)/, "status stays visible — it was useful before");
  assert.doesNotMatch(html, /In 1 posts/, "and never the plural header");
});

// --- postLabel ------------------------------------------------------------------------

test("postLabel takes only the caption's first line", () => {
  assert.equal(postLabel("Headline\nbody text\nmore", 1), "Headline");
});

test("postLabel falls back to the id when there is no caption", () => {
  for (const empty of [null, "", "   ", "\n\n"]) {
    assert.equal(postLabel(empty, 12), "post #12");
  }
});

test("postLabel truncates long captions without splitting an emoji", () => {
  // The reason truncateChars exists: slicing mid-surrogate sends a lone surrogate, the
  // browser substitutes U+FFFD, and the hydration mismatch kills every handler on the page.
  const label = postLabel("🔺".repeat(60), 1);
  assert.ok(Array.from(label).length < 60, "it truncated");
  // A high surrogate (D800–DBFF) must always be followed by a low one (DC00–DFFF), and a
  // low one must always be preceded by a high one. Anything else is half an emoji.
  assert.doesNotMatch(label, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no lone high surrogate");
  assert.doesNotMatch(label, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone low surrogate");
});

test("a caption with newlines cannot break the card layout", () => {
  const html = render([
    asset({ id: 1, ...usedIn(ref(2, "Line one\nLine two\nLine three")) }),
  ]);
  // The LINK TEXT is one line. The full caption does still travel, in the title attribute,
  // which is the point of it — hover to read the rest without opening the post.
  const linkText = /<a [^>]*href="\/library\/2"[^>]*>([^<]*)<\/a>/.exec(html)?.[1];
  assert.equal(linkText, "Line one");
  assert.match(html, /title="Line one\nLine two\nLine three"/);
});
