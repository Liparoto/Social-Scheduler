"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PostPublicationRow, PostTarget, PostType } from "@/lib/types";
import type { Channel } from "@/lib/types";
import { ChannelAvatar, ChannelChip, StatusBadge } from "@/components/ui";
import { channelColor, formatInTz, tzAbbrev } from "@/lib/format";
import { sendTime, formatLateness } from "@/lib/send-time";
import { incompatibleChannelsForPostType } from "@/lib/platforms";
import type { PublishReadiness } from "@/lib/publish-readiness";
import { PostNowReadinessNotice } from "@/components/post-now-readiness";
import { ChannelSurfacePicker } from "@/components/channel-surface-picker";
import { splitInTz } from "@/lib/time";

const READ_ONLY_STATUSES = new Set(["posted", "publishing"]);
const dateTimeInputCls =
  "rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink focus:border-brand";
const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-strong" : "text-muted hover:text-ink"
  }`;

function SendRow({ send, postId }: { send: PostPublicationRow; postId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReschedule, setShowReschedule] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Reschedule always prefills the PLANNED time — it edits scheduled_at, so seeding it
  // from an actual publish time would quietly move the slot.
  const prefill = splitInTz(send.scheduled_at, send.channel_timezone);
  const when = sendTime(send);
  const [date, setDate] = useState(prefill.date);
  const [time, setTime] = useState(prefill.time);

  const readOnly = READ_ONLY_STATUSES.has(send.status);

  async function act(action: "hold" | "resume") {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/publications/${send.id}/${action}`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return;
    }
    router.refresh();
  }

  async function saveReschedule() {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/publications/${send.id}/reschedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, time }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return;
    }
    setShowReschedule(false);
    router.refresh();
  }

  async function retryComment() {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/publications/${send.id}/retry-comment`, {
      method: "POST",
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return;
    }
    router.refresh();
  }

  async function doRemove() {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/publications/${send.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Something went wrong.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ChannelChip
            id={send.channel_id}
            platform={send.channel_platform}
            name={send.channel_name}
            colorHue={send.channel_color_hue}
            avatarPath={send.channel_avatar_path}
          />
          {/* Same rule as the Overview queue (lib/send-time): once a send is out, show
              when it actually went, not the slot it was aimed at. */}
          <span
            className="data text-xs text-ink-soft"
            title={
              when.actual
                ? `Actually posted ${formatInTz(send.published_at, send.channel_timezone)} · scheduled for ${formatInTz(send.scheduled_at, send.channel_timezone)}`
                : undefined
            }
          >
            {formatInTz(when.iso, send.channel_timezone)} {tzAbbrev(send.channel_timezone)}
          </span>
          {when.lateMinutes !== null ? (
            <span className="data text-[10px] text-status-blocked">
              {formatLateness(when.lateMinutes)}
            </span>
          ) : null}
          {/* How THIS run did. Per run, not per post: the same content going out twice
              produces two results, and reposting only earns its place if you can see
              whether the second run beat the first.

              Shown only once a run has posted AND has numbers — a scheduled send has
              nothing to report, and a posted one the worker has not reached yet would
              read as zeros if it borrowed another run's figures. */}
          {/* A Story reports reach, views and replies — never likes, comments or saves.
              Without saying so, "18 reach" with no likes reads as a feed post that
              flopped, when it is simply a different surface measured differently. And a
              Story is gone after 24h by design, so its numbers are final rather than
              still climbing. */}
          {send.surface === "story" ? (
            <span
              className="rounded-full bg-surface-sunken px-1.5 py-px text-[10px] text-muted"
              title="Stories expire after 24 hours. Instagram reports reach, views and replies for them — never likes, comments or saves."
            >
              story · 24h
            </span>
          ) : null}
          {send.removed_from_platform === 1 ? (
            <span
              className="rounded-full px-1.5 py-px text-[10px] text-status-failed"
              title="This post is no longer on the account. Its numbers are frozen at the last reading and will not update."
            >
              removed from platform
            </span>
          ) : null}
          {send.status === "posted" && send.is_dry_run !== 1 && send.reach !== null ? (
            <span className="data text-[11px] text-muted">
              {send.reach?.toLocaleString()} reach
              {send.impressions !== null ? ` · ${send.impressions.toLocaleString()} views` : ""}
              {send.likes !== null ? ` · ${send.likes.toLocaleString()} likes` : ""}
              {send.comments ? ` · ${send.comments.toLocaleString()} comments` : ""}
              {send.saves ? ` · ${send.saves.toLocaleString()} saves` : ""}
              {send.surface === "story" ? " · final" : ""}
            </span>
          ) : send.status === "posted" && send.is_dry_run !== 1 ? (
            <span className="text-[11px] text-faint">
              {/* "not fetched yet" implies it still might be. For a post that is gone from
                  the platform it never will be, and saying otherwise leaves someone waiting
                  for numbers that are never coming. */}
              {send.removed_from_platform === 1
                ? "no metrics — the post was removed before any were collected"
                : send.surface === "story"
                  ? "story expired before metrics were fetched"
                  : "metrics not fetched yet"}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={send.status} dryRun={send.is_dry_run === 1} />
          {send.is_held === 1 ? (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
              style={{
                color: "var(--color-status-draft)",
                backgroundColor: "color-mix(in srgb, var(--color-status-draft) 12%, white)",
              }}
            >
              Held
            </span>
          ) : null}
        </div>
      </div>

      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {showReschedule ? (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-surface-sunken p-2">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={dateTimeInputCls} />
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={dateTimeInputCls} />
              <button
                onClick={saveReschedule}
                disabled={busy || !date || !time}
                className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-on-brand hover:bg-brand-ink disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => setShowReschedule(false)}
                disabled={busy}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowReschedule(true)}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:border-brand hover:text-brand"
            >
              Reschedule
            </button>
          )}

          {send.status === "scheduled" || send.status === "pending_approval" ? (
            <button
              onClick={() => act(send.is_held === 1 ? "resume" : "hold")}
              disabled={busy}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
            >
              {send.is_held === 1 ? (busy ? "Resuming…" : "Resume") : busy ? "Holding…" : "Hold"}
            </button>
          ) : null}

          {confirmRemove ? (
            <div className="flex items-center gap-1">
              <button
                onClick={doRemove}
                disabled={busy}
                className="rounded-md bg-status-failed px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Removing…" : "Confirm remove"}
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                disabled={busy}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
              >
                Keep
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:border-status-failed hover:text-status-failed"
            >
              Remove
            </button>
          )}
        </div>
      ) : null}

      {/* The first comment's own outcome. Only shown when there is something to say:
          'none' is the overwhelmingly common case (no first comment written) and a badge
          on every send saying so would be noise. A FAILED comment must be visible here —
          the post itself went out fine, so nothing else on this row hints at it. */}
      {send.first_comment_status !== "none" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken px-2.5 py-1.5">
          <span className="text-[11px] font-medium text-muted">First comment</span>
          {send.first_comment_status === "posted" ? (
            <span className="text-[11px] text-ink-soft">Posted</span>
          ) : send.first_comment_status === "pending" ? (
            <span className="text-[11px] text-ink-soft">
              {send.first_comment_retry_requested === 1
                ? "Retry queued — the worker will pick it up."
                : "In progress…"}
            </span>
          ) : (
            <>
              <span className="text-[11px] font-medium text-status-failed">
                Failed — the post itself went out fine.
              </span>
              {send.first_comment_error ? (
                <span className="data text-[11px] text-muted">{send.first_comment_error}</span>
              ) : null}
              {send.first_comment_retry_requested === 1 ? (
                <span className="text-[11px] text-ink-soft">Retry queued.</span>
              ) : (
                <button
                  onClick={retryComment}
                  disabled={busy}
                  className="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-muted hover:border-brand hover:text-brand disabled:opacity-50"
                >
                  {busy ? "Queueing…" : "Retry comment"}
                </button>
              )}
            </>
          )}
        </div>
      ) : null}

      {error ? <p className="text-[11px] text-status-failed">{error}</p> : null}
    </div>
  );
}

export function PostSendsPanel({
  postId,
  postType,
  slideCount,
  sends,
  channels,
  readiness,
  dirty = false,
}: {
  postId: number;
  postType: PostType;
  /** Slide count, so the picker can warn '4 slides -> 4 Stories' before publishing. */
  slideCount: number;
  sends: PostPublicationRow[];
  channels: Channel[];
  readiness: PublishReadiness;
  // True when the surrounding editor has unsaved changes. Post now publishes whatever
  // is currently saved in the DB, so it must be blocked while dirty — the scheduled
  // path is unaffected since scheduling for later still leaves time to save first.
  dirty?: boolean;
}) {
  const router = useRouter();
  // Targets, not channel ids: Instagram's Feed and Story are independent sends, and a
  // bare channel id here is exactly what published a Story to the feed once.
  const [targets, setTargets] = useState<PostTarget[]>([]);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [postNow, setPostNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Exclude destinations that already have a non-posted (still-live-in-queue) send, when
  // easy. Keyed by channel AND surface: an account with a live feed send can still take a
  // Story, so keying on channel alone would wrongly hide the Story option.
  const busyKeys = new Set(
    sends.filter((s) => !READ_ONLY_STATUSES.has(s.status) && s.status !== "canceled" && s.status !== "failed")
      .map((s) => `${s.channel_id}:${s.surface ?? "feed"}`)
  );
  // ...and channels that can't publish this post's type at all — offering them would
  // schedule a send the worker is guaranteed to fail terminally.
  const incompatibleIds = new Set(incompatibleChannelsForPostType(postType, channels).map((c) => c.id));
  // A channel is offered when it isn't type-incompatible and still has at least one free
  // surface. Which of its surfaces are free is decided per-chip below via busyKeys.
  const pickable = channels.filter(
    (c) =>
      !incompatibleIds.has(c.id) &&
      !(busyKeys.has(`${c.id}:feed`) && busyKeys.has(`${c.id}:story`))
  );

  // Adding a send makes that channel un-pickable (it now has a live send), so a previously
  // ticked channel can go stale the moment the list refreshes. Derive the usable set from
  // `pickable` instead of writing it back into state — same "derive, don't sync" approach
  // as schedule-from-library.tsx's effectiveTargets and library-view.tsx's effectiveChans.
  const pickableIds = useMemo(() => new Set(pickable.map((c) => c.id)), [pickable]);
  const effectiveTargets = useMemo(
    () =>
      targets.filter(
        (t) => pickableIds.has(t.channel_id) && !busyKeys.has(`${t.channel_id}:${t.surface}`)
      ),
    // busyKeys is rebuilt each render from `sends`; keying the memo on its size is enough
    // to re-derive when a send is added or removed.
    [targets, pickableIds, busyKeys.size]
  );

  // The count is what makes a multi-target send legible before it fires — "Post now to 2
  // accounts" is the last thing read before something is published for real. At zero the
  // button is disabled, so it just names the action rather than saying "0 sends".
  const n = effectiveTargets.length;
  const addLabel =
    n === 0
      ? postNow
        ? "Post now →"
        : "Add send"
      : postNow
        ? `Post now to ${n} ${n === 1 ? "account" : "accounts"} →`
        : `Add ${n} ${n === 1 ? "send" : "sends"}`;

  async function addSend() {
    setError(null);
    if (effectiveTargets.length === 0) {
      setError("Pick at least one account.");
      return;
    }
    if (postNow && dirty) {
      setError("Save your changes first — Post now publishes what's saved.");
      return;
    }
    if (!postNow && (!date || !time)) {
      setError("Pick a date and time.");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/posts/${postId}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: effectiveTargets,
        ...(postNow ? { post_now: true } : { date, time }),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not add send.");
      return;
    }
    setTargets([]);
    setDate("");
    setTime("");
    setPostNow(false);
    router.refresh();
  }

  return (
    <section className="rounded-card border border-border bg-surface p-5">
      <h3 className="mb-1 font-display text-sm font-semibold text-ink">Scheduled sends</h3>
      <p className="mb-3 text-xs text-muted">
        Retarget, hold, or remove this post&apos;s sends. Posted sends are permanent records and read-only.
      </p>

      {sends.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong bg-surface-sunken px-3 py-4 text-center text-xs text-muted">
          No sends yet — add one below.
        </p>
      ) : (
        <div>
          {sends.map((s) => (
            <SendRow key={s.id} send={s} postId={postId} />
          ))}
        </div>
      )}

      <div className="mt-4 rounded-lg border border-border bg-surface-sunken p-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-ink-soft">Add a send</h4>
          <div
            role="group"
            aria-label="Send timing"
            className="inline-flex rounded-lg border border-border p-0.5"
          >
            <button
              type="button"
              aria-pressed={!postNow}
              className={segBtn(!postNow)}
              onClick={() => setPostNow(false)}
            >
              Schedule
            </button>
            <button
              type="button"
              aria-pressed={postNow}
              className={segBtn(postNow)}
              onClick={() => setPostNow(true)}
            >
              Post now
            </button>
          </div>
        </div>
        <div className="mb-3">
          <label className="mb-1.5 block text-[11px] font-medium text-ink-soft">
            Accounts — each one gets its own send
          </label>
          {pickable.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-strong bg-surface px-3 py-3 text-center text-xs text-muted">
              Every account that can take this post already has a send queued.
            </p>
          ) : (
            <ChannelSurfacePicker
              channels={pickable}
              value={effectiveTargets}
              onChange={setTargets}
              hasVideo={postType === "reel"}
              textOnly={postType === "text"}
              slideCount={slideCount}
            />
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {!postNow ? (
            <>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-soft">Date</label>
                <input
                  type="date"
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-ink-soft">Time (channel local)</label>
                <input
                  type="time"
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </div>
            </>
          ) : null}
          <button
            onClick={addSend}
            disabled={busy || effectiveTargets.length === 0 || (postNow && dirty)}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
          >
            {busy ? (postNow ? "Sending…" : "Adding…") : addLabel}
          </button>
        </div>
        {postNow && dirty ? (
          <p className="mt-2 text-xs text-status-failed">
            Save your changes first — Post now publishes what&apos;s saved.
          </p>
        ) : null}
        {postNow ? (
          <div className="mt-2">
            <PostNowReadinessNotice readiness={readiness} />
          </div>
        ) : null}
        {error ? <p className="mt-2 text-xs text-status-failed">{error}</p> : null}
      </div>
    </section>
  );
}
