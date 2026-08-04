// Load order matters here: media-lightbox.tsx imports `createPortal` from "react-dom"
// (for MediaLightbox's portal — LightboxPanel itself doesn't use it, but the whole file
// does). Under this project's test-ui loader hook, if "react-dom/server" finishes loading
// before the bare "react-dom" import from the component resolves, Node's require(esm)
// interop hands react-dom/server's internal `require("react-dom")` a synthetic module
// missing `__DOM_INTERNALS_DO_NOT_USE...`, and renderToStaticMarkup crashes on an
// undefined read before any test body runs. Importing "react-dom" first, fully, avoids it.
import "react-dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LightboxPanel } from "../components/media-lightbox.tsx";
import type { LightboxAsset } from "../components/media-lightbox.tsx";

const noop = () => {};
const img = (id: number): LightboxAsset => ({
  id,
  media_kind: "image",
  cover_frame_ms: null,
  width: 1080,
  height: 1080,
});

function render(assets: LightboxAsset[], index = 0) {
  return renderToStaticMarkup(
    React.createElement(LightboxPanel, {
      assets,
      index,
      label: "A post",
      mediaError: false,
      onClose: noop,
      onStep: noop,
      onMediaError: noop,
      panelRef: React.createRef<HTMLDivElement>(),
    })
  );
}

test("a single asset shows no navigation at all — nothing changes for existing callers", () => {
  const html = render([img(5)]);
  assert.ok(html.includes("/api/media/5"));
  assert.doesNotMatch(html, /aria-label="Next slide"/);
  assert.doesNotMatch(html, /aria-label="Previous slide"/);
  assert.doesNotMatch(html, /1 \/ 1/);
});

test("a carousel shows the current slide, a counter, and both arrows", () => {
  const html = render([img(1), img(2), img(3)], 1);
  assert.ok(html.includes("/api/media/2"), "the CURRENT slide is the one rendered");
  assert.match(html, /aria-label="Previous slide"/);
  assert.match(html, /aria-label="Next slide"/);
  assert.match(html, /2 \/ 3/);
});

// Both nav buttons carry the Tailwind class "disabled:opacity-30" regardless of state, so
// a naive /aria-label="..."[^>]*disabled/ match is a false positive: it matches the class
// name, not the `disabled` attribute React actually emits. Pull each button's own opening
// tag and check the literal `disabled=""` React 19 renders for a true boolean attribute —
// that exact substring can't appear inside "disabled:opacity-30" (colon, not equals-quote).
function buttonTag(html: string, ariaLabel: string): string {
  const match = html.match(new RegExp(`<button\\b[^>]*aria-label="${ariaLabel}"[^>]*>`));
  assert.ok(match, `no <button aria-label="${ariaLabel}"> found`);
  return match[0];
}

test("the first slide disables Previous and the last disables Next", () => {
  const first = render([img(1), img(2), img(3)], 0);
  assert.ok(
    buttonTag(first, "Previous slide").includes('disabled=""'),
    "Previous should be disabled on the first slide"
  );
  assert.ok(
    !buttonTag(first, "Next slide").includes('disabled=""'),
    "Next should NOT be disabled on the first slide"
  );

  const last = render([img(1), img(2), img(3)], 2);
  assert.ok(
    buttonTag(last, "Next slide").includes('disabled=""'),
    "Next should be disabled on the last slide"
  );
  assert.ok(
    !buttonTag(last, "Previous slide").includes('disabled=""'),
    "Previous should NOT be disabled on the last slide"
  );
});

test("a video slide renders a player with controls, not an img", () => {
  const html = render([{ ...img(9), media_kind: "video", cover_frame_ms: 400 }]);
  assert.match(html, /<video/);
  assert.match(html, /controls/);
});

test("an empty asset list renders nothing rather than crashing", () => {
  assert.doesNotThrow(() => render([]));
});
