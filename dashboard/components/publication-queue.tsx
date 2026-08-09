"use client";

import { Fragment, useEffect, useState } from "react";
import type { PublicationRow } from "@/lib/queries";
import type { PublicationStatus, Platform } from "@/lib/types";
import { PLATFORMS, supportsMetrics } from "@/lib/platforms";
import { ChannelChip, StatusBadge } from "@/components/ui";
import { PublicationActions } from "@/components/publication-actions";
import { formatInTz, tzAbbrev, videoPreviewSrc } from "@/lib/format";
import { groupQueueRows, cancelableIds } from "@/lib/queue-groups";
import { StoryGroupHeader } from "@/components/story-group-header";
import { MediaLightbox, type LightboxAsset } from "@/components/media-lightbox";

type StatusFilter = "all" | PublicationStatus;

/**
 * Is THIS send's thumbnail a video?
 *
 * Prefers the asset's own media_kind over the post's type. post_type describes the
 * source, and a story send carries one slide of it — a story cut from a Reel is a video
 * whose post_type is 'story', and a Reel row is a video whose asset says so anyway. The
 * post_type fallback only matters for a row loaded before the query carried media_kind.
 */
function isVideoRow(p: PublicationRow): boolean {
  if (p.first_asset_media_kind) return p.first_asset_media_kind === "video";
  return p.post_type === "reel";
}

function viewerLabel(p: PublicationRow): string {
  const what = isVideoRow(p) ? "Play video" : "View image";
  if (p.story_slide_no) return `${what} — story slide ${p.story_slide_no}`;
  if (p.asset_count > 1) return `${what} — carousel, ${p.asset_count} slides`;
  return what;
}

function PlayGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function ExpandGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "scheduled", label: "Scheduled" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "posted", label: "Posted" },
  { value: "failed", label: "Failed" },
];

const selectCls =
  "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-brand";

