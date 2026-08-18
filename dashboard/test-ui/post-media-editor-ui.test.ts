// Load order matters: post-media-editor.tsx imports `createPortal` from "react-dom" (for
// the remove-slide confirm's portal). Under this project's test-ui loader hook, if
// "react-dom/server" finishes loading before the bare "react-dom" import resolves, Node's
// require(esm) interop hands react-dom/server a synthetic module missing its internals and
// renderToStaticMarkup crashes before any test body runs. Same fix as media-lightbox's.
import "react-dom";

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostMediaEditor, type EditorSlide } from "../components/post-media-editor.tsx";

// The strip that draws a post's slides on BOTH edit surfaces. It absorbed the old
// <CarouselReorder> grid (which these tests used to cover) after the two of them rendered
// every photo on the page twice, side by side — so the reorder assertions live on here now.

const noop = () => {};
const slides: EditorSlide[] = [
  { id: 11, media_kind: "image", cover_frame_ms: null },
  { id: 22, media_kind: "image", cover_frame_ms: null },
  { id: 33, media_kind: "image", cover_frame_ms: null },
];

function render(props: Partial<React.ComponentProps<typeof PostMediaEditor>> = {}) {
  return renderToStaticMarkup(
    React.createElement(PostMediaEditor, {
      postId: 1,
      slides,
      onChanged: noop,
      ...props,
    })
  );
}

const reorder = (order: number[]) => ({ order, onOrderChange: noop, isDirty: false });

test("slides render in the order given, not in the order of the slides prop", () => {
  const html = render({ reorder: reorder([33, 11, 22]) });
  const positions = [11, 22, 33].map((id) => html.indexOf(`/api/media/${id}?variant=thumb`));
  assert.ok(positions.every((p) => p > -1), "every slide has a thumbnail");
  assert.ok(positions[2] < positions[0], "33 renders before 11");
  assert.ok(positions[0] < positions[1], "11 renders before 22");
});

// The bug this whole strip exists to prevent: two grids of the same photos on one page.
// Counts <img> tags rather than the URL — React also emits a <link rel="preload"> per image,
// so every thumbnail's href legitimately appears twice in the markup.
test("each slide is drawn exactly once", () => {
  const html = render({ reorder: reorder([11, 22, 33]) });
  for (const s of slides) {
    const tag = `<img src="/api/media/${s.id}?variant=thumb"`;
    assert.equal(html.split(tag).length - 1, 1, `slide ${s.id} is drawn more than once`);
  }
});

test("every slide is shown — no slice(0, 4) like the old read-only strip", () => {
  const many: EditorSlide[] = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i,
    media_kind: "image",
    cover_frame_ms: null,
  }));
  const html = render({ slides: many, reorder: reorder(many.map((s) => s.id)) });
  for (const s of many) {
    assert.ok(html.includes(`/api/media/${s.id}?variant=thumb`), `slide ${s.id} is missing`);
  }
});

// An order that names a slide the post no longer has must not blow up mid-render, and a
// slide the order hasn't caught up with yet (a just-added one) must not vanish.
test("an unknown id in the order is skipped, and an unordered slide still shows", () => {
  const html = render({ reorder: reorder([11, 999, 22]) });
  assert.ok(html.includes("/api/media/11?variant=thumb"));
  assert.ok(!html.includes("/api/media/999?variant=thumb"));
  assert.ok(html.includes("/api/media/33?variant=thumb"), "slide 33 is missing from the strip");
});

test("renderExtra renders per-slide, keyed by slide id", () => {
  const html = render({
    reorder: reorder([11, 22, 33]),
    renderExtra: (slide: EditorSlide) =>
      React.createElement("span", { "data-testid": `extra-${slide.id}` }, "needs review"),
  });
  for (const id of [11, 22, 33]) {
    assert.ok(html.includes(`data-testid="extra-${id}"`), `renderExtra output missing for ${id}`);
  }
});

test("with no renderExtra prop, nothing extra is rendered", () => {
  assert.ok(!render({ reorder: reorder([11, 22, 33]) }).includes("data-testid"));
});

test("renderTile replaces the thumbnail but keeps the strip's own remove control", () => {
  const html = render({
    slides: [slides[0]],
    renderTile: () => React.createElement("div", { "data-testid": "custom-tile" }),
  });
  assert.ok(html.includes('data-testid="custom-tile"'));
  assert.ok(!html.includes("/api/media/11?variant=thumb"), "default thumbnail still rendered");
  assert.ok(html.includes('aria-label="Remove slide 11"'));
});

test("adding is always offered — Upload and Library sit at the end of the strip", () => {
  const html = render({ reorder: reorder([11, 22, 33]) });
  assert.match(html, /Upload/);
  assert.match(html, />Library</);
  assert.match(html, /type="file"/);
});

test("every slide can be removed, by id", () => {
  const html = render({ reorder: reorder([11, 22, 33]) });
  for (const s of slides) {
    assert.ok(html.includes(`aria-label="Remove slide ${s.id}"`), `no ✕ for slide ${s.id}`);
  }
});

// A post must keep at least one slide, so the last ✕ is disabled rather than absent — an
// absent control reads as "removing isn't possible here", which isn't the reason.
test("the last remaining slide's remove control is disabled and says why", () => {
  const html = render({ slides: [slides[0]] });
  assert.match(
    html,
    /disabled="" title="A post needs at least one photo" aria-label="Remove slide 11"/,
    "the sole slide's ✕ is not disabled, or no longer says why"
  );
});

test("reorder controls appear only for 2+ slides, and only when reordering is wired up", () => {
  const withReorder = render({ reorder: reorder([11, 22, 33]) });
  assert.match(withReorder, /aria-label="Move left"/);
  assert.match(withReorder, /aria-label="Move right"/);

  // Same three slides, no reorder prop: the host isn't offering it.
  assert.doesNotMatch(render(), /aria-label="Move (left|right)"/);

  // Wired up, but a single image or a Reel has nothing to order.
  assert.doesNotMatch(
    render({ slides: [slides[0]], reorder: reorder([11]) }),
    /aria-label="Move (left|right)"/
  );
});
