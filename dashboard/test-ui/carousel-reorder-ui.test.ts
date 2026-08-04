import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CarouselReorder, type OrderableAsset } from "../components/carousel-reorder.tsx";

const noop = () => {};
const assets: OrderableAsset[] = [
  { id: 11, media_kind: "image" },
  { id: 22, media_kind: "image" },
  { id: 33, media_kind: "image" },
];

function render(order: number[], queuedSendCount = 0) {
  return renderToStaticMarkup(
    React.createElement(CarouselReorder, {
      assets,
      order,
      onOrderChange: noop,
      queuedSendCount,
    })
  );
}

test("slides render in the order given, not in the order of the assets prop", () => {
  const html = render([33, 11, 22]);
  const positions = [11, 22, 33].map((id) => html.indexOf(`/api/media/${id}?variant=thumb`));
  assert.ok(positions.every((p) => p > -1), "every slide has a thumbnail");
  // 33 first, then 11, then 22.
  assert.ok(positions[2] < positions[0], "33 renders before 11");
  assert.ok(positions[0] < positions[1], "11 renders before 22");
});

test("every slide is shown — no slice(0, 4) like the old read-only strip", () => {
  const many: OrderableAsset[] = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i,
    media_kind: "image",
  }));
  const html = renderToStaticMarkup(
    React.createElement(CarouselReorder, {
      assets: many,
      order: many.map((a) => a.id),
      onOrderChange: noop,
      queuedSendCount: 0,
    })
  );
  for (const a of many) {
    assert.ok(html.includes(`/api/media/${a.id}?variant=thumb`), `slide ${a.id} is missing`);
  }
});

test("queued sends are named before you save, and pluralised", () => {
  assert.match(render([11, 22, 33], 3), /3 queued sends will go out in this order/);
  assert.match(render([11, 22, 33], 1), /1 queued send will go out in this order/);
});

test("with no queued sends there is no notice at all", () => {
  assert.doesNotMatch(render([11, 22, 33], 0), /queued send/);
});

// An order that names an asset the post no longer has must not blow up mid-render.
test("an unknown id in the order is skipped rather than thrown on", () => {
  const html = render([11, 999, 22, 33]);
  assert.ok(html.includes("/api/media/11?variant=thumb"));
  assert.ok(!html.includes("/api/media/999?variant=thumb"));
});

// Regression for the post detail page silently losing ConformControl when the carousel
// branch switched to CarouselReorder — renderExtra is how that control gets back under
// each slide (see post-editor.tsx). Assert only that whatever a caller returns from
// renderExtra actually reaches the markup, once per slide, keyed by asset id.
test("renderExtra renders per-slide, keyed by asset id", () => {
  const html = renderToStaticMarkup(
    React.createElement(CarouselReorder, {
      assets,
      order: [11, 22, 33],
      onOrderChange: noop,
      queuedSendCount: 0,
      renderExtra: (assetId: number) =>
        React.createElement("span", { "data-testid": `extra-${assetId}` }, "needs review"),
    })
  );
  for (const id of [11, 22, 33]) {
    assert.ok(html.includes(`data-testid="extra-${id}"`), `renderExtra output missing for ${id}`);
  }
});

test("with no renderExtra prop, nothing extra is rendered", () => {
  const html = render([11, 22, 33]);
  assert.ok(!html.includes("data-testid"));
});
