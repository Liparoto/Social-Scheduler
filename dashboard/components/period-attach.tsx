"use client";

import Link from "next/link";
import type { Period, PeriodLink, PeriodMode } from "@/lib/types";
import { describePeriod } from "@/lib/format";
import {
  coverageLabel,
  coverageState,
  type CoverageState,
} from "@/lib/bulk-edit-context";

const coverageBadgeClass: Record<CoverageState, string> = {
  all: "border-status-posted/60 bg-status-posted/15 text-status-posted",
  some: "border-amber-500/60 bg-amber-500/10 text-amber-700",
  none: "border-border bg-surface text-faint",
};

export function toggleExactPeriodLink(
  current: PeriodLink[],
  periodId: number,
  mode: PeriodMode,
): PeriodLink[] {
  const selected = current.some((link) => link.periodId === periodId && link.mode === mode);
  if (selected) {
    return current.filter((link) => link.periodId !== periodId || link.mode !== mode);
  }
  return [...current, { periodId, mode }];
}

interface SharedPeriodAttachProps {
  periods: Period[];
  coverage?: Record<string, number>;
  selectedPostCount?: number;
  hideZeroCoverage?: boolean;
  disableFullCoverage?: boolean;
}

type PeriodAttachProps = SharedPeriodAttachProps &
  (
    | {
        value: Record<number, PeriodMode>;
        onChange: (value: Record<number, PeriodMode>) => void;
        exactValue?: never;
        onExactChange?: never;
      }
    | {
        exactValue: PeriodLink[];
        onExactChange: (value: PeriodLink[]) => void;
        value?: never;
        onChange?: never;
      }
  );

export function PeriodAttach({
  periods,
  value,
  onChange,
  exactValue,
  onExactChange,
  coverage,
  selectedPostCount = 0,
  hideZeroCoverage = false,
  disableFullCoverage = false,
}: PeriodAttachProps) {
  function setMode(periodId: number, mode: PeriodMode | null) {
    if (exactValue && onExactChange) {
      onExactChange(
        mode === null
          ? exactValue.filter((link) => link.periodId !== periodId)
          : toggleExactPeriodLink(exactValue, periodId, mode),
      );
      return;
    }
    if (!value || !onChange) return;
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
      <span className={`ml-1 rounded-full border px-1.5 py-0.5 text-[10px] ${coverageBadgeClass[state]}`}>
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
            const mode = value?.[p.id];
            const hasExactMode = (candidate: PeriodMode) =>
              exactValue?.some(
                (link) => link.periodId === p.id && link.mode === candidate,
              ) ?? false;
            const hasAnyExactMode = exactValue?.some((link) => link.periodId === p.id) ?? false;
            const greenCount = countFor(p.id, "green");
            const blackoutCount = countFor(p.id, "blackout");
            return (
              <li
                key={p.id}
                className={
                  coverage
                    ? "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                    : "flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                }
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{p.name}</p>
                  <p className="data text-xs text-ink-soft">{describePeriod(p)}</p>
                </div>
                <div
                  className={
                    coverage
                      ? "flex flex-wrap justify-end rounded-lg border border-border p-0.5"
                      : "inline-flex shrink-0 rounded-lg border border-border p-0.5"
                  }
                >
                  <button
                    type="button"
                    className={segBtn(
                      exactValue ? !hasAnyExactMode : !mode,
                      "bg-brand-weak text-brand-strong",
                    )}
                    onClick={() => setMode(p.id, null)}
                  >
                    Off
                  </button>
                  {!coverage || !hideZeroCoverage || greenCount > 0 ? (
                    <button
                      type="button"
                      className={`${segBtn(exactValue ? hasExactMode("green") : mode === "green", "bg-status-posted/20 text-brand-strong")} disabled:cursor-not-allowed disabled:opacity-60`}
                      onClick={() => setMode(p.id, "green")}
                      disabled={modeDisabled(p.id, "green")}
                    >
                      Green{modeBadge(p.id, "green")}
                    </button>
                  ) : null}
                  {!coverage || !hideZeroCoverage || blackoutCount > 0 ? (
                    <button
                      type="button"
                      className={`${segBtn(exactValue ? hasExactMode("blackout") : mode === "blackout", "bg-surface-sunken text-ink")} disabled:cursor-not-allowed disabled:opacity-60`}
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
