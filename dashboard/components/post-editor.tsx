"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BppMark } from "@/components/bpp-mark";
import type {
  Asset,
  Channel,
  ContentKind,
  ContentStatus,
  Period,
  PeriodMode,
  Post,
  PostPublicationRow,
  PostTarget,
  Tag,
} from "@/lib/types";
import { channelColor } from "@/lib/format";
import { isPostDirty } from "@/lib/post-editor-dirty";
import { ChannelSurfacePicker } from "@/components/channel-surface-picker";
import { incompatibleChannelsForPostType, platformLabel } from "@/lib/platforms";
import type { PublishReadiness } from "@/lib/publish-readiness";
import { CarouselReorder, useAssetOrder } from "@/components/carousel-reorder";
import { CaptionVariantsEditor, overLimitCaptionVariants } from "./caption-variants-editor";
import { FIRST_COMMENT_MAX_CHARS } from "@/lib/caption-limits";
import { captionLength } from "@/lib/caption-length";
import { TagEditor } from "./tag-editor";
import { PeriodAttach } from "./period-attach";
import { FramingButton } from "./framing-button";
import { CoverFramePicker } from "./cover-frame-picker";
import { MediaBadge, MediaLightbox, type LightboxAsset } from "./media-lightbox";
import { UnmergeModal } from "./unmerge-modal";
import { ExtractSlidesModal } from "./extract-slides-modal";
import { PostSendsPanel } from "./post-sends-panel";
import { ChannelAvatar } from "@/components/ui";

