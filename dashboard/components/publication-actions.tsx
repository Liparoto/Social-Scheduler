"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PublicationStatus } from "@/lib/types";

export function PublicationActions({
  id,
  status,
  isDryRun = false,
}: {
  id: number;
  status: PublicationStatus;
  isDryRun?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  async function act(action: "retry" | "approve") {
    setError(null);
    const res = await fetch(`/api/publications/${id}/${action}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Something went wrong.");
      return;
    }
    startTransition(() => router.refresh());
  }

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
        <button
          onClick={() => act("approve")}
          disabled={pending}
          className="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-ink disabled:opacity-50"
        >
          {pending ? "Approving…" : "Approve"}
        </button>
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
          title="Queue a metrics fetch on the next worker run"
        >
          {queued ? "Queued ✓" : "Refresh metrics"}
        </button>
        {error ? <span className="text-[10px] text-status-failed">{error}</span> : null}
      </div>
    );
  }

  return null;
}
