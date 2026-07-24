"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PublicationStatus } from "@/lib/types";

export function PublicationActions({
  id,
  status,
  isDryRun = false,
  workerOnline = true,
}: {
  id: number;
  status: PublicationStatus;
  isDryRun?: boolean;
  workerOnline?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function act(action: "retry" | "approve" | "cancel") {
    setError(null);
    const res = await fetch(`/api/publications/${id}/${action}`, { method: "POST" });
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
        <button
          onClick={() => act("retry")}
          disabled={pending}
          className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
        >
          {pending ? "Retrying…" : "Retry"}
        </button>
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
          {cancelControl}
        </div>
        {error ? <span className="text-[10px] text-status-failed">{error}</span> : null}
      </div>
    );
  }

  if (status === "scheduled") {
    return (
      <div className="flex flex-col items-end gap-1">
        {cancelControl}
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
