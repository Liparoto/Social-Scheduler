"use client";

import Link from "next/link";
import type { Period, PeriodMode } from "@/lib/types";
import { describePeriod } from "@/lib/format";

export function PeriodAttach({
  periods,
  value,
  onChange,
}: {
  periods: Period[];
  value: Record<number, PeriodMode>;
  onChange: (v: Record<number, PeriodMode>) => void;
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

  return (
    <section className="rounded-card border border-border bg-surface p-5">
      <h3 className="font-display text-sm font-semibold text-ink">In-season windows</h3>
      <p className="mb-3 text-xs text-muted">
        Green = only auto-posts during the window. Blackout = never during it. Blackout
        wins.
      </p>
      {periods.length === 0 ? (
        <p className="text-xs text-faint">
          No periods yet — create in-season windows in{" "}
          <Link href="/periods" className="text-brand underline underline-offset-2">
            Periods
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {periods.map((p) => {
            const mode = value[p.id];
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{p.name}</p>
                  <p className="data text-xs text-ink-soft">{describePeriod(p)}</p>
                </div>
                <div className="inline-flex shrink-0 rounded-lg border border-border p-0.5">
                  <button
                    type="button"
                    className={segBtn(!mode, "bg-brand-weak text-brand-ink")}
                    onClick={() => setMode(p.id, null)}
                  >
                    Off
                  </button>
                  <button
                    type="button"
                    className={segBtn(mode === "green", "bg-status-posted/20 text-brand-ink")}
                    onClick={() => setMode(p.id, "green")}
                  >
                    Green
                  </button>
                  <button
                    type="button"
                    className={segBtn(mode === "blackout", "bg-surface-sunken text-ink")}
                    onClick={() => setMode(p.id, "blackout")}
                  >
                    Blackout
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
