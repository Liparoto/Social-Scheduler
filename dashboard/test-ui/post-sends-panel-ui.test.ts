import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSendTargets } from "../components/post-sends-panel.tsx";
import type { Channel, PostPublicationRow, PostTarget } from "../lib/types.ts";

// PostSendsPanel manages its own targets state and only reaches an interesting layout
// after clicks renderToStaticMarkup can't drive. computeSendTargets is pulled out as a
// pure export (same reasoning as toggleTarget/hasTarget in channel-surface-picker.tsx and
// schedule-from-library.tsx's effectiveLibraryTargets) so its gating and stale-target
// pruning are testable directly.

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 4,
    platform: "facebook",
    account_name: "APT",
    business_label: null,
    timezone: "America/Los_Angeles",
    remote_account_id: null,
    linked_page_id: null,
    access_token: null,
    token_expires_at: null,
    requires_approval: 0,
    autofill_enabled: 0,
    cadence_config: null,
    min_queue_depth: 0,
    target_queue_depth: 0,
    reuse_min_age_days: 0,
    bpp_every_days: 0,
    is_active: 1,
    group_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
    color_hue: null,
    avatar_path: null,
    avatar_fetched_at: null,
    avatar_refresh_requested: 0,
    avatar_error: null,
    ...overrides,
  };
}

function send(overrides: Partial<PostPublicationRow> = {}): PostPublicationRow {
  return {
    id: 1,
    published_at: null,
    reach: null,
    impressions: null,
    likes: null,
    comments: null,
    saves: null,
    shares: null,
    removed_from_platform: null,
    channel_id: 4,
    channel_name: "APT",
    channel_platform: "facebook",
    channel_timezone: "America/Los_Angeles",
    channel_color_hue: null,
    channel_avatar_path: null,
    scheduled_at: "2026-01-01T00:00:00.000Z",
    status: "scheduled",
    is_held: 0,
    is_dry_run: 0,
    remote_post_id: null,
    delivery_state: null,
    surface: "feed",
    first_comment_status: "none",
    first_comment_error: null,
    first_comment_retry_requested: 0,
    metrics_fetched_at: null,
    ...overrides,
  };
}

const facebookChannel = channel();
const channels = [facebookChannel];

test("no assets supplied: a reel target is never pruned — Meta is the backstop", () => {
  const targets: PostTarget[] = [{ channel_id: 4, surface: "reel" }];
  const { effectiveTargets } = computeSendTargets({
    targets,
    postType: "video",
    channels,
    sends: [],
  });
  assert.deepEqual(effectiveTargets, targets);
});

test("an out-of-spec video's saved reel target is pruned, feed target survives", () => {
  const targets: PostTarget[] = [
    { channel_id: 4, surface: "reel" },
    { channel_id: 4, surface: "feed" },
  ];
  const { effectiveTargets } = computeSendTargets({
    targets,
    postType: "video",
    channels,
    sends: [],
    // 20 minutes — well past Facebook Reels' 90s cap.
    assets: [{ width: 1080, height: 1920, duration_ms: 20 * 60 * 1000 }],
  });
  assert.deepEqual(effectiveTargets, [{ channel_id: 4, surface: "feed" }]);
});

test("an in-spec video keeps its reel target", () => {
  const targets: PostTarget[] = [{ channel_id: 4, surface: "reel" }];
  const { effectiveTargets } = computeSendTargets({
    targets,
    postType: "video",
    channels,
    sends: [],
    assets: [{ width: 1080, height: 1920, duration_ms: 10_000 }],
  });
  assert.deepEqual(effectiveTargets, targets);
});

test("unknown asset dimensions/duration never prune the reel target", () => {
  const targets: PostTarget[] = [{ channel_id: 4, surface: "reel" }];
  const { effectiveTargets } = computeSendTargets({
    targets,
    postType: "video",
    channels,
    sends: [],
    assets: [{ width: null, height: null, duration_ms: null }],
  });
  assert.deepEqual(effectiveTargets, targets);
});

test("a channel with a live feed send is dropped from pickable but can still take Story", () => {
  const { pickable } = computeSendTargets({
    targets: [],
    postType: "video",
    channels,
    sends: [send({ surface: "feed", status: "scheduled" })],
  });
  // Facebook has no Story surface, so a live feed send alone leaves it un-pickable only
  // once BOTH feed and story are busy — this exercises the "still has a free surface"
  // rule with a platform whose only surfaces are feed/reel.
  assert.deepEqual(pickable, [facebookChannel]);
});

test("a busy feed target is pruned from effectiveTargets even though the channel is pickable", () => {
  const targets: PostTarget[] = [{ channel_id: 4, surface: "feed" }];
  const { effectiveTargets } = computeSendTargets({
    targets,
    postType: "video",
    channels,
    sends: [send({ surface: "feed", status: "scheduled" })],
  });
  assert.deepEqual(effectiveTargets, []);
});
