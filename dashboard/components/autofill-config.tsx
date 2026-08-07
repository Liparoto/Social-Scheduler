"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DAYS,
  type Cadence,
  coveredBands,
  deriveBand,
  intervalNote,
  parseCadence,
  serializeCadence,
  summarize,
  uncoveredBandWarning,
} from "@/lib/cadence";

interface Props {
  /** Auto-fill config is owned by a GROUP when a channel belongs to one, and by the
   *  channel itself otherwise. Same fields either way — the schema repeats the column
   *  names precisely so this one form can drive both. */
  target: { kind: "channel" | "group"; id: number };
  enabled: boolean;
  cadenceConfig: string | null;
  minQueueDepth: number;
  targetQueueDepth: number;
  reuseMinAgeDays: number;
  bppEveryDays: number;
  /** Marked posts this unit can actually send. */
  bppPoolSize: number;
  /** config.bandTimes — the worker's derive_band inputs. Labels each posting time with its
   *  band, and defines the window bands used to compute the coverage warning below. */
  bandTimes: { morning: string; afternoon: string; evening: string };
  /** Ready feed posts per time_of_day band for this unit — see getBandCounts. Feeds the
   *  coverage warning: a band with posts but no reachable slot would silently stop being
   *  auto-filled. */
  bandCounts: Record<string, number>;
}

// All seven days, for the same reason DEFAULT_INTERVAL carries them: this is what the owner
// lands on when they switch modes, and a slot with no days is DROPPED by the worker's
// _parse_times — leaving parse_cadence returning None and the unit silently not auto-filling
// at all. Exported so a test can hold both defaults to that rule.
export const DEFAULT_TIMES: Cadence = {
  mode: "times",
  slots: [{ time: "18:00", days: [...DAYS] }],
};
export const DEFAULT_INTERVAL: Cadence = {
  mode: "interval",
  everyMinutes: 1440,
  from: "08:00",
  to: "21:00",
  // All seven, not empty — the form always writes an explicit `days`, and an explicitly
  // empty list is invalid (worker/scheduling.py's _parse_interval rejects it and skips the
  // unit). This mirrors the worker's rule that an *absent* days key means every day; the
  // form just has to say so, since it never omits the field. Otherwise the very first click
  // on "Every…" would land on a cadence that saves as unreachable with no warning shown.
  days: [...DAYS],
};

function dayToggleClass(on: boolean): string {
  return `rounded-md px-2 py-1 text-xs font-medium capitalize ${
    on
      ? "bg-brand text-white"
      : "border border-border bg-surface text-muted hover:bg-surface-sunken"
  }`;
}

/** Reused by all three day pickers (per-slot rows and the interval row) so "which days"
 *  always looks and behaves the same way. */
