"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { channelColor, videoPreviewSrc } from "@/lib/format";
import { platformLabel, supportsText, supportsVideo, captionLimit, PLATFORMS } from "@/lib/platforms";
import { captionsForPlatform } from "@/lib/caption-limits";
import type { Asset, Period, PeriodMode, Tag } from "@/lib/types";
import type { PublishReadiness } from "@/lib/publish-readiness";
import { CaptionVariantsEditor, type CaptionVariantDraft } from "@/components/caption-variants-editor";
import { PeriodAttach } from "@/components/period-attach";
import { TagEditor } from "@/components/tag-editor";
import { ConformControl } from "@/components/conform-control";
import { CoverFramePicker } from "@/components/cover-frame-picker";
import { PostNowReadinessNotice } from "@/components/post-now-readiness";
import { SlideReorder, type Slide } from "@/components/slide-reorder";

interface ChannelLite {
  id: number;
  platform: string;
  account_name: string;
  timezone: string;
  requires_approval: boolean;
  color_hue: number | null;
}
// Wraps the full Asset row the upload API returns (needed as-is for <CoverFramePicker>)
// plus the bits that only make sense while composing: whether this upload matched
// an existing asset by content hash, any non-blocking warnings the Reels validator
// raised (e.g. "no audio track") that the API returns but a plain image upload never
// has, and — when an out-of-spec video was silently rewritten to fit Instagram's
// limits — the before/after dimensions, so the owner can be told plainly what
// happened instead of just noticing the framing changed.
interface UploadedAsset {
  asset: Asset;
  deduped: boolean;
  warnings: string[];
  converted?: { from: string; to: string };
}

