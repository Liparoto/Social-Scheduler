import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelQueueRail, type RailChannel } from "../components/channel-queue-rail.tsx";

// renderToStaticMarkup gives markup only — clicking is browser-verified. These pin the
// structure the filter depends on.

const channels: RailChannel[] = [
  { id: 1, platform: "instagram", account_name: "Liparoto", color_hue: 200,
    avatar_path: null, timezone: "America/Los_Angeles" },
  { id: 3, platform: "tiktok", account_name: "kliparoto", color_hue: 340,
    avatar_path: null, timezone: "America/New_York" },
];
const counts = new Map([[1, 3], [3, 0]]);
const nextAt = new Map([[1, "2026-08-24T01:00:00+00:00"]]);
const noop = () => {};

function render(selected: Set<number>) {
  return renderToStaticMarkup(
    React.createElement(ChannelQueueRail, {
      channels, counts, nextAt, selected, onToggle: noop,
    }),
  );
}

test("every card is a button, so it is reachable by keyboard", () => {
  const html = render(new Set());
  assert.equal((html.match(/<button/g) ?? []).length, channels.length);
});

test("selection is exposed to assistive tech, not only as colour", () => {
  const html = render(new Set([3]));
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /aria-pressed="false"/);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
});

test("nothing selected means every card is off", () => {
  const html = render(new Set());
  assert.doesNotMatch(html, /aria-pressed="true"/);
});

test("a card still shows its queue count and next send", () => {
  const html = render(new Set());
  assert.match(html, /Nothing scheduled ahead/);
  assert.match(html, /Next /);
});

test("the title tells you what clicking will do, both ways round", () => {
  assert.match(render(new Set()), /Show only kliparoto/);
  assert.match(render(new Set([3])), /click to clear/);
});
