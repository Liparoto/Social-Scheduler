import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CarouselStack } from "../components/carousel-stack.tsx";

const thumb = React.createElement("div", { "data-testid": "thumb" }, "thumb");

test("a single-image post is passed straight through, with nothing added", () => {
  const html = renderToStaticMarkup(React.createElement(CarouselStack, { count: 1 }, thumb));
  assert.equal(html, renderToStaticMarkup(thumb));
});

test("a carousel gets a count chip and layers behind the thumbnail", () => {
  const html = renderToStaticMarkup(React.createElement(CarouselStack, { count: 5 }, thumb));
  assert.ok(html.includes("thumb"), "the thumbnail is still rendered");
  assert.match(html, />5</);
  assert.match(html, /aria-hidden/, "the decorative layers are hidden from screen readers");
});

test("the count is announced, not left as a bare number", () => {
  const html = renderToStaticMarkup(React.createElement(CarouselStack, { count: 5 }, thumb));
  assert.match(html, /5 slides/);
});

test("a zero or negative count is treated as no stack", () => {
  const html = renderToStaticMarkup(React.createElement(CarouselStack, { count: 0 }, thumb));
  assert.equal(html, renderToStaticMarkup(thumb));
});