function DayToggles({
  days,
  onToggle,
}: {
  days: string[];
  onToggle: (d: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {DAYS.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onToggle(d)}
          className={dayToggleClass(days.includes(d))}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

export function AutofillConfig(props: Props) {
  const router = useRouter();
  const endpoint =
    props.target.kind === "group"
      ? `/api/channel-groups/${props.target.id}`
      : `/api/channels/${props.target.id}`;
  const noun = props.target.kind === "group" ? "group" : "channel";
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(props.enabled);
  const [cadence, setCadence] = useState<Cadence>(() => parseCadence(props.cadenceConfig));
  // Switching modes must not throw away what was set on the other one — a mis-click on the
  // radio is recoverable, and only Save commits whichever mode is showing.
  const [savedTimes, setSavedTimes] = useState<Cadence>(() =>
    cadence.mode === "times" ? cadence : DEFAULT_TIMES,
  );
  const [savedInterval, setSavedInterval] = useState<Cadence>(() =>
    cadence.mode === "interval" ? cadence : DEFAULT_INTERVAL,
  );
  const [minDepth, setMinDepth] = useState(props.minQueueDepth);
  const [target, setTarget] = useState(props.targetQueueDepth);
  const [reuseDays, setReuseDays] = useState(props.reuseMinAgeDays);
  const [bpp, setBpp] = useState(props.bppEveryDays);
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);

  function switchMode(mode: Cadence["mode"]) {
    if (mode === cadence.mode) return;
    if (cadence.mode === "times") setSavedTimes(cadence);
    else setSavedInterval(cadence);
    setCadence(mode === "times" ? savedTimes : savedInterval);
  }

  async function save() {
    setSaved(false);
    await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autofill_enabled: enabled,
        cadence_config: serializeCadence(cadence),
        min_queue_depth: minDepth,
        target_queue_depth: target,
        reuse_min_age_days: reuseDays,
        bpp_every_days: bpp,
      }),
    });
    setSaved(true);
    startT(() => router.refresh());
  }

  const summary = enabled
    ? `${summarize(cadence)} · keep ≥${minDepth}, fill to ${target}`
    : "Off";

  const field = "rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-brand";

  const covered = coveredBands(cadence, props.bandTimes);
  const uncoveredWarnings = (["morning", "afternoon", "evening"] as const)
    .filter((band) => (props.bandCounts[band] ?? 0) > 0 && !covered.has(band))
    .map((band) => ({ band, count: props.bandCounts[band] }));

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface-sunken/50 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-medium text-ink-soft">
          Auto-fill{" "}
          <span className="text-faint">· {summary}</span>
        </span>
        <span className="text-xs text-muted">{open ? "Hide" : "Edit"}</span>
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Automatically keep this {noun}&rsquo;s queue topped up
          </label>

          <div className="flex gap-4 text-xs text-ink-soft">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={cadence.mode === "times"}
                onChange={() => switchMode("times")}
              />
              At set times
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={cadence.mode === "interval"}
                onChange={() => switchMode("interval")}
              />
              Every…
            </label>
          </div>

          {cadence.mode === "times" ? (
            <div className="space-y-2">
              {cadence.slots.map((slot, i) => {
                const band = deriveBand(slot.time, props.bandTimes);
                return (
                  <div
                    key={i}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2"
                  >
                    <input
                      type="time"
                      value={slot.time}
                      onChange={(e) => {
                        const time = e.target.value;
                        setCadence({
                          mode: "times",
                          slots: cadence.slots.map((s, j) =>
                            j === i ? { ...s, time } : s,
                          ),
                        });
                      }}
                      className={field}
                    />
                    <span className="text-[11px] capitalize text-muted">{band}</span>
                    <DayToggles
                      days={slot.days}
                      onToggle={(d) =>
                        setCadence({
                          mode: "times",
                          slots: cadence.slots.map((s, j) =>
                            j === i
                              ? {
                                  ...s,
                                  days: s.days.includes(d)
                                    ? s.days.filter((x) => x !== d)
                                    : [...s.days, d],
                                }
                              : s,
                          ),
                        })
                      }
                    />
                    {cadence.slots.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setCadence({
                            mode: "times",
                            slots: cadence.slots.filter((_, j) => j !== i),
                          })
                        }
                        className="text-faint hover:text-status-failed"
                        aria-label={`Remove the ${slot.time} slot`}
                        title="Remove this time"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  const lastDays = cadence.slots[cadence.slots.length - 1]?.days ?? [];
                  setCadence({
                    mode: "times",
                    slots: [...cadence.slots, { time: "12:00", days: [...lastDays] }],
                  });
                }}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:border-border-strong hover:text-ink-soft"
              >
                + Add a time
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                <span>Every</span>
                <input
                  type="number"
                  min={0}
                  value={Math.floor(cadence.everyMinutes / 60)}
                  onChange={(e) => {
                    const hours = Math.max(0, Number(e.target.value) || 0);
                    setCadence({
                      ...cadence,
                      everyMinutes: hours * 60 + (cadence.everyMinutes % 60),
                    });
                  }}
                  onBlur={() => {
                    if (cadence.mode === "interval" && cadence.everyMinutes < 15) {
                      setCadence({ ...cadence, everyMinutes: 15 });
                    }
                  }}
                  className={`${field} w-16`}
                />
                <span>h</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={cadence.everyMinutes % 60}
                  onChange={(e) => {
                    const minutes = Math.min(59, Math.max(0, Number(e.target.value) || 0));
                    setCadence({
                      ...cadence,
                      everyMinutes: Math.floor(cadence.everyMinutes / 60) * 60 + minutes,
                    });
                  }}
                  onBlur={() => {
                    if (cadence.mode === "interval" && cadence.everyMinutes < 15) {
                      setCadence({ ...cadence, everyMinutes: 15 });
                    }
                  }}
                  className={`${field} w-16`}
                />
                <span>m</span>
                {cadence.everyMinutes < 15 ? (
                  <span className="text-[11px] text-status-failed">Minimum 15 minutes.</span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                <span>Between</span>
                <input
                  type="time"
                  value={cadence.from}
                  onChange={(e) => setCadence({ ...cadence, from: e.target.value })}
                  className={field}
                />
                <span>and</span>
                <input
                  type="time"
                  value={cadence.to}
                  onChange={(e) => setCadence({ ...cadence, to: e.target.value })}
                  className={field}
                />
              </div>

              <DayToggles
                days={cadence.days}
                onToggle={(d) =>
                  setCadence({
                    ...cadence,
                    days: cadence.days.includes(d)
                      ? cadence.days.filter((x) => x !== d)
                      : [...cadence.days, d],
                  })
                }
              />

              <p className="text-[11px] text-muted">{intervalNote(cadence.everyMinutes)}</p>
            </div>
          )}

          {uncoveredWarnings.length ? (
            <div className="space-y-1">
              {uncoveredWarnings.map(({ band, count }) => (
                <p key={band} className="text-[11px] text-status-publishing">
                  ⚠ {uncoveredBandWarning(band, count, cadence.mode)}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Refill below</span>
              <input
                type="number"
                min={0}
                value={minDepth}
                onChange={(e) => setMinDepth(Number(e.target.value))}
                className={`${field} w-16`}
              />
            </label>
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Fill to</span>
              <input
                type="number"
                min={0}
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
                className={`${field} w-16`}
              />
            </label>
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Reuse after (days)</span>
              <input
                type="number"
                min={0}
                value={reuseDays}
                onChange={(e) => setReuseDays(Number(e.target.value))}
                className={`${field} w-20`}
              />
            </label>
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Repost a BPP every (days)</span>
              <input
                type="number"
                min={0}
                value={bpp}
                onChange={(e) => setBpp(Number(e.target.value))}
                className={`${field} w-20`}
              />
            </label>
          </div>

          {/* Says what the number DOES, in slots, because "4" on its own is ambiguous —
              and states the 0 case, since off is the default and the reader needs to know
              they are looking at the off state rather than an unset one. */}
          {/* The consequence, not just the setting. "Every 14 days" with two posts
              marked means each one reappears monthly — a number the owner would
              otherwise have to work out, and the exact thing they asked to be obvious. */}
          <div className="-mt-1 text-[11px]">
            {bpp > 0 ? (
              <>
                <p className="text-muted">
                  <span className="data text-ink-soft">{props.bppPoolSize}</span> post
                  {props.bppPoolSize === 1 ? "" : "s"} marked BPP ·{" "}
                  {props.bppPoolSize > 0 ? (
                    <>
                      each one comes back roughly every{" "}
                      <span className="data text-ink-soft">
                        {props.bppPoolSize * bpp}
                      </span>{" "}
                      days
                    </>
                  ) : (
                    "nothing marked yet, so nothing will be reposted"
                  )}
                </p>
                {props.bppPoolSize > 0 && props.bppPoolSize * bpp < 90 ? (
                  <p className="mt-1 text-status-publishing">
                    Small pool — the same posts will come round often. Mark more, or
                    increase the gap.
                  </p>
                ) : null}
                {props.bppPoolSize === 0 ? (
                  <p className="mt-1 text-muted">
                    Mark posts from <strong>Insights → your account → Top content</strong>.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted">
                0 = off. Auto-fill picks unposted content first, so your best posts only
                come back once the library runs dry.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={pending}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save auto-fill"}
            </button>
            {saved && !pending ? (
              <span className="text-xs text-status-posted">Saved</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
