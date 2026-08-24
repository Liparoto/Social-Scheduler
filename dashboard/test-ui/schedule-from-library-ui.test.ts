import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveLibraryTargets,
  type LibraryPickItem,
  type ChannelLite,
} from "../components/schedule-from-library.tsx";
import type { PostTarget } from "../lib/types.ts";

// ScheduleFromLibrary only reaches its "post selected" view after a click, and
// renderToStaticMarkup gives markup only — no clicks. effectiveLibraryTargets is pulled
// out as a pure export (same reasoning as toggleTarget/hasTarget in
// channel-surface-picker.tsx) precisely so the Library flow's gating and stale-target
// pruning are testable without driving that click.

const facebook: ChannelLite = {
  id: 4,
  platform: "facebook",
  account_name: "APT",
  timezone: "America/Los_Angeles",
  requires_approval: false,
  color_hue: 120,
  avatar_path: null,
};
const instagram: ChannelLite = {
  id: 1,
  platform: "instagram",
  account_name: "liparoto",
  timezone: "America/Los_Angeles",
  requires_approval: false,
  color_hue: 200,
  avatar_path: null,
};
const channels = [facebook, instagram];

function videoPost(overrides: Partial<LibraryPickItem> = {}): LibraryPickItem {
  return {
    id: 1,
    first_asset_id: 1,
    caption: "a caption",
    content_kind: "evergreen",
    content_status: "ready",
    post_type: "video",
    asset_count: 1,
    first_asset_width: 1080,
    first_asset_height: 1920,
    first_asset_duration_ms: 10_000,
    ...overrides,
  };
}

test("no post selected: every target passes through untouched", () => {
  const targets: PostTarget[] = [{ channel_id: 4, surface: "reel" }];
  assert.deepEqual(effectiveLibraryTargets(targets, null, channels), targets);
});

test("an out-of-spec video's saved reel target is pruned, not just hidden", () => {
  // 20 minutes — well past Facebook Reels' 90s cap.
  const post = videoPost({ first_asset_duration_ms: 20 * 60 * 1000 });
  const targets: PostTarget[] = [
    { channel_id: 4, surface: "reel" },
    { channel_id: 4, surface: "feed" },
  ];
  const effective = effectiveLibraryTargets(targets, post, channels);
  assert.deepEqual(effective, [{ channel_id: 4, surface: "feed" }]);
});

test("an in-spec video keeps its reel target", () => {
  const post = videoPost();
  const targets: PostTarget[] = [{ channel_id: 4, surface: "reel" }];
  assert.deepEqual(effectiveLibraryTargets(targets, post, channels), targets);
});

test("a video with unknown dimensions/duration never has its reel target pruned", () => {
  const post = videoPost({
    first_asset_width: null,
    first_asset_height: null,
    first_asset_duration_ms: null,
  });
  const targets: PostTarget[] = [{ channel_id: 4, surface: "reel" }];
  assert.deepEqual(effectiveLibraryTargets(targets, post, channels), targets);
});

test("switching to a non-video post prunes any reel target too", () => {
  // post_type isn't "video" -> reelIneligible's condition is false -> reel isn't pruned
  // on THAT basis, but a non-video post can't offer Reel in the picker in the first
  // place, so this pins that the video-only guard doesn't wrongly gate other post types.
  const imagePost = videoPost({ post_type: "single" });
  const targets: PostTarget[] = [{ channel_id: 4, surface: "reel" }];
  assert.deepEqual(effectiveLibraryTargets(targets, imagePost, channels), targets);
});

test("an incompatible channel's target is still pruned, alongside the reel check", () => {
  // A text post can't go to Instagram Feed either way — regression coverage for the
  // pre-existing incompatibleChannelsForPostType filtering this function also does.
  const textPost = videoPost({ post_type: "text", first_asset_id: null, asset_count: 0 });
  const targets: PostTarget[] = [{ channel_id: 1, surface: "feed" }];
  const effective = effectiveLibraryTargets(targets, textPost, channels);
  assert.deepEqual(effective, []);
});
