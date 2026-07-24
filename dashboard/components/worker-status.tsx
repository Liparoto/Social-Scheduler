/**
 * Presentational worker-liveness pill. The worker is a separate process; when it's not
 * running, scheduled publishing, auto-fill, and metrics refreshes silently don't happen.
 * Surfacing that here keeps the dashboard honest about what will and won't get picked up.
 */
export function WorkerStatus({
  online,
  lastSeenAt,
}: {
  online: boolean;
  lastSeenAt: string | null;
}) {
  const title = lastSeenAt
    ? `Worker last seen ${new Date(lastSeenAt).toLocaleString()}`
    : "Worker has never checked in";

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
        online
          ? "border-status-posted/40 text-status-posted"
          : "border-border-strong text-muted"
      }`}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          backgroundColor: online ? "var(--color-status-posted)" : "var(--color-muted)",
        }}
      />
      Worker {online ? "online" : "offline"}
    </span>
  );
}
