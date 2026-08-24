"use client";

import { channelColor } from "@/lib/format";
import { ChannelAvatar } from "@/components/ui";
import {
  platformLabel,
  supportsStory,
  supportsText,
  videoSurfaces,
} from "@/lib/platforms";
import { needsStoryCanvas } from "@/lib/story-geometry";
import type { PostTarget, Surface } from "@/lib/types";

export interface PickerChannel {
  id: number;
  platform: string;
  account_name: string;
  // 0/1 straight off the SQLite row, or a boolean from the composer's lite shape.
  requires_approval: boolean | number;
  color_hue: number | null;
  avatar_path: string | null;
}

export function hasTarget(targets: PostTarget[], channelId: number, surface: Surface) {
  return targets.some((t) => t.channel_id === channelId && t.surface === surface);
}

/** Add or remove one (channel, surface) pair, leaving every other target alone. */
export function toggleTarget(
  targets: PostTarget[],
  channelId: number,
  surface: Surface,
): PostTarget[] {
  return hasTarget(targets, channelId, surface)
    ? targets.filter((t) => !(t.channel_id === channelId && t.surface === surface))
    : [...targets, { channel_id: channelId, surface }];
}

/**
 * Pick where a post goes: which accounts, and for Instagram/Facebook which SURFACE.
 *
 * Channels with only one surface render exactly as they always have — one row, one
 * checkbox — so no new concept appears where it does not apply. Instagram rows offer Feed
 * and Story as two independent chips; a Facebook row offered a video offers Feed and Reel
 * the same way — because each pair is two independent sends: that is what lets one photo
 * be a Story on Instagram and an ordinary post on Telegram, or one video land in a
 * Facebook Page's feed as an ordinary video and ALSO as a Reel. Instagram never gets a
 * Reel chip: its feed video already IS a Reel, so a separate toggle would be a distinction
 * with no difference.
 *
 * Guards state their reason rather than silently disappearing, so an unavailable
 * destination is explained rather than merely absent.
 */
