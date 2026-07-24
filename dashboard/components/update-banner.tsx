"use client";

import { useCallback, useEffect, useState } from "react";

// Reads the read-only /api/update-check endpoint and, when this copy is behind the latest
// code, tells the user how to update: close the app and double-click the Update script.
// Applying the update is NOT done here — a running server can't cleanly replace its own
// code and restart. This component only surfaces "you're behind + here's what to do".

type Platform = "mac" | "windows" | "other";

type UpdateState =
  | { state: "behind"; behind: number; currentSha: string; latestSha: string; platform: Platform }
  | { state: "current"; currentSha: string; platform: Platform }
  | { state: "unknown"; reason: string; platform: Platform };

function scriptName(p: Platform): string {
  if (p === "windows") return "Update-Windows";
  if (p === "mac") return "Update-Mac";
  return "the Update script";
}

export function UpdateBanner() {
  const [data, setData] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const check = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      const res = await fetch(`/api/update-check${force ? "?force=1" : ""}`);
      setData(await res.json());
      if (force) setDismissed(false);
    } catch {
      setData({ state: "unknown", reason: "Couldn't check for updates.", platform: "other" });
    } finally {
      setChecking(false);
    }
  }, []);

  // Check once when the app loads (uses the server-side cache, so it's cheap).
  useEffect(() => {
    check(false);
  }, [check]);

  // Prominent, actionable banner when there's actually an update to install.
  if (data?.state === "behind" && !dismissed) {
    const label = data.behind === 1 ? "1 update" : `${data.behind} updates`;
    return (
      <div className="rounded-lg border border-status-scheduled/40 bg-status-scheduled/10 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[12px] font-semibold text-ink">Update available</p>
          <button
            onClick={() => setDismissed(true)}
            className="-mt-0.5 text-muted hover:text-ink"
            aria-label="Dismiss"
            title="Dismiss until next launch"
          >
            ×
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">
          You&apos;re {label} behind. To install: close this app, then double-click{" "}
          <code className="data text-[10px] text-muted">{scriptName(data.platform)}</code>.
        </p>
      </div>
    );
  }

  // Otherwise stay quiet: a single muted line with a manual re-check.
  let text = "Check for updates";
  if (checking) text = "Checking…";
  else if (data?.state === "current") text = "Up to date";
  else if (data?.state === "unknown") text = "Update check unavailable";

  return (
    <button
      onClick={() => check(true)}
      disabled={checking}
      title={data?.state === "unknown" ? data.reason : "Check for a newer version"}
      className="px-3 text-left text-[11px] text-faint hover:text-ink-soft disabled:opacity-60"
    >
      {data?.state === "current" ? "✓ " : ""}
      {text}
    </button>
  );
}
