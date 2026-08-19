"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PeriodAttach } from "@/components/period-attach";
import { TagEditor } from "@/components/tag-editor";
import { useAssetOrder, type OrderableAsset } from "@/components/use-asset-order";
import { PostMediaEditor } from "@/components/post-media-editor";
import {
  CaptionVariantsEditor,
  overLimitCaptionVariants,
  type CaptionVariantDraft,
} from "@/components/caption-variants-editor";
import {
  collapsePeriodLinks,
  periodLinksToSave,
  periodModesKey,
} from "@/lib/quick-edit-periods";
import {
  captionVariantsToSave,
  captionsKey,
  captionsToDrafts,
  genericCaptionLimit,
  overLimitGenericCaptions,
} from "@/lib/quick-edit-captions";
import { platformLabel } from "@/lib/platforms";
import { useModalLayer } from "@/components/use-modal-focus-trap";
import type { ContentKind, ContentStatus, Period, PeriodMode, Tag } from "@/lib/types";

/**
 * Edit one post's common metadata without leaving the Library — status, kind, cooldown,
 * tags and period links. Saves through the SAME `PATCH /api/posts/[id]/content` the full
 * editor at `/library/[id]` uses, so there is only ever one write path and one set of
 * validators to keep correct.
 *
 * Deliberately NOT here: scheduled sends and targets. Those have real consequences and
 * already have considered UI in the full editor. Fields this dialog doesn't send are left
 * untouched by the route. (Slides ARE here — see PostMediaEditor below — because adding a
 * photo to the post you're already editing shouldn't mean leaving the page.)
 *
 * Everything except the captions is passed in from the Library list, which already carries
 * it. Captions are fetched on open instead — they are the bulk of a post's text and
 * per-platform variants multiply it, so shipping every post's captions to serve a dialog
 * that opens one post at a time is the wrong trade.
 *
 * ⚠️ A save must never destroy captions that never arrived. PATCH replaces variants
 * wholesale, so until the fetch succeeds the request omits `caption_variants` entirely —
 * the route leaves absent fields alone, so the other fields still save normally.
 *
 * DIRTY-STATE BEHAVIOUR: **confirm-on-dismiss** (decided 2026-08-03, recorded in
 * docs/tasks.md). Every dismissal path — Cancel, the ✕, Esc and click-outside — asks
 * "Discard changes?" while anything differs from what the dialog opened with. Dismissing
 * with no changes closes silently, so there is no friction when nothing is at stake.
 *
 * Why it matters: this project has already been bitten once by an unsaved edit looking
 * saved (Post-now published the stale saved caption, so PostEditor now blocks the submit
 * while dirty). A modal makes that easier to hit, not harder — Esc and a stray click both
 * dismiss it. Save-then-close was rejected: an accidental Esc would write to the DB with
 * no way to back out, and a save that fails after the dialog is gone has nowhere to report
 * itself. An edit is never silently dropped and never silently committed.
 */

export interface QuickEditPost {
  id: number;
  caption: string | null;
  post_type: string;
  content_status: ContentStatus;
  content_kind: ContentKind;
  cooldown_days: number | null;
  tag_ids: number[];
  /** Every link as stored — a period may appear twice, once per mode. */
  periods: { id: number; mode: PeriodMode }[];
  /** Distinct platforms this post targets — what a generic caption is held to. */
  target_platforms: string[];
  /** How many slides — the dialog only offers reordering for a real carousel. */
  asset_count: number;
  /**
   * Sends genuinely still queued (scheduled + pending_approval), so the reorder block can
   * say they'll go out in the new order. Deliberately NOT scheduled_count, which also
   * counts 'publishing' — a send already mid-publish can't be reordered at all, so
   * promising it will "go out in this order" would be wrong.
   */
  queued_publication_count: number;
  /**
   * Has any send of this post reached the platform — 'posted' or 'publishing'?
   *
   * The media strip's controls are disabled on it. Both callers already have it: the
   * Library's list query carries it per row, and the Overview's QueueQuickEdit gets it
   * inside `quick_edit` from GET /api/posts/[id]/content.
   */
  has_live_send: boolean;
}

