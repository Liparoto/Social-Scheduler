"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Asks the worker to re-sync a channel now.
 *
 * The dashboard holds no API credentials, so this only raises a flag the worker clears
 * when it picks the work up. That is why the button reports "Queued" rather than
 * "Synced": claiming a refresh happened while the daemon is stopped would be a lie, and
 * a stuck "Queued" is itself the useful signal that the worker is not running.
 */
export function InsightsRefresh({
  channelId,
  pending,
  label = "Sync now",
}: {
  channelId: number;
  pending?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [queued, setQueued] = useState(Boolean(pending));
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setError(null);
    const response = await fetch(`/api/insights/${channelId}/refresh`, { method: "POST" });
    if (!response.ok) {
      setError("Could not queue the refresh.");
      return;
    }
    setQueued(true);
    startTransition(() => router.refresh());
  }

  if (queued) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface-sunken px-3 py-1.5 text-xs font-medium text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-status-publishing" aria-hidden />
        Queued — the worker picks this up on its next cycle
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={request}
        disabled={isPending}
        className="inline-flex items-center rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-60"
      >
        {isPending ? "Queueing…" : label}
      </button>
      {error ? <span className="text-xs text-status-failed">{error}</span> : null}
    </span>
  );
}
