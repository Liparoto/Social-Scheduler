"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PublicationStatus } from "@/lib/types";

// Split a UTC ISO instant into {date, time} strings in a given IANA timezone,
// suitable for prefilling <input type="date"> / <input type="time">.
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

// Is the given date/time (interpreted in timeZone) already in the past?
function isPastInTz(date: string, time: string, timeZone: string): boolean {
  if (!date || !time) return false;
  // Approximate: compare against "now" formatted in the same timezone as plain strings.
  const now = splitInTz(new Date().toISOString(), timeZone);
  return date < now.date || (date === now.date && time < now.time);
}

const dateTimeInputCls =
  "rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink focus:border-brand";

export function PublicationActions({
  id,
  status,
  isDryRun = false,
  workerOnline = true,
  isHeld = false,
  scheduledAt = null,
  channelTimezone = "UTC",
}: {
  id: number;
  status: PublicationStatus;
  isDryRun?: boolean;
  workerOnline?: boolean;
  isHeld?: boolean;
  scheduledAt?: string | null;
  channelTimezone?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showReschedule, setShowReschedule] = useState(false);
  const prefill = splitInTz(scheduledAt, channelTimezone);
  const [date, setDate] = useState(prefill.date);
  const [time, setTime] = useState(prefill.time);

  async function act(action: "retry" | "approve" | "cancel" | "hold" | "resume") {
    setError(null);
    const res = await fetch(`/api/publications/${id}/${action}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return;
    }
    startTransition(() => router.refresh());
  }

  async function saveReschedule() {
    setError(null);
    const res = await fetch(`/api/publications/${id}/reschedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, time }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return;
    }
    setShowReschedule(false);
    startTransition(() => router.refresh());
  }

  async function doDelete() {
    setError(null);
    const res = await fetch(`/api/publications/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return;
    }
    startTransition(() => router.refresh());
  }

  // Two-click confirm so a scheduled send is never canceled on a stray click.
  const cancelControl = confirmCancel ? (
    <div className="flex items-center gap-1">
      <button
        onClick={() => act("cancel")}
        disabled={pending}
        className="rounded-md bg-status-failed px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Canceling…" : "Confirm cancel"}
      </button>
      <button
        onClick={() => setConfirmCancel(false)}
        disabled={pending}
        className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
      >
        Keep
      </button>
    </div>
  ) : (
    <button
      onClick={() => setConfirmCancel(true)}
      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:border-status-failed hover:text-status-failed"
    >
      Cancel
    </button>
  );

  // Two-click confirm for delete, same shape as cancel.
  const deleteControl = confirmDelete ? (
    <div className="flex items-center gap-1">
      <button
        onClick={doDelete}
        disabled={pending}
        className="rounded-md bg-status-failed px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Confirm delete"}
      </button>
      <button
        onClick={() => setConfirmDelete(false)}
        disabled={pending}
        className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
      >
        Keep
      </button>
    </div>
  ) : (
    <button
      onClick={() => setConfirmDelete(true)}
      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:border-status-failed hover:text-status-failed"
    >
      Delete
    </button>
  );

  const holdResumeControl = (
    <button
      onClick={() => act(isHeld ? "resume" : "hold")}
      disabled={pending}
      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
    >
      {isHeld ? (pending ? "Resuming…" : "Resume") : pending ? "Holding…" : "Hold"}
    </button>
  );

  const moreToggle = (
    <button
      onClick={() => {
        setShowMore((v) => !v);
        setShowReschedule(false);
      }}
      className="rounded-md px-1.5 py-1 text-xs font-medium text-faint hover:text-ink-soft"
      title="More actions"
    >
      {showMore ? "Less ▲" : "More ▾"}
    </button>
  );

  const rescheduleControl = showReschedule ? (
    <div className="flex flex-col items-end gap-1 rounded-md border border-border bg-surface-sunken p-2">
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={dateTimeInputCls}
        />
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className={dateTimeInputCls}
        />
        <button
          onClick={saveReschedule}
          disabled={pending || !date || !time}
          className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-on-brand hover:bg-brand-ink disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => setShowReschedule(false)}
          disabled={pending}
          className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {isPastInTz(date, time, channelTimezone) ? (
        <span className="text-[10px] text-status-scheduled">
          That's in the past — will send on the next worker run.
        </span>
      ) : null}
    </div>
  ) : (
    <button
      onClick={() => setShowReschedule(true)}
      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted hover:border-brand hover:text-brand"
    >
      Reschedule
    </button>
  );

  async function refreshMetrics() {
    setError(null);
    const res = await fetch(`/api/publications/${id}/refresh-metrics`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return;
    }
    setQueued(true);
    startTransition(() => router.refresh());
  }

  if (status === "failed") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => act("retry")}
            disabled={pending}
            className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
          >
            {pending ? "Retrying…" : "Retry"}
          </button>
          {moreToggle}
        </div>
        {showMore ? <div className="flex items-center gap-1.5">{deleteControl}</div> : null}
        {error ? <span className="text-[10px] text-status-failed">{error}</span> : null}
      </div>
    );
  }

  if (status === "pending_approval") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => act("approve")}
            disabled={pending}
            className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-on-brand hover:bg-brand-ink disabled:opacity-50"
          >
            {pending ? "Approving…" : "Approve"}
          </button>
          {holdResumeControl}
          {cancelControl}
          {moreToggle}
        </div>
        {showMore ? (
          <div className="flex items-center gap-1.5">
            {rescheduleControl}
            {deleteControl}
          </div>
        ) : null}
        {error ? <span className="text-[10px] text-status-failed">{error}</span> : null}
      </div>
    );
  }

  if (status === "scheduled") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5">
          {holdResumeControl}
          {cancelControl}
          {moreToggle}
        </div>
        {showMore ? (
          <div className="flex items-center gap-1.5">
            {rescheduleControl}
            {deleteControl}
          </div>
        ) : null}
        {error ? <span className="text-[10px] text-status-failed">{error}</span> : null}
      </div>
    );
  }

  if (status === "posted" && !isDryRun) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          onClick={refreshMetrics}
          disabled={pending || queued}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
          title={
            workerOnline
              ? "Queue a metrics fetch on the next worker run"
              : "Worker looks offline — this will apply once you start it"
          }
        >
          {queued ? "Queued ✓" : "Refresh metrics"}
        </button>
        {queued && !workerOnline ? (
          <span className="text-[10px] text-status-scheduled">Worker offline — starts when it runs</span>
        ) : null}
        {error ? <span className="text-[10px] text-status-failed">{error}</span> : null}
      </div>
    );
  }

  return null;
}
