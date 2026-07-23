"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function RefreshAllMetrics() {
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
    setMsg(`Queued ${body.requested} — updates after the next worker run.`);
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-2">
      {msg ? <span className="data text-[11px] text-muted">{msg}</span> : null}
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
