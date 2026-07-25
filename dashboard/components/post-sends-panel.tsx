"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PostPublicationRow, PostType } from "@/lib/types";
import type { Channel } from "@/lib/types";
import { ChannelChip, StatusBadge } from "@/components/ui";
import { formatInTz, tzAbbrev } from "@/lib/format";
import { incompatibleChannelsForPostType } from "@/lib/platforms";

// Split a UTC ISO instant into {date, time} strings in a given IANA timezone,
// suitable for prefilling <input type="date"> / <input type="time">. Same
// approach as publication-actions.tsx.
function splitInTz(iso: string | null, timeZone: string): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  try {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d); // en-CA -> YYYY-MM-DD
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d); // en-GB -> HH:MM
    return { date, time };
  } catch {
    return { date: "", time: "" };
  }
}

const READ_ONLY_STATUSES = new Set(["posted", "publishing"]);
const dateTimeInputCls =
  "rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink focus:border-brand";

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
          <ChannelChip id={send.channel_id} platform={send.channel_platform} name={send.channel_name} />
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
}: {
  postId: number;
  postType: PostType;
  sends: PostPublicationRow[];
  channels: Channel[];
}) {
  const router = useRouter();
  const [channelId, setChannelId] = useState<number | "">("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
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

  async function addSend() {
    setError(null);
    if (!channelId) {
      setError("Pick a channel.");
      return;
    }
    if (!date || !time) {
      setError("Pick a date and time.");
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/posts/${postId}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_ids: [channelId], date, time }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not add send.");
      return;
    }
    setChannelId("");
    setDate("");
    setTime("");
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
        <h4 className="mb-2 text-xs font-semibold text-ink-soft">Add a send</h4>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-ink-soft">Channel</label>
            <select
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Choose…</option>
              {pickable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.account_name} ({c.platform})
                </option>
              ))}
            </select>
          </div>
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
          <button
            onClick={addSend}
            disabled={busy}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-status-failed">{error}</p> : null}
      </div>
    </section>
  );
}