export function Composer({
  channels,
  defaultTimezone,
  periods,
  timeOfDayTags,
  topicTags,
  readiness,
}: {
  channels: ChannelLite[];
  defaultTimezone: string;
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  readiness: PublishReadiness;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  const [variants, setVariants] = useState<CaptionVariantDraft[]>([{ platform: "", body: "" }]);
  const [firstComment, setFirstComment] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [textOnly, setTextOnly] = useState(false);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [scheduledLocal, setScheduledLocal] = useState("");
  const [postNow, setPostNow] = useState(false);
  const [contentKind, setContentKind] = useState<"evergreen" | "one_time">("evergreen");
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>({});
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [libraryStatus, setLibraryStatus] = useState<"draft" | "ready">("draft");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();

  const caption =
    variants.find((v) => v.platform === "" && v.body.trim())?.body ??
    variants.find((v) => v.body.trim())?.body ??
    "";

  const captionVariantsPayload = variants
    .filter((v) => v.body.trim())
    .map((v, i) => ({ platform: v.platform || null, body: v.body.trim(), sort_order: i }));

  const periodLinksPayload = Object.entries(periodModes).map(([periodId, mode]) => ({
    periodId: Number(periodId),
    mode,
  }));

  // A reel is always exactly one video asset — mixing video with anything else, or more
  // than one video, is rejected up front in onFiles below, so "the one asset present is
  // a video" is equivalent to "this is a reel". Gated on !textOnly too: switching Text
  // only on always submits asset_ids: [] regardless of what's still sitting in `assets`
  // (see submit below), so a leftover video asset must not keep disabling every
  // text-capable channel or blocking channel selection once the post is really text-only.
  const hasVideo = !textOnly && assets.length === 1 && assets[0].asset.media_kind === "video";

  const postType = textOnly
    ? "text"
    : hasVideo
    ? "reel"
    : assets.length > 1
    ? "carousel"
    : assets.length === 1
    ? "single"
    : "—";

  // Mirrors worker/publisher.py's _select_caption's matching rules, but — like
  // captionLimitError on the server — checks the length of EVERY variant that would
  // match this platform, not just the first. The worker rotates through all of a
  // platform's variants by post count, so a second, longer variant a `.find()` would
  // never reach can still get selected on a later publish and fail terminally; showing
  // the worst (longest) candidate here keeps the counter honest about that risk.
  function worstCaptionLengthForPlatform(platform: string): number {
    const trimmedVariants = variants
      .filter((v) => v.body.trim())
      .map((v) => ({ platform: v.platform || null, body: v.body.trim() }));
    const candidates = captionsForPlatform(platform, trimmedVariants, caption);
    return Math.max(0, ...candidates.map((c) => c.length));
  }

  const selectedChannels = channels.filter((c) => selected.has(c.id));

  // One check per selected channel that actually declares a caption limit — each using
  // the worst-case caption that could actually get published to THAT platform, not the
  // generic display caption.
  const captionChecks = selectedChannels
    .map((c) => {
      const limit = captionLimit(c.platform, postType);
      return limit === null ? null : { channel: c as ChannelLite | null, limit, length: worstCaptionLengthForPlatform(c.platform) };
    })
    .filter((v): v is { channel: ChannelLite | null; limit: number; length: number } => v !== null);

  // With nothing selected yet in text-only mode, fall back to the strictest limit among
  // text-capable platforms so the counter is still meaningful before a channel is picked.
  const fallbackLimits = PLATFORMS.filter((p) => p.supportsText)
    .map((p): number | null => captionLimit(p.value, postType))
    .filter((n): n is number => n !== null);
  const fallbackCheck =
    captionChecks.length === 0 && textOnly && fallbackLimits.length > 0
      ? { channel: null, limit: Math.min(...fallbackLimits), length: caption.length }
      : null;

  const allCaptionChecks = fallbackCheck ? [fallbackCheck] : captionChecks;
  const worstCaptionCheck =
    allCaptionChecks.length > 0
      ? allCaptionChecks.reduce((worst, c) => (c.length - c.limit > worst.length - worst.limit ? c : worst))
      : null;
  const overCaptionLimit = allCaptionChecks.some((c) => c.length > c.limit);

  // Shared by the Threads text-only toggle and the video-channel gating below: drop any
  // already-selected channel that the given predicate says can no longer take this post,
  // rather than leaving it selected-but-disabled (which would submit a target that can't
  // work).
  function deselectIncompatible(isCompatible: (platform: string) => boolean) {
    setSelected((prev) => {
      const filtered = new Set<number>();
      prev.forEach((id) => {
        const channel = channels.find((c) => c.id === id);
        if (channel && isCompatible(channel.platform)) filtered.add(id);
      });
      return filtered;
    });
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setNotice(null);

    // A reel is a single video with no other media — the API rejects a mixed carousel
    // too, but catching it here gives an immediate, specific message instead of a
    // confusing 400 after the upload already completed.
    const incoming = Array.from(files);
    const incomingHasVideo = incoming.some((f) => f.type.startsWith("video/"));
    if (hasVideo) {
      setError("Remove the current video before adding more media.");
      return;
    }
    if (incomingHasVideo && (assets.length > 0 || incoming.length > 1)) {
      setError("A Reel is a single video with no other images or videos alongside it.");
      return;
    }

    setUploading(true);
    let dedupCount = 0;
    for (const file of incoming) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Couldn't upload ${file.name}.`);
        continue;
      }
      if (body.deduped) dedupCount += 1;
      setAssets((prev) =>
        prev.some((a) => a.asset.id === body.asset.id)
          ? prev
          : [
              ...prev,
              {
                asset: body.asset,
                deduped: body.deduped,
                warnings: body.warnings ?? [],
                converted: body.converted,
              },
            ]
      );
      if (body.asset.media_kind === "video") {
        // Mirrors toggleTextOnly's deselect below: a video just became this post's only
        // asset, so any selected channel that can't publish video has to go.
        deselectIncompatible(supportsVideo);
      }
    }
    if (dedupCount > 0) {
      // "file", not "image" — a video dedupes the same way, by content hash.
      const noun = dedupCount === 1 ? "file" : "files";
      setNotice(`${dedupCount} ${noun} already existed (matched by content) — reused, not duplicated.`);
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  function removeAsset(id: number) {
    setAssets((prev) => prev.filter((a) => a.asset.id !== id));
  }

  function toggleChannel(id: number) {
    const channel = channels.find((c) => c.id === id);
    if (textOnly && channel && !supportsText(channel.platform)) return;
    if (hasVideo && channel && !supportsVideo(channel.platform)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTextOnly(next: boolean) {
    setTextOnly(next);
    // Deselect any already-selected channel that can't take a text-only post — leaving
    // it selected-but-disabled would submit a target that cannot work.
    if (next) deselectIncompatible(supportsText);
  }

  const anyApprovalNeeded = channels.some(
    (c) => selected.has(c.id) && c.requires_approval
  );

  async function submit() {
    setError(null);
    if (textOnly) {
      if (!caption.trim()) return setError("Write a caption for the text post.");
    } else if (assets.length === 0) {
      return setError("Add at least one image.");
    }
    if (overCaptionLimit) {
      const names = allCaptionChecks
        .filter((c) => c.length > c.limit)
        .map((c) => (c.channel ? `${c.channel.account_name} (${c.length}/${c.limit})` : `${c.limit}-character limit`))
        .join(", ");
      return setError(`Caption is over the limit for: ${names}.`);
    }
    if (selected.size === 0) return setError("Select at least one channel.");
    if (!postNow && !scheduledLocal) return setError("Pick a date and time.");

    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caption,
        first_comment: firstComment,
        post_type: textOnly ? "text" : undefined,
        asset_ids: textOnly ? [] : assets.map((a) => a.asset.id),
        channel_ids: Array.from(selected),
        ...(postNow ? { post_now: true } : { scheduled_local: scheduledLocal }),
        timezone,
        content_kind: contentKind,
        caption_variants: captionVariantsPayload,
        period_links: periodLinksPayload,
        tag_ids: tagIds,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "Could not schedule the post.");
      return;
    }
    startSubmit(() => router.push("/"));
  }

  async function saveDraft() {
    setError(null);
    if (textOnly) {
      if (!caption.trim()) return setError("Write a caption for the text post.");
    } else if (assets.length === 0) {
      return setError("Add at least one image to save a draft.");
    }
    const res = await fetch("/api/posts/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caption,
        first_comment: firstComment,
        post_type: textOnly ? "text" : undefined,
        asset_ids: textOnly ? [] : assets.map((a) => a.asset.id),
        content_kind: contentKind,
        content_status: libraryStatus,
        target_channel_ids: Array.from(selected),
        caption_variants: captionVariantsPayload,
        period_links: periodLinksPayload,
        tag_ids: tagIds,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "Could not save the draft.");
      return;
    }
    startSubmit(() => router.push("/library"));
  }

  const label = "block text-xs font-medium text-ink-soft mb-1.5";
  const fieldCls =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand";
  const segBtn = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm transition-colors ${
      active ? "bg-brand-weak font-medium text-brand-strong" : "text-muted hover:text-ink"
    }`;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
      {/* ---- Builder ---- */}
      <div className="space-y-6">
        {/* Text only toggle */}
        <section className="flex items-center justify-between rounded-card border border-border bg-surface p-4">
          <div>
            <h3 className="font-display text-sm font-semibold text-ink">Text only</h3>
            <p className="text-xs text-muted">
              Write a caption with no image — only channels that support text posts can be
              picked.
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-ink-soft">
            <input
              type="checkbox"
              checked={textOnly}
              onChange={(e) => toggleTextOnly(e.target.checked)}
            />
            {textOnly ? "On" : "Off"}
          </label>
        </section>

        {/* Images / video */}
        {!textOnly ? (
          <section className="rounded-card border border-border bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-ink">
                {hasVideo ? "Video" : "Images"}
                <span className="data ml-2 text-xs font-normal text-faint">{postType}</span>
              </h3>
              <button
                onClick={() => fileInput.current?.click()}
                disabled={hasVideo}
                className="rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploading ? "Uploading…" : "Add media"}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
                multiple
                hidden
                onChange={(e) => onFiles(e.target.files)}
              />
            </div>

            {assets.length === 0 ? (
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  onFiles(e.dataTransfer.files);
                }}
                className="rounded-lg border border-dashed border-border-strong px-4 py-10 text-center text-sm text-muted"
              >
                Drag images or a video here, or use <span className="text-ink-soft">Add media</span>.
                <br />
                <span className="text-xs text-faint">
                  Dedup is by content — the same file won&rsquo;t be stored twice. A single
                  video becomes a Reel; it can&rsquo;t be mixed with images.
                </span>
              </div>
            ) : hasVideo ? (
              <div className="max-w-xs space-y-2">
                <CoverFramePicker asset={assets[0].asset} />
                {assets[0].converted ? (
                  <p className="inline-block rounded bg-accent-weak px-1.5 py-0.5 text-[11px] font-medium text-accent-strong">
                    Converted to {assets[0].converted.to} so Instagram will accept it. Your
                    original is untouched.
                  </p>
                ) : null}
                {assets[0].warnings.length > 0 ? (
                  <ul className="space-y-1">
                    {assets[0].warnings.map((w, i) => (
                      <li key={i} className="text-xs font-medium text-accent-strong">
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <button
                  type="button"
                  onClick={() => removeAsset(assets[0].asset.id)}
                  className="text-xs font-medium text-status-failed hover:underline"
                >
                  Remove video
                </button>
              </div>
            ) : (
              <div>
                <p className="mb-2 text-xs text-muted">
                  Drag to reorder — this is the carousel order.
                </p>
                <SlideReorder
                  slides={assets.map((a): Slide => ({
                    assetId: a.asset.id,
                    label: a.asset.original_filename ?? undefined,
                  }))}
                  onReorder={(next) =>
                    // SlideReorder only knows slide order (by assetId) — translate that
                    // back into the composer's own UploadedAsset[] so the rest of the
                    // component (upload metadata, warnings, conversion notices) rides
                    // along unchanged.
                    setAssets((prev) =>
                      next.map((s) => prev.find((a) => a.asset.id === s.assetId)!)
                    )
                  }
                  onRemove={removeAsset}
                  // Per-image framing review only applies to images (video never reaches
                  // this branch — hasVideo renders CoverFramePicker instead), so it stays
                  // composer-side rather than being baked into the shared component.
                  renderExtra={(slide) => {
                    const a = assets.find((x) => x.asset.id === slide.assetId);
                    return a?.asset.needs_review ? (
                      <ConformControl
                        assetId={a.asset.id}
                        conformMode={a.asset.conform_mode}
                        needsReview={a.asset.needs_review}
                      />
                    ) : null;
                  }}
                />
              </div>
            )}
            {notice ? <p className="mt-3 text-xs text-brand-strong">{notice}</p> : null}
          </section>
        ) : null}

        {/* Content kind */}
        <section className="rounded-card border border-border bg-surface p-5">
          <h3 className="mb-1 font-display text-sm font-semibold text-ink">Kind</h3>
          <p className="mb-3 text-xs text-muted">
            Evergreen recycles over time. One-time posts once per account, then retires.
          </p>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            <button
              type="button"
              className={segBtn(contentKind === "evergreen")}
              onClick={() => setContentKind("evergreen")}
            >
              Evergreen
            </button>
            <button
              type="button"
              className={segBtn(contentKind === "one_time")}
              onClick={() => setContentKind("one_time")}
            >
              One-time
            </button>
          </div>
        </section>

        {/* Caption + first comment */}
        <section className="rounded-card border border-border bg-surface p-5 space-y-4">
          <CaptionVariantsEditor value={variants} onChange={setVariants} postType={postType} />
          {worstCaptionCheck ? (
            <p
              className={`text-xs ${
                overCaptionLimit ? "font-medium text-accent-strong" : "text-muted"
              }`}
            >
              {worstCaptionCheck.length} / {worstCaptionCheck.limit} characters
              {worstCaptionCheck.channel ? ` for ${platformLabel(worstCaptionCheck.channel.platform)}` : ""}
              {overCaptionLimit ? " — over the limit for a selected channel." : ""}
            </p>
          ) : null}
          <div>
            <label className={label}>
              First comment{" "}
              <span className="font-normal text-faint">
                (auto-posted after publish — good for hashtags)
              </span>
            </label>
            <textarea
              className={`${fieldCls} min-h-16 resize-y`}
              placeholder="#hashtags #go #here"
              value={firstComment}
              onChange={(e) => setFirstComment(e.target.value)}
            />
          </div>
        </section>

        {/* Channels */}
        <section className="rounded-card border border-border bg-surface p-5">
          <h3 className="mb-1 font-display text-sm font-semibold text-ink">
            Where does this go?
          </h3>
          <p className="mb-3 text-xs text-muted">
            Pick the accounts. Each gets its own scheduled send.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {channels.map((c) => {
              const on = selected.has(c.id);
              const textDisabled = textOnly && !supportsText(c.platform);
              const videoDisabled = hasVideo && !supportsVideo(c.platform);
              const disabled = textDisabled || videoDisabled;
              const color = channelColor(c.id, c.color_hue);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleChannel(c.id)}
                  disabled={disabled}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    disabled
                      ? "cursor-not-allowed border-border opacity-50"
                      : on
                      ? "border-transparent"
                      : "border-border hover:bg-surface-sunken"
                  }`}
                  style={
                    on && !disabled
                      ? { backgroundColor: color.bg, boxShadow: `inset 0 0 0 2px ${color.dot}` }
                      : undefined
                  }
                >
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded"
                    style={{
                      backgroundColor: on && !disabled ? color.dot : "transparent",
                      border: on && !disabled ? "none" : "1.5px solid var(--color-border-strong)",
                    }}
                  >
                    {on && !disabled ? <span className="text-[10px] text-white">✓</span> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {c.account_name}
                    </span>
                    <span className="data block text-[11px] text-muted">
                      {textDisabled
                        ? `${platformLabel(c.platform)} can't post text-only`
                        : videoDisabled
                          ? `${platformLabel(c.platform)} can't post video`
                          : platformLabel(c.platform)}
                      {!disabled && c.requires_approval
                        ? postNow
                          ? " · approval skipped (Post now)"
                          : " · needs approval"
                        : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Schedule */}
        <section className="rounded-card border border-border bg-surface p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-ink">Schedule</h3>
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                className={segBtn(!postNow)}
                onClick={() => setPostNow(false)}
              >
                Schedule
              </button>
              <button
                type="button"
                className={segBtn(postNow)}
                onClick={() => setPostNow(true)}
              >
                Post now
              </button>
            </div>
          </div>

          {!postNow ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={label}>Date &amp; time</label>
                <input
                  type="datetime-local"
                  className={fieldCls}
                  value={scheduledLocal}
                  onChange={(e) => setScheduledLocal(e.target.value)}
                />
              </div>
              <div>
                <label className={label}>Timezone (IANA)</label>
                <input
                  className={fieldCls}
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="America/New_York"
                />
              </div>
            </div>
          ) : (
            <PostNowReadinessNotice readiness={readiness} />
          )}
        </section>

        <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />

        <section className="rounded-card border border-border bg-surface p-5">
          <h3 className="mb-2 font-display text-sm font-semibold text-ink">Tags</h3>
          <TagEditor
            timeOfDayTags={timeOfDayTags}
            topicTags={topicTags}
            value={tagIds}
            onChange={setTagIds}
          />
        </section>

        {error ? (
          <p className="rounded-lg bg-accent-weak px-3 py-2 text-sm text-accent-strong">{error}</p>
        ) : null}
      </div>

      {/* ---- Live preview (sticky) ---- */}
      <div className="lg:sticky lg:top-6 self-start space-y-4">
        <div className="rounded-card border border-border bg-surface p-4">
          <h3 className="mb-3 font-display text-xs font-semibold uppercase tracking-wide text-muted">
            Preview
          </h3>
          <div className="overflow-hidden rounded-lg border border-border">
            {textOnly ? (
              <div className="flex items-center gap-2 border-b border-border bg-surface-sunken px-3 py-2">
                <span className="data text-xs font-medium uppercase tracking-wide text-muted">
                  Text post
                </span>
              </div>
            ) : (
              <div className="aspect-square bg-surface-sunken">
                {assets[0] ? (
                  hasVideo ? (
                    // videoPreviewSrc's #t= fragment forces Safari to paint a frame on
                    // load (Chrome already does this for free); the owner's chosen
                    // cover frame is already in hand here, so the preview shows the
                    // same frame as the cover picker above instead of frame 0.
                    <video
                      src={videoPreviewSrc(assets[0].asset.id, assets[0].asset.cover_frame_ms)}
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                      controls
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/media/${assets[0].asset.id}`}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-faint">
                    First image appears here
                  </div>
                )}
              </div>
            )}
            <div className="p-3">
              <p className="whitespace-pre-wrap text-sm text-ink">
                {caption || <span className="text-faint">Your caption…</span>}
              </p>
              {firstComment ? (
                <p className="mt-2 border-t border-border pt-2 text-xs text-muted">
                  <span className="text-faint">First comment: </span>
                  {firstComment}
                </p>
              ) : null}
            </div>
          </div>
          {assets.length > 1 ? (
            <p className="data mt-2 text-center text-[11px] text-faint">
              Carousel · {assets.length} images
            </p>
          ) : null}
        </div>

        <div className="rounded-card border border-border bg-surface p-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Headed to</p>
          {selected.size === 0 ? (
            <p className="text-xs text-faint">No channels selected yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {channels
                .filter((c) => selected.has(c.id))
                .map((c) => {
                  const color = channelColor(c.id, c.color_hue);
                  return (
                    <li key={c.id} className="flex items-center gap-2 text-sm">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: color.dot }}
                      />
                      <span className="text-ink">{c.account_name}</span>
                    </li>
                  );
                })}
            </ul>
          )}
          {anyApprovalNeeded ? (
            <p className="mt-3 rounded bg-surface-sunken px-2 py-1.5 text-[11px] text-muted">
              {postNow
                ? "One or more channels require approval — Post now skips that step."
                : "One or more channels require approval — those sends wait until approved."}
            </p>
          ) : null}
        </div>

        <button
          onClick={submit}
          disabled={submitting || overCaptionLimit}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
        >
          {submitting ? (postNow ? "Sending…" : "Scheduling…") : postNow ? "Post now" : "Schedule post"}
        </button>
        <div className="rounded-card border border-border bg-surface p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink-soft">Library status</p>
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                className={segBtn(libraryStatus === "draft")}
                onClick={() => setLibraryStatus("draft")}
              >
                Draft
              </button>
              <button
                type="button"
                className={segBtn(libraryStatus === "ready")}
                onClick={() => setLibraryStatus("ready")}
              >
                Ready
              </button>
            </div>
          </div>
          <p className="text-[11px] text-faint">
            Ready content is eligible for auto-fill; drafts are not.
          </p>
        </div>
        <button
          onClick={saveDraft}
          disabled={submitting}
          className="w-full rounded-lg border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
        >
          Save to library
        </button>
        <p className="text-center text-[11px] text-faint">
          Drafts live in the Library — bulk-schedule or reuse them anytime.
        </p>
      </div>
    </div>
  );
}