export function ChannelSurfacePicker({
  channels,
  value,
  onChange,
  textOnly = false,
  hasVideo = false,
  slideCount = 0,
  assets,
  postNow = false,
}: {
  channels: PickerChannel[];
  value: PostTarget[];
  onChange: (next: PostTarget[]) => void;
  /** A text-only post: no media, so nothing a Story could show. */
  textOnly?: boolean;
  /** The post's media is video, which some platforms can't take at all. */
  hasVideo?: boolean;
  /** How many slides the post has — a story target fans out to one Story per slide. */
  slideCount?: number;
  /** The post's assets, so a non-9:16 source can be flagged as "will be reframed" BEFORE
   *  scheduling rather than discovered afterwards. Optional: callers without dimensions to
   *  hand (the sends panel) simply don't get the note. */
  assets?: { width: number | null; height: number | null }[];
  postNow?: boolean;
}) {
  const storyCount = Math.max(slideCount, 1);
  const anyStorySelected = value.some((t) => t.surface === "story");
  // Reframing is stated up front, in the same spirit as the slide-count note below:
  // a landscape photo becomes a 9:16 canvas, and finding that out after publishing
  // is exactly the surprise this picker exists to prevent.
  const anyNeedsReframing = (assets ?? []).some((a) =>
    needsStoryCanvas(a.width ?? 0, a.height ?? 0)
  );

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {channels.map((c) => {
          const color = channelColor(c.id, c.color_hue);
          const textDisabled = textOnly && !supportsText(c.platform);
          const surfaces = videoSurfaces(c.platform);
          // A video post can only use this channel's VIDEO surfaces; an image post is
          // unaffected — surfaces.length === 0 is the same condition supportsVideo checks.
          const videoDisabled = hasVideo && surfaces.length === 0;
          const feedDisabled = textDisabled || videoDisabled;
          // A Story needs something to show, so a text-only post has no Story option at
          // all — hidden rather than disabled, since it isn't a limit of the account.
          const offersStory = supportsStory(c.platform) && !textOnly;
          // A Reel is a VIDEO surface, so it only ever appears alongside an actual video —
          // an image post never offers one, and neither does a platform without a "reel"
          // entry in videoSurfaces (Instagram included: its feed video already IS a Reel,
          // so a separate toggle there would be a distinction with no difference).
          const offersReel = hasVideo && surfaces.includes("reel");
          const feedOn = hasTarget(value, c.id, "feed");
          const storyOn = hasTarget(value, c.id, "story");
          const reelOn = hasTarget(value, c.id, "reel");
          const anyOn = feedOn || (offersStory && storyOn) || (offersReel && reelOn);

          const reason = textDisabled
            ? `${platformLabel(c.platform)} can't post text-only`
            : videoDisabled
              ? `${platformLabel(c.platform)} can't post video`
              : platformLabel(c.platform);
          const approval =
            !feedDisabled && c.requires_approval
              ? postNow
                ? " · approval skipped (Post now)"
                : " · needs approval"
              : "";

          const identity = (
            <>
              <ChannelAvatar
                id={c.id}
                name={c.account_name}
                colorHue={c.color_hue}
                avatarPath={c.avatar_path}
                size={20}
              />
              {/* channelColor's bg is a fixed LIGHT tint in every theme, so a selected
                  row must take its paired dark `fg` — on `text-ink` alone the name is
                  near-invisible in the dark themes. Same pairing as ui.tsx's ChannelChip. */}
              <span className="min-w-0">
                <span
                  className="block truncate text-sm font-medium text-ink"
                  style={anyOn && !feedDisabled ? { color: color.fg } : undefined}
                >
                  {c.account_name}
                </span>
                <span
                  className="data block text-[11px] text-muted"
                  style={anyOn && !feedDisabled ? { color: color.fg, opacity: 0.75 } : undefined}
                >
                  {reason}
                  {approval}
                </span>
              </span>
            </>
          );

          // ---- Instagram (Story) / Facebook (Reel): multiple destinations, multiple
          // chips. Same row shape either way, so there is one behaviour to learn rather
          // than two — a channel just shows whichever of Story/Reel it actually has.
          if (offersStory || offersReel) {
            return (
              <div
                key={c.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                  anyOn ? "border-transparent" : "border-border"
                }`}
                style={
                  anyOn
                    ? { backgroundColor: color.bg, boxShadow: `inset 0 0 0 2px ${color.dot}` }
                    : undefined
                }
              >
                {identity}
                <span className="ml-auto flex shrink-0 gap-1" role="group"
                      aria-label={`${c.account_name} destinations`}>
                  <SurfaceChip
                    label="Feed"
                    on={feedOn}
                    disabled={feedDisabled}
                    disabledReason={reason}
                    dot={color.dot}
                    onClick={() => onChange(toggleTarget(value, c.id, "feed"))}
                  />
                  {offersStory ? (
                    <SurfaceChip
                      label="Story"
                      on={storyOn}
                      disabled={videoDisabled}
                      disabledReason={reason}
                      dot={color.dot}
                      onClick={() => onChange(toggleTarget(value, c.id, "story"))}
                    />
                  ) : null}
                  {offersReel ? (
                    <SurfaceChip
                      label="Reel"
                      on={reelOn}
                      disabled={videoDisabled}
                      disabledReason={reason}
                      dot={color.dot}
                      onClick={() => onChange(toggleTarget(value, c.id, "reel"))}
                    />
                  ) : null}
                </span>
              </div>
            );
          }

          // ---- Everything else: unchanged single toggle ---------------------------
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(toggleTarget(value, c.id, "feed"))}
              disabled={feedDisabled}
              aria-pressed={feedOn}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                feedDisabled
                  ? "cursor-not-allowed border-border opacity-50"
                  : feedOn
                    ? "border-transparent"
                    : "border-border hover:bg-surface-sunken"
              }`}
              style={
                feedOn && !feedDisabled
                  ? { backgroundColor: color.bg, boxShadow: `inset 0 0 0 2px ${color.dot}` }
                  : undefined
              }
            >
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
                style={{
                  backgroundColor: feedOn && !feedDisabled ? color.dot : "transparent",
                  border: feedOn && !feedDisabled ? "none" : "1.5px solid var(--color-border-strong)",
                }}
              >
                {feedOn && !feedDisabled ? <span className="text-[10px] text-white">✓</span> : null}
              </span>
              {identity}
            </button>
          );
        })}
      </div>

      {/* Say the fan-out BEFORE scheduling. There is no carousel Story in the API, so a
          multi-slide post becomes one Story per slide — a surprise if discovered later. */}
      {anyStorySelected && anyNeedsReframing ? (
        <p className="mt-2 text-xs text-muted">
          Not 9:16 — will be reframed to fit a Story. Change how in Framing.
        </p>
      ) : null}
      {anyStorySelected && storyCount > 1 ? (
        <p className="mt-2 text-xs text-muted">
          {storyCount} slides → {storyCount} Stories, posted back to back in slide order.
        </p>
      ) : null}
    </div>
  );
}

function SurfaceChip({
  label,
  on,
  disabled,
  disabledReason,
  dot,
  onClick,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  disabledReason: string;
  dot: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      title={disabled ? disabledReason : undefined}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
        disabled
          ? "cursor-not-allowed border-border text-muted opacity-50"
          : on
            ? "border-transparent text-white"
            : "border-border-strong text-muted hover:bg-surface-sunken"
      }`}
      style={on && !disabled ? { backgroundColor: dot } : undefined}
    >
      {label}
    </button>
  );
}