export function PublicationQueue({
  pubs,
  channels,
  workerOnline = true,
  blockedIds = [],
}: {
  pubs: PublicationRow[];
  channels: { id: number; account_name: string; platform: string }[];
  workerOnline?: boolean;
  /**
   * Ids the SERVER judged blocked (see isBlocked in lib/format). Passed in rather than
   * derived here so the overview's counter and these rows agree on one instant, and so
   * "overdue" isn't recomputed at hydration — which would either flash the badge or
   * mismatch the server's HTML.
   */
  blockedIds?: number[];
}) {
  const blocked = new Set(blockedIds);
  // Which send's media is open, if any. Seeded with the one asset the row already has so
  // the viewer opens instantly; the rest of a carousel arrives from the fetch below.
  const [openMedia, setOpenMedia] = useState<{
    pubId: number;
    postId: number;
    label: string;
    assets: LightboxAsset[];
    /** What the row says the post has, so the fetch knows whether to bother. */
    expectedCount: number;
    /** The asset this send is for — a story send opens on ITS slide, not slide 1. */
    focusAssetId: number;
  } | null>(null);

  function openViewer(p: PublicationRow) {
    if (!p.first_asset_id) return;
    setOpenMedia({
      pubId: p.id,
      postId: p.post_id,
      label: p.post_caption || `Post ${p.post_id}`,
      assets: [
        {
          id: p.first_asset_id,
          media_kind: isVideoRow(p) ? "video" : "image",
          cover_frame_ms: p.first_asset_cover_frame_ms,
          width: p.first_asset_width,
          height: p.first_asset_height,
        },
      ],
      expectedCount: p.asset_count,
      focusAssetId: p.first_asset_id,
    });
  }

  // A queue row carries only its own asset, so the rest of a carousel is fetched when the
  // viewer opens — same approach and endpoint as the Library. If it fails, the viewer
  // simply stays the single-asset one it already was.
  const openPostId = openMedia?.postId;
  const openLoaded = (openMedia?.assets.length ?? 0) > 1;
  const openExpected = openMedia?.expectedCount ?? 0;
  useEffect(() => {
    if (openPostId === undefined || openExpected < 2 || openLoaded) return;
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/posts/${openPostId}/assets`, {
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !Array.isArray(body.assets) || body.assets.length < 2) return;
        // Guarded on the id: by the time this lands the viewer may have been closed and
        // a different send's opened.
        setOpenMedia((current) =>
          current && current.postId === openPostId
            ? { ...current, assets: body.assets }
            : current
        );
      } catch {
        // Aborted, or offline. Either way the viewer keeps working.
      }
    })();
    return () => controller.abort();
  }, [openPostId, openExpected, openLoaded]);

  const [account, setAccount] = useState<"all" | number>("all");
  const [platform, setPlatform] = useState<"all" | Platform>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  // DESTINATION, not platform: an Instagram channel has both surfaces, so this is a
  // separate axis from the platform filter above. Matches the Library's filter.
  const [destination, setDestination] = useState<"all" | "story" | "feed">("all");

  const shown = pubs.filter((p) => {
    if (account !== "all" && p.channel_id !== account) return false;
    if (platform !== "all" && p.channel_platform !== platform) return false;
    if (status !== "all" && p.status !== status) return false;
    if (destination !== "all" && p.surface !== destination) return false;
    return true;
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={account === "all" ? "all" : String(account)}
          onChange={(e) => setAccount(e.target.value === "all" ? "all" : Number(e.target.value))}
        >
          <option value="all">All accounts</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.account_name}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={platform}
          onChange={(e) => setPlatform(e.target.value as "all" | Platform)}
        >
          <option value="all">All platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          aria-label="Filter by destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value as typeof destination)}
        >
          <option value="all">All destinations</option>
          <option value="story">Stories</option>
          <option value="feed">Feed only</option>
        </select>
        <span className="data ml-auto text-[11px] text-muted">
          showing {shown.length} of {pubs.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-card border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
          No sends match these filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="px-4 py-2.5 font-medium">Post</th>
                <th className="px-4 py-2.5 font-medium">Channel</th>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {groupQueueRows(shown).map((group) => (
                <Fragment key={group.key}>
                  {group.isStoryGroup ? (
                    <StoryGroupHeader
                      slideCount={group.rows.length}
                      caption={group.rows[0].post_caption}
                      channelName={group.rows[0].channel_name}
                      cancelableIds={cancelableIds(group.rows)}
                      workerOnline={workerOnline}
                    />
                  ) : null}
                  {group.rows.map((p) => (
                <tr key={p.id} className={`border-b border-border last:border-0 align-top ${
                  group.isStoryGroup ? "bg-surface-sunken/40" : ""
                }`}>
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      {/* The whole thumbnail opens the viewer, rather than the Library's
                          corner MediaBadge: at 44px a 24px badge covers a quarter of the
                          image and leaves a target barely larger than the thumbnail
                          itself. A real <button> keeps it keyboard-reachable, and the
                          glyph on hover/focus is what advertises that it does anything. */}
                      <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-surface-sunken">
                        {p.first_asset_id ? (
                          <>
                            {isVideoRow(p) ? (
                              // No thumbnail file exists for video (no ffmpeg dependency
                              // by design) — render the real file with
                              // preload="metadata" so the browser decodes just the first
                              // frame, same approach as post-editor.tsx /
                              // cover-frame-picker.tsx. videoPreviewSrc's #t= fragment is
                              // what makes that frame actually paint in Safari.
                              <video
                                src={videoPreviewSrc(
                                  p.first_asset_id,
                                  p.first_asset_cover_frame_ms ?? undefined
                                )}
                                preload="metadata"
                                muted
                                playsInline
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={`/api/media/${p.first_asset_id}?variant=thumb`}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            )}
                            <button
                              type="button"
                              onClick={() => openViewer(p)}
                              aria-label={viewerLabel(p)}
                              title={viewerLabel(p)}
                              className="group absolute inset-0 flex items-center justify-center bg-black/0 text-white transition-colors hover:bg-black/45 focus-visible:bg-black/45 focus-visible:outline-none"
                            >
                              <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                                {isVideoRow(p) ? <PlayGlyph /> : <ExpandGlyph />}
                              </span>
                            </button>
                            {/* Says there is more behind the thumbnail, so a carousel
                                doesn't look like a single image worth one glance. */}
                            {p.asset_count > 1 && !p.story_slide_no ? (
                              <span className="data pointer-events-none absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[9px] leading-[1.4] text-white">
                                {p.asset_count}
                              </span>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                      <div className="min-w-0">
                        <p className="line-clamp-2 max-w-xs text-ink">
                          {p.surface === "story" ? (
                            <span
                              className="mr-1.5 rounded-full border border-border-strong px-1.5 py-px align-middle text-[10px] font-medium text-ink-soft"
                              title="Publishes to the Instagram Story, not the feed"
                            >
                              Story
                            </span>
                          ) : null}
                          {p.post_caption || (
                            <span className="text-faint italic">
                              {p.surface === "story" ? "Stories carry no caption" : "No caption"}
                            </span>
                          )}
                        </p>
                        <p className="data mt-0.5 text-[11px] text-faint">
                          {/* post_type describes the SOURCE post. For a story send it would
                              read "carousel · 4 imgs" while this row publishes exactly one
                              slide — so say what THIS send actually does instead. */}
                          {p.surface === "story"
                            ? p.story_slide_no && p.asset_count > 1
                              ? `Story · slide ${p.story_slide_no} of ${p.asset_count}`
                              : "Story"
                            : `${p.post_type}${p.asset_count > 1 ? ` · ${p.asset_count} imgs` : ""}`}
                          {p.remote_post_id && p.remote_post_id !== "DRYRUN"
                            ? ` · ${p.remote_post_id}`
                            : ""}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <ChannelChip
                      id={p.channel_id}
                      platform={p.channel_platform}
                      name={p.channel_name}
                      colorHue={p.channel_color_hue}
                      avatarPath={p.channel_avatar_path}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <span className="data text-xs text-ink-soft">
                      {formatInTz(p.scheduled_at, p.channel_timezone)}
                    </span>
                    <span className="data block text-[10px] text-faint">
                      {tzAbbrev(p.channel_timezone)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusBadge
                        status={blocked.has(p.id) ? "blocked" : p.status}
                        dryRun={p.is_dry_run === 1}
                      />
                      {/* Answers "why is this old post going out again?" at the point the
                          question gets asked. Auto-fill normally sends unposted content
                          first, so a repeat with no explanation reads as a bug. */}
                      {p.is_recycled === 1 ? (
                        <span
                          className="inline-flex items-center rounded-full bg-brand-weak px-2 py-0.5 text-[10px] font-medium text-brand-strong"
                          title="Auto-fill picked this again because it performed well"
                        >
                          top performer
                        </span>
                      ) : null}
                      {p.is_held === 1 ? (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{
                            color: "var(--color-status-draft)",
                            backgroundColor:
                              "color-mix(in srgb, var(--color-status-draft) 12%, white)",
                          }}
                        >
                          Held
                        </span>
                      ) : null}
                    </span>
                    {p.status === "posted" && !supportsMetrics(p.channel_platform) ? (
                      // Discord and Telegram have no metrics at all — rendering nothing here
                      // (rather than an always-empty strip or a perpetual "metrics pending…")
                      // is the same call already made for Facebook's reach and Threads' missing
                      // metric fields above.
                      null
                    ) : p.status === "posted" && p.m_fetched_at ? (
                      p.channel_platform === "facebook" ? (
                        <p className="data mt-1 flex gap-2.5 text-[11px] text-ink-soft">
                          <span title="Reactions">♥ {p.m_likes ?? "—"}</span>
                          <span title="Comments">💬 {p.m_comments ?? "—"}</span>
                          <span title="Shares">↪ {p.m_shares ?? "—"}</span>
                          {/* Reach is best-effort on Facebook (Meta keeps retiring the metric
                              names), so show it only when we actually got a number — an empty
                              slot would read as "broken" on every normal row. */}
                          {p.m_reach != null ? (
                            <span title="Reach">◎ {p.m_reach}</span>
                          ) : null}
                        </p>
                      ) : p.channel_platform === "threads" ? (
                        // Threads has neither "reach" nor "saves" as a concept — omitting
                        // them entirely (rather than showing an always-empty slot) is the
                        // same call already made for Facebook's reach above.
                        <p className="data mt-1 flex gap-2.5 text-[11px] text-ink-soft">
                          <span title="Views">👁 {p.m_impressions ?? "—"}</span>
                          <span title="Likes">♥ {p.m_likes ?? "—"}</span>
                          <span title="Replies">💬 {p.m_comments ?? "—"}</span>
                          <span title="Reposts">↻ {p.m_shares ?? "—"}</span>
                        </p>
                      ) : p.channel_platform === "instagram" ? (
                        <p className="data mt-1 flex gap-2.5 text-[11px] text-ink-soft">
                          <span title="Reach">◎ {p.m_reach ?? "—"}</span>
                          <span title="Saves">⤓ {p.m_saves ?? "—"}</span>
                          <span title="Likes">♥ {p.m_likes ?? "—"}</span>
                        </p>
                      ) : (
                        // An unrecognised platform should look wrong, not quietly inherit
                        // Instagram's metric set — matches lib/platforms.ts's fallback style.
                        <p className="data mt-1 text-[11px] text-status-failed">
                          Unknown platform &quot;{p.channel_platform}&quot; — no metrics display for it.
                        </p>
                      )
                    ) : p.status === "posted" && p.is_dry_run !== 1 ? (
                      <p className="data mt-1 text-[10px] text-faint">metrics pending…</p>
                    ) : null}
                    {p.last_error ? (
                      // Three weights, matching the badge. Red = dead, needs you. Amber =
                      // tried and couldn't, will try again, still needs your eye. Muted =
                      // a stale error on a send that is genuinely just waiting its turn.
                      // Muting a BLOCKED send was the earlier mistake: nothing was lost,
                      // but it isn't moving either, and grey-on-"Scheduled" read as fine.
                      // title= because the text is clamped to two lines — hovering must
                      // still give the whole reason rather than losing it to the clamp.
                      <p
                        title={p.last_error}
                        className={`mt-1 max-w-xs text-[11px] line-clamp-2 ${
                          p.status === "failed"
                            ? "text-status-failed"
                            : blocked.has(p.id)
                              ? "text-status-blocked"
                              : "text-faint"
                        }`}
                      >
                        {p.last_error}
                      </p>
                    ) : null}
                    {p.attempt_count > 0 && p.status !== "failed" ? (
                      <p className="data mt-0.5 text-[10px] text-faint">
                        attempt {p.attempt_count}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PublicationActions
                      id={p.id}
                      status={p.status}
                      isDryRun={p.is_dry_run === 1}
                      workerOnline={workerOnline}
                      isHeld={p.is_held === 1}
                      scheduledAt={p.scheduled_at}
                      channelTimezone={p.channel_timezone}
                      platform={p.channel_platform}
                    />
                  </td>
                </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openMedia ? (
        <MediaLightbox
          // Remounts once, when the carousel's remaining slides land. MediaLightbox reads
          // initialIndex in a useState initializer, so a story send — which opens on its
          // OWN slide — would otherwise be pinned to 0 by the single-asset array it
          // opened with and never move when the real set arrives. Keyed on the length so
          // this happens exactly once per open, before anyone can press play.
          key={`${openMedia.pubId}:${openMedia.assets.length}`}
          assets={openMedia.assets}
          initialIndex={Math.max(
            0,
            openMedia.assets.findIndex((a) => a.id === openMedia.focusAssetId)
          )}
          label={openMedia.label}
          onClose={() => setOpenMedia(null)}
        />
      ) : null}
    </div>
  );
}
