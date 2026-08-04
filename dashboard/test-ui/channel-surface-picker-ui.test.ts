import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChannelSurfacePicker,
  toggleTarget,
  hasTarget,
  type PickerChannel,
} from "../components/channel-surface-picker.tsx";
import type { PostTarget } from "../lib/types.ts";

// renderToStaticMarkup gives markup only — no clicks, no layout. Interaction and
// appearance are browser-verified; these tests pin structure and the pure toggle logic.

const noop = () => {};

const ig: PickerChannel = {
  id: 1,
  platform: "instagram",
  account_name: "liparoto",
  requires_approval: false,
  color_hue: 200,
  avatar_path: null,
};
const telegram: PickerChannel = {
  id: 2,
  platform: "telegram",
  account_name: "tg-channel",
  requires_approval: false,
  color_hue: 40,
  avatar_path: null,
};

function render(props: Partial<Parameters<typeof ChannelSurfacePicker>[0]> = {}) {
  return renderToStaticMarkup(
    React.createElement(ChannelSurfacePicker, {
      channels: [ig, telegram],
      value: [] as PostTarget[],
      onChange: noop,
      ...props,
    }),
  );
}

test("an Instagram row offers Feed and Story; a Telegram row offers neither", () => {
  const html = render();
  assert.match(html, />Feed</, "Instagram must offer a Feed chip");
  assert.match(html, />Story</, "Instagram must offer a Story chip");
  assert.match(html, /aria-label="liparoto destinations"/);
  assert.doesNotMatch(
    html,
    /aria-label="tg-channel destinations"/,
    "non-Instagram rows must stay a single plain toggle — no new concept where it doesn't apply",
  );
});

test("selecting Story alone marks Story pressed and Feed not", () => {
  const html = render({ value: [{ channel_id: 1, surface: "story" }] });
  // Feed comes first in the markup, Story second.
  const chips = html.match(/aria-pressed="(true|false)"[^>]*>(Feed|Story)</g) ?? [];
  const feed = chips.find((c) => c.endsWith(">Feed<"));
  const story = chips.find((c) => c.endsWith(">Story<"));
  assert.match(String(feed), /aria-pressed="false"/);
  assert.match(String(story), /aria-pressed="true"/);
});

test("a text-only post hides Story entirely — there is nothing to show", () => {
  const html = render({ textOnly: true });
  assert.doesNotMatch(html, />Story</);
});

test("a video post disables Story with the reason, rather than hiding it", () => {
  // Telegram can't take video at all; Instagram can, so its Story chip stays live.
  const html = render({ hasVideo: true });
  assert.match(html, />Story</, "Instagram can take a video Story");
  // renderToStaticMarkup escapes the apostrophe, so match the escaped form.
  assert.match(html, /can&#x27;t post video/, "the blocked channel must say why");
});

test("a multi-slide post says how many Stories it will become, before scheduling", () => {
  const html = render({ value: [{ channel_id: 1, surface: "story" }], slideCount: 4 });
  assert.match(html, /4 slides → 4 Stories/);
});

test("the fan-out note stays hidden when no Story is selected", () => {
  const html = render({ value: [{ channel_id: 1, surface: "feed" }], slideCount: 4 });
  assert.doesNotMatch(html, /Stories, posted back to back/);
});

test("a single-slide story shows no fan-out note", () => {
  const html = render({ value: [{ channel_id: 1, surface: "story" }], slideCount: 1 });
  assert.doesNotMatch(html, /Stories, posted back to back/);
});

// ---- toggleTarget: the pure logic the chips drive -------------------------------
test("toggling one surface leaves the channel's other surface untouched", () => {
  let targets: PostTarget[] = [{ channel_id: 1, surface: "feed" }];
  targets = toggleTarget(targets, 1, "story");
  assert.equal(hasTarget(targets, 1, "feed"), true, "feed must survive adding story");
  assert.equal(hasTarget(targets, 1, "story"), true);

  targets = toggleTarget(targets, 1, "feed");
  assert.equal(hasTarget(targets, 1, "feed"), false);
  assert.equal(hasTarget(targets, 1, "story"), true, "story must survive removing feed");
});

test("toggling a surface never touches another channel", () => {
  const targets = toggleTarget(
    [{ channel_id: 2, surface: "feed" }],
    1,
    "story",
  );
  assert.deepEqual(targets, [
    { channel_id: 2, surface: "feed" },
    { channel_id: 1, surface: "story" },
  ]);
});

// ---- Reframing notice (story canvas) ---------------------------------------------
test("a non-9:16 photo says it will be reframed, before scheduling", () => {
  const html = render({
    value: [{ channel_id: 1, surface: "story" }],
    assets: [{ width: 4032, height: 3024 }],
  });
  assert.match(html, /will be reframed to fit a Story/);
});

test("an already-9:16 photo needs no reframing notice", () => {
  const html = render({
    value: [{ channel_id: 1, surface: "story" }],
    assets: [{ width: 1320, height: 2346 }],
  });
  assert.doesNotMatch(html, /will be reframed/);
});

test("the reframing notice is absent when no Story is selected", () => {
  const html = render({
    value: [{ channel_id: 1, surface: "feed" }],
    assets: [{ width: 4032, height: 3024 }],
  });
  assert.doesNotMatch(html, /will be reframed/);
});

test("callers with no dimensions to hand simply get no notice", () => {
  const html = render({ value: [{ channel_id: 1, surface: "story" }] });
  assert.doesNotMatch(html, /will be reframed/);
});
