"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { channelColor } from "@/lib/format";
import { platformLabel, supportsText, maxCaptionChars, PLATFORMS } from "@/lib/platforms";
import { captionsForPlatform } from "@/lib/caption-limits";
import type { Period, PeriodMode, Tag } from "@/lib/types";
import type { ConformMode } from "@/lib/conform";
import { CaptionVariantsEditor, type CaptionVariantDraft } from "@/components/caption-variants-editor";
import { PeriodAttach } from "@/components/period-attach";
import { TagEditor } from "@/components/tag-editor";
import { ConformControl } from "@/components/conform-control";

interface ChannelLite {
  id: number;
  platform: string;
  account_name: string;
  timezone: string;
  requires_approval: boolean;
}
interface UploadedAsset {
  id: number;
  name: string;
  deduped: boolean;
  conformMode: ConformMode;
  needsReview: number;
}

export function Composer({
  channels,
  defaultTimezone,
  periods,
  timeOfDayTags,
  topicTags,
}: {
  channels: ChannelLite[];
  defaultTimezone: string;
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
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
  const [contentKind, setContentKind] = useState<"evergreen" | "one_time">("evergreen");
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>({});
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [libraryStatus, setLibraryStatus] = useState<"draft" | "ready">("draft");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const dragIndex = useRef<number | null>(null);

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

  const postType = textOnly
    ? "text"
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
      const limit = maxCaptionChars(c.platform);
      return limit === null ? null : { channel: c as ChannelLite | null, limit, length: worstCaptionLengthForPlatform(c.platform) };
    })
    .filter((v): v is { channel: ChannelLite | null; limit: number; length: number } => v !== null);

  // With nothing selected yet in text-only mode, fall back to the strictest limit among
  // text-capable platforms so the counter is still meaningful before a channel is picked.
  const fallbackLimits = PLATFORMS.filter((p) => p.supportsText)
    .map((p): number | null => p.maxCaptionChars)
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

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setNotice(null);
    setUploading(true);
    let dedupCount = 0;
    for (const file of Array.from(files)) {
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
        prev.some((a) => a.id === body.asset.id)
          ? prev
          : [
              ...prev,
              {
                id: body.asset.id,
                name: file.name,
                deduped: body.deduped,
                conformMode: body.asset.conform_mode,
                needsReview: body.asset.needs_review,
              },
            ]
      );
    }
    if (dedupCount > 0) {
      setNotice(`${dedupCount} image already existed (matched by content) — reused, not duplicated.`);
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= assets.length) return;
    setAssets((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  function removeAsset(id: number) {
    setAssets((prev) => prev.filter((a) => a.id !== id));
  }

  function toggleChannel(id: number) {
    const channel = channels.find((c) => c.id === id);
    if (textOnly && channel && !supportsText(channel.platform)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTextOnly(next: boolean) {
    setTextOnly(next);
    if (next) {
      // Deselect any already-selected channel that can't take a text-only post — leaving
      // it selected-but-disabled would submit a target that cannot work.
      setSelected((prev) => {
        const filtered = new Set<number>();
        prev.forEach((id) => {
          const channel = channels.find((c) => c.id === id);
          if (channel && supportsText(channel.platform)) filtered.add(id);
        });
        return filtered;
      });
    }
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
    if (!scheduledLocal) return setError("Pick a date and time.");

    const res = await fetch("/api/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caption,
        first_comment: firstComment,
        post_type: textOnly ? "text" : undefined,
        asset_ids: textOnly ? [] : assets.map((a) => a.id),
        channel_ids: Array.from(selected),
        scheduled_local: scheduledLocal,
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
        asset_ids: textOnly ? [] : assets.map((a) => a.id),
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

        {/* Images */}
        {!textOnly ? (
          <section className="rounded-card border border-border bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold text-ink">
                Images
                <span className="data ml-2 text-xs font-normal text-faint">{postType}</span>
              </h3>
              <button
                onClick={() => fileInput.current?.click()}
                className="rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-surface-sunken"
              >
                {uploading ? "Uploading…" : "Add images"}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
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
                Drag images here, or use <span className="text-ink-soft">Add images</span>.
                <br />
                <span className="text-xs text-faint">
                  Dedup is by content — the same file won&rsquo;t be stored twice.
                </span>
              </div>
            ) : (
              <div>
                <p className="mb-2 text-xs text-muted">
                  Drag to reorder — this is the carousel order.
                </p>
                <ul className="flex flex-wrap gap-3">
                  {assets.map((a, i) => (
                    <li
                      key={a.id}
                      draggable
                      onDragStart={() => (dragIndex.current = i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragIndex.current !== null) move(dragIndex.current, i);
                        dragIndex.current = null;
                      }}
                      className="group relative"
                    >
                      <span className="data absolute left-1 top-1 z-10 rounded bg-ink/75 px-1.5 py-0.5 text-[10px] font-medium text-white">
                        {i + 1}
                      </span>
                      <button
                        onClick={() => removeAsset(a.id)}
                        className="absolute right-1 top-1 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-ink/75 text-xs text-white group-hover:flex"
                        aria-label="Remove image"
                      >
                        ×
                      </button>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/media/${a.id}?variant=thumb`}
                        alt={a.name}
                        className="h-24 w-24 cursor-grab rounded-lg border border-border object-cover active:cursor-grabbing"
                      />
                      {a.needsReview ? (
                        <ConformControl
                          assetId={a.id}
                          conformMode={a.conformMode}
                          needsReview={a.needsReview}
                        />
                      ) : null}
                      <div className="mt-1 flex justify-center gap-1">
                        <button
                          onClick={() => move(i, i - 1)}
                          disabled={i === 0}
                          className="rounded px-1 text-xs text-muted hover:text-ink disabled:opacity-30"
                          aria-label="Move left"
                        >
                          ←
                        </button>
                        <button
                          onClick={() => move(i, i + 1)}
                          disabled={i === assets.length - 1}
                          className="rounded px-1 text-xs text-muted hover:text-ink disabled:opacity-30"
                          aria-label="Move right"
                        >
                          →
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
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
          <CaptionVariantsEditor value={variants} onChange={setVariants} />
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
              const disabled = textOnly && !supportsText(c.platform);
              const color = channelColor(c.id);
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
                      {disabled
                        ? `${platformLabel(c.platform)} can't post text-only`
                        : platformLabel(c.platform)}
                      {!disabled && c.requires_approval ? " · needs approval" : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Schedule */}
        <section className="rounded-card border border-border bg-surface p-5">
          <h3 className="mb-3 font-display text-sm font-semibold text-ink">Schedule</h3>
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
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${assets[0].id}`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
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
                  const color = channelColor(c.id);
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
              One or more channels require approval — those sends wait until approved.
            </p>
          ) : null}
        </div>

        <button
          onClick={submit}
          disabled={submitting || overCaptionLimit}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
        >
          {submitting ? "Scheduling…" : "Schedule post"}
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
