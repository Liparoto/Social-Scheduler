"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PostPublicationRow, PostType } from "@/lib/types";
import type { Channel } from "@/lib/types";
import { ChannelAvatar, ChannelChip, StatusBadge } from "@/components/ui";
import { channelColor, formatInTz, tzAbbrev } from "@/lib/format";
import { incompatibleChannelsForPostType } from "@/lib/platforms";
import type { PublishReadiness } from "@/lib/publish-readiness";
import { PostNowReadinessNotice } from "@/components/post-now-readiness";
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
  const prefill = splitInTz(send.scheduled_at, send.channel_timezone);
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
          <span className="data text-xs text-ink-soft">
            {formatInTz(send.scheduled_at, send.channel_timezone)} {tzAbbrev(send.channel_timezone)}
          </span>
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

      {error ? <p className="text-[11px] text-status-failed">{error}</p> : null}
    </div>
  );
}

export function PostSendsPanel({
  postId,
  postType,
  sends,
  channels,
  readiness,
  dirty = false,
}: {
  postId: number;
  postType: PostType;
  sends: PostPublicationRow[];
  channels: Channel[];
  readiness: PublishReadiness;
  // True when the surrounding editor has unsaved changes. Post now publishes whatever
  // is currently saved in the DB, so it must be blocked while dirty — the scheduled
  // path is unaffected since scheduling for later still leaves time to save first.
  dirty?: boolean;
}) {
  const router = useRouter();
  const [targets, setTargets] = useState<Set<number>>(new Set());
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [postNow, setPostNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Exclude channels that already have a non-posted (still-live-in-queue) send, when easy.
  const busyChannelIds = new Set(
    sends.filter((s) => !READ_ONLY_STATUSES.has(s.status) && s.status !== "canceled" && s.status !== "failed")
      .map((s) => s.channel_id)
  );
  // ...and channels that can't publish this post's type at all — offering them would
  // schedule a send the worker is guaranteed to fail terminally.
  const incompatibleIds = new Set(incompatibleChannelsForPostType(postType, channels).map((c) => c.id));
  const pickable = channels.filter((c) => !busyChannelIds.has(c.id) && !incompatibleIds.has(c.id));

  // Adding a send makes that channel un-pickable (it now has a live send), so a previously
  // ticked channel can go stale the moment the list refreshes. Derive the usable set from
  // `pickable` instead of writing it back into state — same "derive, don't sync" approach
  // as schedule-from-library.tsx's effectiveTargets and library-view.tsx's effectiveChans.
  const pickableIds = useMemo(() => new Set(pickable.map((c) => c.id)), [pickable]);
  const effectiveTargets = useMemo(
    () => new Set([...targets].filter((id) => pickableIds.has(id))),
    [targets, pickableIds]
  );
  const toggleTarget = (id: number) => {
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // The count is what makes a multi-target send legible before it fires — "Post now to 2
  // accounts" is the last thing read before something is published for real. At zero the
  // button is disabled, so it just names the action rather than saying "0 sends".
  const n = effectiveTargets.size;
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
    if (effectiveTargets.size === 0) {
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
        channel_ids: Array.from(effectiveTargets),
        ...(postNow ? { post_now: true } : { date, time }),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not add send.");
      return;
    }
    setTargets(new Set());
    setDate("");
    setTime("");
    setPostNow(false);
    router.refresh();
  }

  return (
    <section className="rounded-card border border-border bg-surface p-5">
      <h3 className="mb-1 font-display text-sm font-semibold text-ink">Scheduled sends</h3>
      <p className="mb-3 text-xs text-muted">
        Retarget, hold, or remove this post's sends. Posted sends are permanent records and read-only.
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
            <div className="grid gap-2 sm:grid-cols-2">
              {pickable.map((c) => {
                const on = effectiveTargets.has(c.id);
                const color = channelColor(c.id, c.color_hue);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleTarget(c.id)}
                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      on ? "border-transparent" : "border-border hover:bg-surface-sunken"
                    }`}
                    style={
                      on
                        ? { backgroundColor: color.bg, boxShadow: `inset 0 0 0 2px ${color.dot}` }
                        : undefined
                    }
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: on ? color.dot : "transparent",
                        border: on ? "none" : "1.5px solid var(--color-border-strong)",
                      }}
                      aria-hidden
                    />
                    <ChannelAvatar
                      id={c.id}
                      name={c.account_name}
                      colorHue={c.color_hue}
                      avatarPath={c.avatar_path}
                      size={20}
                    />
                    {/* channelColor's bg is a fixed LIGHT tint in every theme, so the
                        label has to take its paired dark `fg` when selected — leaving it
                        on `text-ink` makes it near-invisible in the dark themes (light
                        text on a light chip). Same pairing ui.tsx's ChannelChip uses. */}
                    <span className="text-sm text-ink" style={on ? { color: color.fg } : undefined}>
                      {c.account_name}
                    </span>
                    <span
                      className="ml-auto text-xs text-muted"
                      style={on ? { color: color.fg, opacity: 0.75 } : undefined}
                    >
                      {c.platform}
                    </span>
                  </button>
                );
              })}
            </div>
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
            disabled={busy || effectiveTargets.size === 0 || (postNow && dirty)}
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