const card = "rounded-card border border-border bg-surface p-5";
const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-strong" : "text-muted hover:text-ink"
  }`;

// targetKeys and the dirty check itself live in lib/post-editor-dirty.ts so they can be
// unit-tested — the guard is what stops "Post now" and "Split into separate posts" acting on
// stale, already-saved values, and it was silently missing two fields before it had tests.

export function PostEditor({
  post,
  assets,
  scheduledSendCounts,
  channels,
  sends,
  sendableChannels,
  periods,
  timeOfDayTags,
  topicTags,
  initialTargets,
  initialTagIds,
  initialPeriods,
  initialCaptions,
  readiness,
}: {
  post: Post;
  assets: Asset[];
  /** assetId -> scheduled-but-unsent sends, for the framing dialog's warning. */
  scheduledSendCounts: Record<number, number>;
  channels: Channel[];
  sends: PostPublicationRow[];
  sendableChannels: Channel[];
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  initialTargets: PostTarget[];
  initialTagIds: number[];
  initialPeriods: Record<number, PeriodMode>;
  initialCaptions: { platform: string; body: string }[];
  readiness: PublishReadiness;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Slide order is only editable for a carousel: a single or a Reel has one slide, and
  // there is nothing to order. Hooks can't be conditional, so this always runs and the
  // carousel check happens at render.
  const slideOrder = useAssetOrder(post.id, assets);
  const [savingOrder, setSavingOrder] = useState(false);
  const isCarousel = post.post_type === "carousel" && assets.length > 1;
  // Deliberately excludes 'publishing': a send already mid-publish can't be reordered at
  // all, so counting it here would make the "will go out in this order" notice promise
  // something for a send it doesn't apply to. Quick edit's own reorder notice must agree
  // with this — see queued_publication_count in queries.ts / quick-edit-modal.tsx.
  const queuedSendCount = sends.filter(
    (s) => s.status === "scheduled" || s.status === "pending_approval"
  ).length;
  const [openMedia, setOpenMedia] = useState<{ asset: LightboxAsset; label: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unmergeOpen, setUnmergeOpen] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [kind, setKind] = useState<ContentKind>(post.content_kind);
  const [status, setStatus] = useState<ContentStatus>(post.content_status);
  const [cooldown, setCooldown] = useState(
    post.cooldown_days === null ? "" : String(post.cooldown_days)
  );
  // Targets, not channel ids: Instagram's Feed and Story are independent destinations.
  const [targets, setTargets] = useState<PostTarget[]>(initialTargets);
  const [tagIds, setTagIds] = useState<number[]>(initialTagIds);
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>(initialPeriods);
  const [captions, setCaptions] = useState(
    initialCaptions.length ? initialCaptions : [{ platform: "", body: "" }]
  );
  const [firstComment, setFirstComment] = useState(post.first_comment ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Channels that can't publish this post's type at all (e.g. a 'reel' targeted at a
  // platform with no publish path for one) — disabled here rather than offered and
  // left to fail terminally at autofill/publish time. Mirrors library-view.tsx,
  // post-sends-panel.tsx and schedule-from-library.tsx, which all gate the same way;
  // this was the one target picker that didn't.
  const incompatibleChannelIds = useMemo(
    () => new Set(incompatibleChannelsForPostType(post.post_type, channels).map((c) => c.id)),
    [channels, post.post_type]
  );
  // Derived, not written back into `targets` state — same reasoning as library-view.tsx's
  // effectiveChans: nothing to keep in sync if the incompatible set ever changes.
  const effectiveTargets = useMemo(
    () => targets.filter((t) => !incompatibleChannelIds.has(t.channel_id)),
    [targets, incompatibleChannelIds]
  );

  // Post now publishes whatever is currently saved in the database — not whatever is
  // sitting in this component's state. If the editor has unsaved changes, "Post now"
  // would silently publish the stale, already-saved version. Compare the editable
  // fields that actually feed a publish (captions, targets, tags, content status)
  // against the props this component was initialised with, so a scroll-and-click from
  // "fix a typo" straight to "Post now" gets caught instead of shipping the typo.
  const isDirty = isPostDirty({
    captions,
    initialCaptions,
    targets: effectiveTargets,
    initialTargets,
    tagIds,
    initialTagIds,
    status,
    initialStatus: post.content_status,
    kind,
    initialKind: post.content_kind,
    cooldown,
    initialCooldownDays: post.cooldown_days,
    firstComment,
    initialFirstComment: post.first_comment,
  });

  async function save() {
    setError(null);
    setNotice(null);
    const overLimit = overLimitCaptionVariants(captions, post.post_type);
    if (overLimit.length > 0) {
      setError(
        `Caption is over the limit for: ${overLimit
          .map((v) => `${platformLabel(v.platform)} (${v.length}/${v.limit})`)
          .join(", ")}.`
      );
      return;
    }
    if (captionLength(firstComment.trim()) > FIRST_COMMENT_MAX_CHARS) {
      setError(
        `First comment is ${captionLength(firstComment.trim())} / ${FIRST_COMMENT_MAX_CHARS} characters.`
      );
      return;
    }
    const body = {
      first_comment: firstComment,
      content_kind: kind,
      content_status: status,
      cooldown_days: cooldown.trim() === "" ? null : Number(cooldown),
      targets: effectiveTargets,
      tag_ids: tagIds,
      period_links: Object.entries(periodModes).map(([pid, mode]) => ({
        periodId: Number(pid),
        mode,
      })),
      caption_variants: captions
        .filter((v) => v.body.trim())
        .map((v, i) => ({ platform: v.platform || null, body: v.body.trim(), sort_order: i })),
    };
    const res = await fetch(`/api/posts/${post.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not save changes.");
      return;
    }
    setNotice("Changes saved.");
    startTransition(() => router.refresh());
  }

  async function saveSlideOrder() {
    if (savingOrder) return;
    setSavingOrder(true);
    const ok = await slideOrder.save();
    setSavingOrder(false);
    // Re-fetch so the strip, the send panel, and anything else reading assets agree with
    // what was just written — the same refresh the caption save already does.
    if (ok) startTransition(() => router.refresh());
  }

  async function deletePost() {
    setDeleteError(null);
    setDeleting(true);
    const res = await fetch(`/api/posts/${post.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setDeleteError(b.error ?? "Could not delete this post.");
      setConfirmDelete(false);
      return;
    }
    router.push("/library");
  }

  return (
    <div className="space-y-6">
      {openMedia ? (
        <MediaLightbox
          assets={[openMedia.asset]}
          label={openMedia.label}
          onClose={() => setOpenMedia(null)}
        />
      ) : null}
      {/* Read-only context strip */}
      <section className={card}>
        <div className="flex items-start gap-4">
          {isCarousel ? (
            <div className="space-y-2">
              <CarouselReorder
                assets={assets}
                order={slideOrder.order}
                onOrderChange={slideOrder.setOrder}
                queuedSendCount={queuedSendCount}
                // Same per-image framing review the non-carousel branch below renders —
                // this component has the full Asset[] server-side, so it can supply the
                // control directly rather than widening OrderableAsset for it.
                renderExtra={(assetId) => {
                  const a = assets.find((x) => x.id === assetId);
                  // Rendered unconditionally: gating on needs_review is the second half of
                  // the one-way bug — the control vanished once a choice was made.
                  return a ? (
                    <FramingButton
                      asset={a}
                      scheduledSendCount={scheduledSendCounts[a.id] ?? 0}
                    />
                  ) : null;
                }}
              />
              {slideOrder.error ? (
                <p className="text-xs text-status-failed">{slideOrder.error}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveSlideOrder}
                  disabled={!slideOrder.isDirty || savingOrder}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-ink transition-colors hover:bg-surface-sunken disabled:opacity-40"
                >
                  {savingOrder ? "Saving…" : "Save order"}
                </button>
                <button
                  type="button"
                  onClick={slideOrder.reset}
                  disabled={!slideOrder.isDirty || savingOrder}
                  className="rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-ink disabled:opacity-40"
                >
                  Reset
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              {assets.length ? (
                assets.slice(0, 4).map((a) =>
                  a.media_kind === "video" ? (
                    <div key={a.id} className="w-40">
                      {/* MediaBadge positions itself bottom-right of its nearest positioned
                          ancestor, so the slot goes around the picker's VIDEO — not around
                          the whole picker, whose scrubber and Save control sit underneath. */}
                      <CoverFramePicker
                        asset={a}
                        overlay={
                          <MediaBadge
                            mediaKind="video"
                            label={post.caption ?? undefined}
                            onOpen={() =>
                              setOpenMedia({ asset: a, label: post.caption || `Post ${post.id}` })
                            }
                          />
                        }
                      />
                    </div>
                  ) : (
                    <div key={a.id}>
                      <div className="relative h-16 w-16">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/media/${a.id}?variant=thumb`}
                          alt=""
                          className="h-16 w-16 rounded-lg object-cover"
                        />
                        <MediaBadge
                          mediaKind="image"
                          label={post.caption ?? undefined}
                          onOpen={() =>
                            setOpenMedia({ asset: a, label: post.caption || `Post ${post.id}` })
                          }
                        />
                      </div>
                      <FramingButton
                        asset={a}
                        scheduledSendCount={scheduledSendCounts[a.id] ?? 0}
                      />
                    </div>
                  )
                )
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-surface-sunken text-center text-xs text-faint">
                  {post.post_type === "text" ? "Text post" : "no image"}
                </div>
              )}
            </div>
          )}
          <div className="data text-xs text-ink-soft">
            <p>{post.post_type}{assets.length > 1 ? ` · ${assets.length} imgs` : ""}</p>
            <p className="mt-1 text-muted">Schedule status: {post.status}</p>
            <p className="mt-0.5 text-faint">Images and scheduling are managed elsewhere.</p>
          </div>
        </div>
      </section>

      {/* Kind */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Kind</h3>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <button type="button" className={segBtn(kind === "evergreen")} onClick={() => setKind("evergreen")}>
            Evergreen
          </button>
          <button type="button" className={segBtn(kind === "one_time")} onClick={() => setKind("one_time")}>
            One-time
          </button>
        </div>

        {/* Marking lives here as well as on the leaderboard: a post is often recognised
            as a keeper while being edited, and having to go find it again on another
            screen is exactly the friction that leaves the pool empty.

            Saved on click via its own endpoint rather than with the rest of the form —
            the mark is a one-word decision, and making it wait behind an unrelated Save
            (or lose it on a discard) would be worse than the extra request. */}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <BppMark postId={post.id} initial={Boolean(post.is_bpp)} />
          <span className="text-[11px] text-muted">
            {post.is_bpp
              ? "In your BPP pool — auto-fill will bring it back on the cadence you set."
              : "Mark it if it performed well and is worth running again."}
          </span>
        </div>
      </section>

      {/* Caption variants */}
      <section className={card}>
        <CaptionVariantsEditor value={captions} onChange={setCaptions} postType={post.post_type} />
      </section>

      {/* First comment */}
      <section className={card}>
        <h3 className="mb-1 font-display text-sm font-semibold text-ink">First comment</h3>
        <p className="mb-3 text-xs text-muted">
          Posted automatically once the post is live — the usual home for hashtags. On
          Threads it goes out as a reply, which shows in your feed like any other post.
        </p>
        <textarea
          className="min-h-16 w-full resize-y rounded-md border border-border bg-canvas px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          placeholder="#hashtags #go #here"
          value={firstComment}
          onChange={(e) => setFirstComment(e.target.value)}
        />
        {firstComment.trim().length > 0 ? (
          <p
            className={`mt-1 text-xs ${
              captionLength(firstComment.trim()) > FIRST_COMMENT_MAX_CHARS ? "text-danger" : "text-faint"
            }`}
          >
            {captionLength(firstComment.trim())} / {FIRST_COMMENT_MAX_CHARS} characters
          </p>
        ) : null}
      </section>

      {/* Targets */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Target accounts</h3>
        <p className="mb-3 text-xs text-muted">Which accounts auto-fill can post this to.</p>
        <ChannelSurfacePicker
          channels={channels}
          value={effectiveTargets}
          onChange={setTargets}
          hasVideo={post.post_type === "reel"}
          textOnly={post.post_type === "text"}
          slideCount={assets.length}
        />
      </section>

      {/* Tags */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Tags</h3>
        <TagEditor timeOfDayTags={timeOfDayTags} topicTags={topicTags} value={tagIds} onChange={setTagIds} />
      </section>

      {/* Periods */}
      <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />

      {/* Scheduled sends (retarget/hold/remove/add) */}
      <PostSendsPanel
        postId={post.id}
        postType={post.post_type}
        slideCount={assets.length}
        sends={sends}
        channels={sendableChannels}
        readiness={readiness}
        dirty={isDirty}
      />

      {/* Content status + cooldown + save */}
      <section className={card}>
        <h3 className="mb-1 font-display text-sm font-semibold text-ink">Content status</h3>
        <p className="mb-2 text-xs text-muted">Ready content is eligible for auto-fill; drafts and retired are not.</p>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <button type="button" className={segBtn(status === "draft")} onClick={() => setStatus("draft")}>Draft</button>
          <button type="button" className={segBtn(status === "ready")} onClick={() => setStatus("ready")}>Ready</button>
          <button type="button" className={segBtn(status === "retired")} onClick={() => setStatus("retired")}>Retired</button>
        </div>

        <div className="mt-4">
          <label className="block text-xs font-medium text-ink-soft mb-1">
            Cooldown override (days) <span className="text-faint">— blank = channel default</span>
          </label>
          <input
            type="number"
            min={0}
            className="w-40 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand"
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
          />
        </div>

        {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-status-posted">{notice}</p> : null}

        <div className="mt-4 flex justify-end">
          <button
            onClick={save}
            disabled={pending}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </section>

      {/* Break a carousel up — the inverse of merge. Deliberately NOT in the destructive-red
          card below it: nothing is deleted, the photos are shared with the new posts, and this
          post keeps its id and its history. Both actions live together because they are the
          same family of operation: all of it, or just the ones you pick. */}
      {isCarousel ? (
        <section className={card}>
          <h3 className="mb-1 font-display text-sm font-semibold text-ink">Break this up</h3>
          <p className="mb-3 text-sm text-muted">
            Split all {assets.length} photos into separate posts, or pull out just the ones you
            pick and keep the rest together. No photos are deleted.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setUnmergeOpen(true)}
              disabled={isDirty || slideOrder.isDirty}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
            >
              Split into separate posts…
            </button>
            <button
              type="button"
              onClick={() => setExtractOpen(true)}
              disabled={isDirty || slideOrder.isDirty}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
            >
              Pull slides out…
            </button>
          </div>
          {isDirty || slideOrder.isDirty ? (
            <p className="mt-2 text-xs text-status-failed">
              Save your changes first — both of these copy what&apos;s saved.
            </p>
          ) : null}
        </section>
      ) : null}
      {extractOpen ? (
        <ExtractSlidesModal
          postId={post.id}
          slides={assets.map((a) => ({ assetId: a.id, mediaKind: a.media_kind }))}
          onClose={() => setExtractOpen(false)}
          onExtracted={() => {
            setExtractOpen(false);
            // Stay on this post — it survives, holding the slides that weren't pulled out.
            // router.refresh() re-runs the server component so its slides, its type, and
            // this card's counts all update.
            startTransition(() => router.refresh());
          }}
        />
      ) : null}
      {unmergeOpen ? (
        <UnmergeModal
          postId={post.id}
          slideCount={assets.length}
          onClose={() => setUnmergeOpen(false)}
          onUnmerged={() => {
            setUnmergeOpen(false);
            // Stay on this post — it survives, and it is now a single. router.refresh() re-runs
            // the server component so its slides, type, and the now-absent Split card all update.
            startTransition(() => router.refresh());
          }}
        />
      ) : null}
      {/* Delete post — guarded, irreversible */}
      <section className="rounded-card border border-status-failed/30 bg-surface p-5">
        <h3 className="mb-1 font-display text-sm font-semibold text-status-failed">Delete post</h3>
        <p className="mb-3 text-xs text-muted">
          This deletes the post and all its scheduled/failed sends (shared images are kept).
        </p>
        {deleteError ? <p className="mb-3 text-sm text-status-failed">{deleteError}</p> : null}
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <button
              onClick={deletePost}
              disabled={deleting}
              className="rounded-lg bg-status-failed px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Confirm delete post"}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-ink disabled:opacity-50"
            >
              Keep post
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="rounded-lg border border-status-failed px-4 py-2 text-sm font-medium text-status-failed hover:bg-status-failed/10"
          >
            Delete post…
          </button>
        )}
      </section>
    </div>
  );
}
