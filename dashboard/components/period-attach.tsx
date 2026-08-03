"use client";

import Link from "next/link";
import type { Period, PeriodMode } from "@/lib/types";
import { describePeriod } from "@/lib/format";
import {
  coverageLabel,
  coverageState,
  type CoverageState,
} from "@/lib/bulk-edit-context";

const coverageBadgeClass: Record<CoverageState, string> = {
  all: "border border-status-posted/30 bg-status-posted/15 text-status-posted",
  some: "border border-amber-300 bg-amber-100 text-amber-800",
  none: "border border-border bg-surface-sunken text-faint",
};

export function PeriodAttach({
  periods,
  value,
  onChange,
  coverage,
  selectedPostCount = 0,
  hideZeroCoverage = false,
  disableFullCoverage = false,
}: {
  periods: Period[];
  value: Record<number, PeriodMode>;
  onChange: (v: Record<number, PeriodMode>) => void;
  coverage?: Record<string, number>;
  selectedPostCount?: number;
  hideZeroCoverage?: boolean;
  disableFullCoverage?: boolean;
}) {
  function setMode(periodId: number, mode: PeriodMode | null) {
    const next = { ...value };
    if (mode === null) delete next[periodId];
    else next[periodId] = mode;
    onChange(next);
  }

  const segBtn = (active: boolean, activeCls: string) =>
    `rounded-md px-2.5 py-1 text-xs transition-colors ${
      active ? `${activeCls} font-medium` : "text-muted hover:text-ink"
    }`;

  const countFor = (periodId: number, mode: PeriodMode) =>
    coverage?.[`${periodId}:${mode}`] ?? 0;
  const visiblePeriods = coverage && hideZeroCoverage
    ? periods.filter(
        (period) =>
          countFor(period.id, "green") > 0 || countFor(period.id, "blackout") > 0,
      )
    : periods;

  function modeBadge(periodId: number, mode: PeriodMode) {
    if (!coverage) return null;
    const count = countFor(periodId, mode);
    const state = coverageState(count, selectedPostCount);
    return (
      <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] ${coverageBadgeClass[state]}`}>
        {coverageLabel(count, selectedPostCount)}
      </span>
    );
  }

  function modeDisabled(periodId: number, mode: PeriodMode): boolean {
    return Boolean(
      coverage &&
        disableFullCoverage &&
        coverageState(countFor(periodId, mode), selectedPostCount) === "all",
    );
  }

  return (
    <section className="rounded-card border border-border bg-surface p-5">
      <h3 className="font-display text-sm font-semibold text-ink">In-season windows</h3>
      <p className="mb-3 text-xs text-muted">
        Green = only auto-posts during the window. Blackout = never during it. Blackout
        wins.
      </p>
      {visiblePeriods.length === 0 ? (
        <p className="text-xs text-faint">
          {coverage && hideZeroCoverage ? (
            "None of the selected posts have removable period links."
          ) : (
            <>
              No periods yet — create in-season windows in{" "}
              <Link href="/periods" className="text-brand underline underline-offset-2">
                Periods
              </Link>
              .
            </>
          )}
        </p>
      ) : (
        <ul className="space-y-2">
          {visiblePeriods.map((p) => {
            const mode = value[p.id];
            const greenCount = countFor(p.id, "green");
            const blackoutCount = countFor(p.id, "blackout");
            return (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{p.name}</p>
                  <p className="data text-xs text-ink-soft">{describePeriod(p)}</p>
                </div>
                <div className="flex flex-wrap justify-end rounded-lg border border-border p-0.5">
                  <button
                    type="button"
                    className={segBtn(!mode, "bg-brand-weak text-brand-strong")}
                    onClick={() => setMode(p.id, null)}
                  >
                    Off
                  </button>
                  {!coverage || !hideZeroCoverage || greenCount > 0 ? (
                    <button
                      type="button"
                      className={`${segBtn(mode === "green", "bg-status-posted/20 text-brand-strong")} disabled:cursor-not-allowed disabled:opacity-60`}
                      onClick={() => setMode(p.id, "green")}
                      disabled={modeDisabled(p.id, "green")}
                    >
                      Green{modeBadge(p.id, "green")}
                    </button>
                  ) : null}
                  {!coverage || !hideZeroCoverage || blackoutCount > 0 ? (
                    <button
                      type="button"
                      className={`${segBtn(mode === "blackout", "bg-surface-sunken text-ink")} disabled:cursor-not-allowed disabled:opacity-60`}
                      onClick={() => setMode(p.id, "blackout")}
                      disabled={modeDisabled(p.id, "blackout")}
                    >
                      Blackout{modeBadge(p.id, "blackout")}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
