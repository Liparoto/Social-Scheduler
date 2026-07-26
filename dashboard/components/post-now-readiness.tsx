import type { PublishReadiness } from "@/lib/publish-readiness";

/**
 * The "Post now" warning block, shared by every surface that offers it (composer,
 * schedule-from-library, post editor's Add-a-send). Renders ALL applicable warnings —
 * not just the first — because dry-run, the kill switch, and the worker being offline
 * are independent conditions that can co-occur, and each one silently prevents the
 * send in its own way. See lib/publish-readiness.ts for why these are read live.
 */
export function PostNowReadinessNotice({ readiness }: { readiness: PublishReadiness }) {
  return (
    <div className="space-y-2 rounded-lg bg-surface-sunken px-3 py-2.5 text-xs">
      {readiness.dryRun ? (
        <p className="font-medium text-accent-strong">
          Dry-run is on — this will be simulated and nothing will actually post. Set{" "}
          <code className="data rounded bg-surface px-1 py-0.5">DRY_RUN=0</code> in{" "}
          <code className="data rounded bg-surface px-1 py-0.5">.env</code> to publish for
          real.
        </p>
      ) : null}
      {readiness.killSwitch ? (
        <p className="font-medium text-accent-strong">
          The kill switch is on — the worker is running but won&rsquo;t publish anything
          until <code className="data rounded bg-surface px-1 py-0.5">KILL_SWITCH=0</code>{" "}
          is set in <code className="data rounded bg-surface px-1 py-0.5">.env</code>.
        </p>
      ) : null}
      {!readiness.workerOnline ? (
        <p className="font-medium text-accent-strong">
          The worker isn&rsquo;t running — nothing will pick this up until it is. The send
          will simply wait.
        </p>
      ) : null}
      {!readiness.dryRun && !readiness.killSwitch && readiness.workerOnline ? (
        <p className="text-muted">
          Publishes on the worker&rsquo;s next check, within about a minute — not
          instantly.
        </p>
      ) : null}
      <p className="text-muted">Skips the approval step, even for channels that require it.</p>
    </div>
  );
}
