"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function RefreshAllMetrics({ workerOnline = true }: { workerOnline?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function run() {
    setMsg(null);
    const res = await fetch("/api/metrics/refresh-all", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(body.error ?? "Something went wrong.");
      return;
    }
    setMsg(
      workerOnline
        ? `Queued ${body.requested} — updates after the next worker run.`
        : `Queued ${body.requested}, but the worker looks offline — start it to apply.`
    );
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2">
      {msg ? (
        <span
          className={`data text-[11px] ${msg && !workerOnline ? "text-status-scheduled" : "text-muted"}`}
        >
          {msg}
        </span>
      ) : null}
      <button
        onClick={run}
        disabled={pending}
        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
      >
        {pending ? "Queuing…" : "Refresh all metrics"}
      </button>
    </div>
  );
}
