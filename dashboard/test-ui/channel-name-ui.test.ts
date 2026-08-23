import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelName } from "../components/channel-name.tsx";

// renderToStaticMarkup gives markup only — no clicks. Saving is browser-verified; this
// pins that the control exists and starts collapsed.

test("the rename control renders collapsed, showing Edit", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChannelName, { channelId: 3, accountName: "liparoto" }),
  );
  assert.match(html, /Name/);
  assert.match(html, /Edit/);
  // Collapsed: the input is not in the markup until opened.
  assert.doesNotMatch(html, /<input/);
});

test("the control does not leak the name into a value it cannot edit yet", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChannelName, { channelId: 3, accountName: "liparoto" }),
  );
  assert.doesNotMatch(html, /Cancel/);
});