export function QuickEditModal({
  post,
  periods,
  timeOfDayTags,
  topicTags,
  initialCaptions,
  note,
  onMediaChanged,
  onClose,
  onSaved,
}: {
  post: QuickEditPost;
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  /**
   * Captions the caller already has, which skips the fetch below.
   *
   * For a caller that reached this dialog through GET /api/posts/[id]/content — the
   * Overview queue, which needs that route anyway to learn the post's content model —
   * the response already carried the variants. Refetching the identical URL a moment
   * later would be the same round trip twice.
   *
   * ⚠️ Pass this ONLY when the captions genuinely arrived. Passing [] for "not loaded
   * yet" would read as "this post has no captions" and the first save would write that
   * emptiness over the real ones — the exact wipe the null-until-loaded state exists to
   * prevent. Leave it undefined and let the dialog fetch.
   */
  initialCaptions?: CaptionVariantDraft[];
  /** One line of context under the title, for callers that opened this from elsewhere. */
  note?: string;
  /**
   * The post's media just changed, so anything the CALLER derived from it is now stale.
   *
   * The Library passes `post` straight down from a server-rendered list, so router.refresh()
   * fixes it. The Overview's QueueQuickEdit holds it in local state from a one-shot fetch
   * that a route refresh never touches, and `post_type` — which sets the caption limits —
   * moves when a second slide is added. That caller re-fetches through this.
   */
  onMediaChanged?: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  // Not the bare router.refresh() the rest of this file avoids: a refresh outside a
  // transition drops the pending indicator, and the first loading.tsx anyone adds would
  // unmount this dialog mid-edit.
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<ContentStatus>(post.content_status);
  const [kind, setKind] = useState<ContentKind>(post.content_kind);
  const [cooldown, setCooldown] = useState(
    post.cooldown_days === null ? "" : String(post.cooldown_days)
  );
  const [tagIds, setTagIds] = useState<number[]>(post.tag_ids);
  // What the dialog opened with, collapsed to the one-mode-per-period shape PeriodAttach
  // edits. The uncollapsed post.periods stays the reference for both the dirty check and
  // the save payload — see lib/quick-edit-periods.ts.
  const openedPeriodModes = collapsePeriodLinks(post.periods);
  const [periodModes, setPeriodModes] =
    useState<Record<number, PeriodMode>>(openedPeriodModes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // openedCaptions stays null until the fetch lands. While it is null the dialog has no
  // idea what this post's captions are, so it must not send any — see the header. A
  // caller that already fetched them hands them over and this starts out non-null.
  const [openedCaptions, setOpenedCaptions] = useState<CaptionVariantDraft[] | null>(
    initialCaptions ?? null
  );
  const [captions, setCaptions] = useState<CaptionVariantDraft[]>(initialCaptions ?? []);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [captionAttempt, setCaptionAttempt] = useState(0);

  const hasInitialCaptions = initialCaptions !== undefined;
  useEffect(() => {
    if (hasInitialCaptions) return;
    const controller = new AbortController();
    async function loadCaptions() {
      try {
        const res = await fetch(`/api/posts/${post.id}/content`, {
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not load this post's captions.");
        if (!Array.isArray(body.caption_variants)) {
          throw new Error("The caption response was incomplete.");
        }
        const drafts = captionsToDrafts(body.caption_variants);
        setOpenedCaptions(drafts);
        setCaptions(drafts);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setCaptionError(
          loadError instanceof Error ? loadError.message : "Could not load this post's captions."
        );
      }
    }
    loadCaptions();
    return () => controller.abort();
  }, [post.id, captionAttempt, hasInitialCaptions]);

  // null until the fetch lands. While it is null there is nothing to reorder and nothing
  // to save — exactly like openedCaptions above. Carries cover_frame_ms too, on top of
  // what OrderableAsset declares: reordering only ever needed id/media_kind, but
  // PostMediaEditor's EditorSlide needs cover_frame_ms as well (it draws a video slide's
  // cover frame), and GET /api/posts/[id]/assets already returns it.
  const [orderAssets, setOrderAssets] = useState<
    (OrderableAsset & { cover_frame_ms: number | null })[] | null
  >(null);

  // Loads unconditionally, not just for a carousel. Reordering only ever needed these for
  // a multi-slide post, but adding media needs them for a single too — and `post.post_type`
  // / `post.asset_count` come from the Library list, so they go stale the moment media
  // changes. `orderAssets` is the live truth once it lands.
  // Which reload is the current one. Two removals in quick succession fire two of these,
  // and without the check the SLOWER response wins — leaving a slide the user just deleted
  // sitting on screen until something else refetched.
  const reloadSeq = useRef(0);
  const reloadSlides = useCallback(async (signal?: AbortSignal) => {
    const seq = ++reloadSeq.current;
    try {
      const res = await fetch(`/api/posts/${post.id}/assets`, { signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body.assets)) return;
      if (seq !== reloadSeq.current) return;
      setOrderAssets(body.assets);
    } catch {
      // A failed load leaves the dialog exactly as it is today: captions and scheduling
      // still work, there is simply no media block. Not worth an error banner.
    }
  }, [post.id]);

  useEffect(() => {
    const controller = new AbortController();
    // reloadSlides only setState after its await, same fetch-on-mount/abort-on-cleanup
    // shape as the captions effect above — the linter can't see through the useCallback
    // indirection to confirm that, the same reason update-banner.tsx's check() effect
    // carries this same disable.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above.
    reloadSlides(controller.signal);
    return () => controller.abort();
  }, [reloadSlides]);

  // Derived from the fetched slides, not post.post_type/post.asset_count: those are the
  // Library list's snapshot and do not move when media is added or removed here.
  const isCarousel = (orderAssets?.length ?? 0) > 1;

  const slideOrder = useAssetOrder(post.id, orderAssets ?? []);

  const field =
    "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";

  // Compared against the values this dialog opened with, field by field, so re-picking a
  // tag you just removed reads as clean rather than as a change. Ids are sorted because
  // TagEditor appends in click order; periods go through periodModesKey for the same
  // reason. Both sides of the period comparison are collapsed — comparing the edited
  // collapse against the raw links would report a two-mode post dirty before it was ever
  // touched, which is precisely the false friction confirm-on-dismiss must not create.
  const sortedIds = (ids: number[]) => JSON.stringify([...ids].sort((a, b) => a - b));
  const cooldownValue = cooldown.trim() === "" ? null : Number(cooldown);
  const isDirty =
    status !== post.content_status ||
    kind !== post.content_kind ||
    cooldownValue !== post.cooldown_days ||
    sortedIds(tagIds) !== sortedIds(post.tag_ids) ||
    periodModesKey(periodModes) !== periodModesKey(openedPeriodModes) ||
    // Captions can't be dirty before they've arrived — there is nothing to have changed.
    (openedCaptions !== null && captionsKey(captions) !== captionsKey(openedCaptions)) ||
    slideOrder.isDirty;

  // What a generic ("Any") caption is really held to. <CaptionVariantsEditor> shows no
  // counter for it, because captionLimit("") is null — but that row is what publishes for
  // a post with no per-platform variant, so the strictest targeted platform's limit does
  // apply to it. Null when no targeted platform has a configured limit.
  const genericLimit = genericCaptionLimit(post.target_platforms, captions, post.post_type);
  const genericLength = captions.find((c) => c.platform === "")?.body.trim().length ?? 0;
  const overLimit = [
    ...overLimitCaptionVariants(captions, post.post_type).map(
      (v) => `${platformLabel(v.platform)} (${v.length}/${v.limit})`
    ),
    ...overLimitGenericCaptions(post.target_platforms, captions, post.post_type).map(
      (v) => `${v.label} (${v.length}/${v.limit})`
    ),
  ];

  // This dialog's place on the app-wide modal stack. See use-modal-focus-trap.ts.
  const layer = useModalLayer();

  /** The single funnel every dismissal path goes through. Nothing calls onClose directly. */
  function requestClose() {
    if (saving) return;
    if (isDirty) {
      setConfirmingDiscard(true);
      return;
    }
    onClose();
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // A nested overlay — the asset picker or the remove-slide confirm, both opened from
      // the media strip below — is stacked on top of this dialog and owns Escape while it
      // is open. Without this, the capture-phase listener plus stopPropagation() closed
      // BOTH at once, so backing out of the picker threw away the whole quick edit.
      if (!layer.isTop()) return;
      e.stopPropagation();
      // Esc never destroys: while the discard prompt is up it backs out of the prompt
      // (= keep editing) rather than confirming the discard it just asked about.
      if (confirmingDiscard) {
        setConfirmingDiscard(false);
        return;
      }
      requestClose();
    }
    // Capture phase so this runs before anything else listening for Esc on the page.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // No dependency array on purpose: the handler closes over isDirty, which changes with
    // every keystroke. A stale closure here would be exactly the silent-discard bug.
  });

  async function save() {
    if (saving) return;
    if (overLimit.length > 0) {
      setError(`Caption is over the limit for: ${overLimit.join(", ")}.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // First, and abort on failure. This is the request that can 409 (the post is being
      // published right now), so failing here leaves nothing at all written.
      if (!(await slideOrder.save())) {
        setError(slideOrder.error ?? "Could not save the slide order.");
        return;
      }
      const res = await fetch(`/api/posts/${post.id}/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content_status: status,
          content_kind: kind,
          cooldown_days: cooldown.trim() === "" ? null : Number(cooldown),
          tag_ids: tagIds,
          // Omitted entirely while the captions are unknown. PATCH replaces variants
          // wholesale, so sending [] here would delete every caption on the post.
          ...(openedCaptions === null
            ? {}
            : { caption_variants: captionVariantsToSave(captions) }),
          // Not the raw collapse: a period the user never touched keeps every link it
          // arrived with, so flipping a status can't quietly delete a blackout this
          // control was never able to display.
          period_links: periodLinksToSave(post.periods, periodModes),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Stay open with the user's input intact — a rejected save must never look like
        // a successful one, and retyping the edit to retry it is pure friction.
        setError(body.error ?? "Could not save these changes.");
        return;
      }
      onSaved();
    } catch {
      setError("Could not confirm whether the save completed. Reopen this post to check.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-edit-title"
      // mousedown, not click: a text selection that starts inside the panel and ends on
      // the backdrop would otherwise read as a click-outside and try to dismiss the
      // dialog mid-edit. currentTarget check keeps it to the backdrop itself.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-card border border-border bg-surface p-6 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          {/* No caption preview here: it would render posts.caption while the editor below
              renders the variants, and on a post where those two have drifted the dialog
              would contradict itself. The caption is editable a few pixels down anyway. */}
          <h2 id="quick-edit-title" className="min-w-0 font-display text-xl font-semibold text-ink">
            Quick edit
          </h2>
          <button
            type="button"
            onClick={requestClose}
            className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-surface-sunken hover:text-ink"
            aria-label="Close quick edit"
          >
            ✕
          </button>
        </div>

        {/* Says what this edit reaches, for a caller where that isn't obvious. On the
            Overview the row you clicked is ONE send, but a caption belongs to the post —
            so the edit lands on every channel that post is queued to, not just the row
            under the cursor. */}
        {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}

        {/* ONE tile per slide. This used to be two blocks — a Media strip and a separate
            "Slide order" grid — which drew every photo on the post twice. Add, remove and
            reorder now share the same tile. Never offered for a text post: it has no slides
            and POST /api/posts/[id]/assets refuses it with `text_post`. */}
        {orderAssets && post.post_type !== "text" ? (
          <div className="mt-5 space-y-2">
            <h3 className="text-xs font-medium text-muted">Media</h3>
            <PostMediaEditor
              postId={post.id}
              slides={orderAssets.map((a) => ({
                id: a.id,
                media_kind: a.media_kind,
                cover_frame_ms: a.cover_frame_ms,
              }))}
              hasLiveSend={post.has_live_send}
              reorder={
                isCarousel
                  ? {
                      order: slideOrder.order,
                      onOrderChange: slideOrder.setOrder,
                      isDirty: slideOrder.isDirty,
                    }
                  : undefined
              }
              onChanged={() => {
                // Media changes are immediate and OUTSIDE this dialog's dirty tracking, so
                // refetch rather than patching local state: post_type may have changed too,
                // and slideOrder's baseline has to move with it or a later reorder save
                // would send a stale permutation. router.refresh() also syncs the parent
                // list (Library grid / Overview queue row) — those callers' own onSaved
                // forces this dialog closed, which a mid-edit media change must not do, so
                // this refreshes them directly instead of routing through onSaved.
                void reloadSlides();
                onMediaChanged?.();
                startTransition(() => router.refresh());
              }}
            />
            {isCarousel && post.queued_publication_count > 0 ? (
              <p className="data text-[11px] text-muted">
                {post.queued_publication_count} queued send
                {post.queued_publication_count === 1 ? "" : "s"} will go out in this order.
              </p>
            ) : null}
          </div>
        ) : null}

        <section className="mt-5 border-t border-border pt-5">
          {openedCaptions === null ? (
            captionError ? (
              <div className="rounded-lg border border-status-failed/40 p-4" role="alert">
                <p className="text-sm text-status-failed">{captionError}</p>
                <p className="mt-1 text-xs text-muted">
                  The captions on this post are untouched — saving now will leave them exactly
                  as they are and only update the fields below.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    // Cleared here rather than in the effect, so the section falls back to
                    // "Loading caption…" the moment Retry is pressed.
                    setCaptionError(null);
                    setCaptionAttempt((attempt) => attempt + 1);
                  }}
                  className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm text-ink hover:bg-surface-sunken"
                >
                  Retry
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted" role="status">
                Loading caption…
              </p>
            )
          ) : (
            <>
              <CaptionVariantsEditor
                value={captions}
                onChange={setCaptions}
                postType={post.post_type}
              />
              {/* The editor counts platform-specific rows itself, but shows nothing for a
                  generic one — and that is the row that actually publishes for a post with
                  no per-platform variant. */}
              {genericLimit ? (
                <p
                  className={`mt-2 text-xs ${
                    genericLength > genericLimit.limit
                      ? "font-medium text-accent-strong"
                      : "text-muted"
                  }`}
                >
                  Generic caption: {genericLength} / {genericLimit.limit} characters —
                  strictest of {genericLimit.label}
                  {genericLength > genericLimit.limit ? ", over the limit." : "."}
                </p>
              ) : null}
            </>
          )}
        </section>

        <section className="mt-5 grid gap-3 sm:grid-cols-3">
          <label className="text-xs text-ink-soft">
            <span className="mb-1 block">Status</span>
            <select
              className={`${field} w-full`}
              value={status}
              onChange={(e) => setStatus(e.target.value as ContentStatus)}
            >
              <option value="draft">Draft</option>
              <option value="ready">Ready</option>
              <option value="retired">Retired</option>
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            <span className="mb-1 block">Kind</span>
            <select
              className={`${field} w-full`}
              value={kind}
              onChange={(e) => setKind(e.target.value as ContentKind)}
            >
              <option value="evergreen">Evergreen</option>
              <option value="one_time">One-time</option>
            </select>
          </label>
          <label className="text-xs text-ink-soft">
            <span className="mb-1 block">Cooldown days</span>
            <input
              type="number"
              min={0}
              step={1}
              placeholder="Channel default"
              className={`${field} w-full`}
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
            />
          </label>
        </section>
        <p className="mt-1.5 text-[11px] text-faint">
          Leave cooldown blank to use the channel default.
        </p>

        <section className="mt-5 border-t border-border pt-5">
          <TagEditor
            timeOfDayTags={timeOfDayTags}
            topicTags={topicTags}
            value={tagIds}
            onChange={setTagIds}
          />
        </section>

        <section className="mt-5 border-t border-border pt-5">
          <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />
        </section>

        {error ? (
          <p className="mt-4 text-sm text-status-failed" role="alert">
            {error}
          </p>
        ) : null}

        {confirmingDiscard ? (
          <div
            className="mt-4 rounded-lg border border-status-failed/40 bg-status-failed/5 p-4"
            role="alertdialog"
            aria-labelledby="quick-edit-discard-title"
          >
            <p id="quick-edit-discard-title" className="text-sm font-semibold text-ink">
              Discard changes?
            </p>
            <p className="mt-1 text-xs text-muted">
              Your edits to this post have not been saved yet.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDiscard(false)}
                autoFocus
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-sunken"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-status-failed/50 px-3 py-1.5 text-sm font-medium text-status-failed hover:bg-status-failed/10"
              >
                Discard
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex items-center justify-between gap-4">
          <p className="text-[11px] text-faint">
            Targets and sends stay in the full editor.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={requestClose}
              disabled={saving}
              className="rounded-lg border border-border px-4 py-2 text-sm text-ink hover:bg-surface-sunken disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
