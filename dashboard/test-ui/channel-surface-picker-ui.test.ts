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
const facebook: PickerChannel = {
  id: 4,
  platform: "facebook",
  account_name: "APT",
  requires_approval: false,
  color_hue: 120,
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

// ---- Reel chip: Facebook only, video posts only ----------------------------------
test("a video post offers Facebook a Reel toggle", () => {
  const html = render({ channels: [facebook], hasVideo: true });
  assert.match(html, />Reel</);
});

test("an image post offers no Reel toggle", () => {
  const html = render({ channels: [facebook], hasVideo: false });
  assert.doesNotMatch(html, />Reel</);
});

test("instagram never offers a Reel toggle", () => {
  const html = render({ channels: [ig], hasVideo: true });
  assert.doesNotMatch(html, />Reel</);
});

test("a video post still offers Facebook Feed alongside Reel", () => {
  const html = render({ channels: [facebook], hasVideo: true });
  assert.match(html, />Feed</);
  assert.match(html, /aria-label="APT destinations"/);
});

test("selecting Reel alone marks Reel pressed and Feed not", () => {
  const html = render({
    channels: [facebook],
    hasVideo: true,
    value: [{ channel_id: 4, surface: "reel" }],
  });
  const chips = html.match(/aria-pressed="(true|false)"[^>]*>(Feed|Reel)</g) ?? [];
  const feed = chips.find((c) => c.endsWith(">Feed<"));
  const reel = chips.find((c) => c.endsWith(">Reel<"));
  assert.match(String(feed), /aria-pressed="false"/);
  assert.match(String(reel), /aria-pressed="true"/);
});

// ---- Reel chip: gated by the shared media limits (dashboard/media-limits.json), same
// as every other chip — Facebook Reels' own duration/resolution/aspect limits are one
// entry in that file, not a special case anymore. (See lib/media-limits.test.ts for
// exhaustive coverage of the limits themselves; these pin that the picker actually wires
// disabling + the inline reason to them.)
function reelButton(html: string): string {
  const m = /<button[^>]*>Reel<\/button>/.exec(html);
  assert.ok(m, "expected a Reel chip in the markup");
  return m![0];
}

test("a too-long video disables the Reel chip and shows the reason inline, not just on hover", () => {
  const html = render({
    channels: [facebook],
    hasVideo: true,
    assets: [{ width: 1080, height: 1920, duration_ms: 20 * 60 * 1000 }],
  });
  const chip = reelButton(html);
  assert.match(chip, /\bdisabled=""/);
  assert.match(chip, /title="Too long for Reels/);
  // Not just the tooltip — the same reason renders as visible text in the row. The exact
  // wording now comes from the shared media-limits.json entry (facebook.reel.video's
  // max_duration_ms), via destinationDisabledReason — not this file's own formatting.
  assert.match(html, /<p[^>]*>Too long for Reels \(longer than 90s\)<\/p>/);
});

test("a too-short video disables the Reel chip with its own reason", () => {
  const html = render({
    channels: [facebook],
    hasVideo: true,
    assets: [{ width: 1080, height: 1920, duration_ms: 1_000 }],
  });
  assert.match(reelButton(html), /\bdisabled=""/);
  assert.match(html, /Too short for Reels \(shorter than 3s\)/);
});

test("an undersized video disables the Reel chip with its own reason", () => {
  const html = render({
    channels: [facebook],
    hasVideo: true,
    assets: [{ width: 480, height: 640, duration_ms: 10_000 }],
  });
  assert.match(reelButton(html), /\bdisabled=""/);
  assert.match(html, /Too small for Reels \(smaller than 540x960\)/);
});

test("an ultrawide video disables the Reel chip as the wrong shape", () => {
  const html = render({
    channels: [facebook],
    hasVideo: true,
    assets: [{ width: 2520, height: 1080, duration_ms: 10_000 }],
  });
  assert.match(reelButton(html), /\bdisabled=""/);
  assert.match(html, /Wrong shape for Reels \(aspect ratio 2520x1080\)/);
});

test("Feed stays enabled even when Reel is disabled for spec reasons", () => {
  const html = render({
    channels: [facebook],
    hasVideo: true,
    assets: [{ width: 1080, height: 1920, duration_ms: 20 * 60 * 1000 }],
  });
  const feedChip = /<button[^>]*>Feed<\/button>/.exec(html);
  assert.ok(feedChip);
  assert.doesNotMatch(feedChip![0], /\bdisabled=""/);
});

test("the exact 3s/90s/540x960/16:9 boundaries all leave the Reel chip enabled", () => {
  const boundaryAssets = [
    { width: 1080, height: 1920, duration_ms: 3_000 },
    { width: 1080, height: 1920, duration_ms: 90_000 },
    { width: 540, height: 960, duration_ms: 10_000 },
    { width: 1920, height: 1080, duration_ms: 10_000 }, // 16:9 landscape — permitted
  ];
  for (const assets of boundaryAssets) {
    const html = render({ channels: [facebook], hasVideo: true, assets: [assets] });
    assert.doesNotMatch(
      reelButton(html),
      /\bdisabled=""/,
      `expected ${JSON.stringify(assets)} to leave Reel enabled`,
    );
  }
});

test("unknown duration/width/height never disable the Reel chip", () => {
  const unknownCases = [
    { width: null, height: null, duration_ms: null },
    { width: 1080, height: 1920, duration_ms: null },
    { width: null, height: null, duration_ms: 10_000 },
  ];
  for (const assets of unknownCases) {
    const html = render({ channels: [facebook], hasVideo: true, assets: [assets] });
    assert.doesNotMatch(
      reelButton(html),
      /\bdisabled=""/,
      `expected unknown values ${JSON.stringify(assets)} to leave Reel enabled`,
    );
  }
});

test("a caller with no assets prop at all leaves Reel enabled", () => {
  const html = render({ channels: [facebook], hasVideo: true });
  assert.doesNotMatch(reelButton(html), /\bdisabled=""/);
});

// ---- Feed chip, IMAGE assets: every prior case above passed `hasVideo: true` — none of
// them ever exercised the Feed chip against an IMAGE asset at all, which is exactly the
// gap that let the FINDING 1 regression through review. instagram.feed.image's aspect
// range (4:5..1.91:1) and 8MB cap are checked here, including the conform-aware skip: an
// asset that already has a conformed derivative (publish_path/conform_mode set) must NOT
// be checked against its own out-of-range original values, because that derivative — not
// the original — is what's actually published. See lib/media-limits.ts's
// surfaceReceivesConformedMedia and its matrix cases for the underlying mechanism; these
// pin that the picker actually wires it through, the same way the Reel section above pins
// worker parity for video.
function feedButton(html: string): string {
  const m = /<button[^>]*>Feed<\/button>/.exec(html);
  assert.ok(m, "expected a Feed chip in the markup");
  return m![0];
}

test("an ordinary iPhone portrait photo with NO conformed derivative disables the Instagram Feed chip", () => {
  // 1179x2556 (ratio ~0.461) is well outside instagram.feed.image's 4:5..1.91:1 range,
  // and this asset has no publish_path/conform_mode — the pre-conform state. The chip
  // must still say why, not just silently disable — same as every other gated chip.
  const html = render({
    channels: [ig],
    hasVideo: false,
    assets: [{ width: 1179, height: 2556 }],
  });
  assert.match(feedButton(html), /\bdisabled=""/);
  assert.match(html, /Wrong shape for the feed/);
});

test("FINDING 1 regression pin: the SAME portrait photo, already conformed, leaves the Instagram Feed chip ENABLED", () => {
  // The exact bug the final review caught: this asset has already been reframed for
  // Instagram's feed range (publish_path set, built at upload time by
  // dashboard/lib/conform.ts) — the file Meta actually receives is the cropped
  // derivative, which is in-range by construction. Checking the ORIGINAL's 1179x2556
  // against instagram.feed.image's aspect range wrongly disabled this chip for the
  // owner's most common content before this fix.
  const html = render({
    channels: [ig],
    hasVideo: false,
    assets: [{ width: 1179, height: 2556, publish_path: "pub/abc.jpg" }],
  });
  assert.doesNotMatch(feedButton(html), /\bdisabled=""/);
});

test("an oversized image with NO conformed derivative disables the Instagram Feed chip on size", () => {
  const html = render({
    channels: [ig],
    hasVideo: false,
    assets: [{ width: 1000, height: 1000, byte_size: 9_000_000 }],
  });
  assert.match(feedButton(html), /\bdisabled=""/);
  assert.match(html, /Too large for the feed/);
});

test("the same oversized image, already conformed via conform_mode alone, leaves Feed enabled", () => {
  // conform_mode set with no publish_path is still a signal this asset has a derivative
  // (the fix's OR condition) — conform.ts's encodeUnderLimit guarantees the sent file is
  // under the 8MB cap by construction, regardless of this row's own byte_size.
  const html = render({
    channels: [ig],
    hasVideo: false,
    assets: [{ width: 1000, height: 1000, byte_size: 9_000_000, conform_mode: "pad" }],
  });
  assert.doesNotMatch(feedButton(html), /\bdisabled=""/);
});

test("an in-spec image leaves the Instagram Feed chip enabled whether or not it has a derivative", () => {
  const html = render({
    channels: [ig],
    hasVideo: false,
    assets: [{ width: 1080, height: 1350 }], // 4:5, well within range
  });
  assert.doesNotMatch(feedButton(html), /\bdisabled=""/);
});

// ---- Story chip: gated by the SAME shared limits, closing the owner's original bug
// report — an over-long video could be sent to an Instagram Story and only fail at Meta,
// long after the post had already read "scheduled". ------------------------------------

function storyButton(html: string): string {
  const m = /<button[^>]*>Story<\/button>/.exec(html);
  assert.ok(m, "expected a Story chip in the markup");
  return m![0];
}

test("an over-long video disables the Instagram Story chip", () => {
  const html = render({
    channels: [ig],
    hasVideo: true,
    assets: [{ width: 1080, height: 1920, duration_ms: 600_000 }],
  });
  assert.match(html, /Too long for Stories/);
  assert.match(storyButton(html), /\bdisabled=""/);
});

test("an in-spec video leaves both Instagram chips enabled", () => {
  const html = render({
    channels: [ig],
    hasVideo: true,
    assets: [{ width: 1080, height: 1920, duration_ms: 20_000 }],
  });
  assert.doesNotMatch(html, /Too long/);
  const feedChip = /<button[^>]*>Feed<\/button>/.exec(html);
  assert.ok(feedChip);
  assert.doesNotMatch(feedChip![0], /\bdisabled=""/);
  assert.doesNotMatch(storyButton(html), /\bdisabled=""/);
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
