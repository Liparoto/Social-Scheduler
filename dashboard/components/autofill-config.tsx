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
  uncoveredBandWarning,
} from "@/lib/cadence";
import {
  type LanePanelData,
  laneFor,
  lanePatchBody,
  panelSummary,
  surfaceLabel,
} from "@/lib/autofill-lanes";
import type { Surface } from "@/lib/types";

// The lane model lives in lib/ so the SERVER pages can call it — a "use client" module's
// non-component exports become client references and throw if a Server Component calls
// them. These two are re-exported because this is where a reader of the panel looks for
// them, and both are client-side. toLanePanels deliberately is NOT: its only callers are
// Server Components, and re-exporting it here would offer them the exact import path that
// throws.
export { DEFAULT_LANE, laneFor } from "@/lib/autofill-lanes";
export type { LanePanelData } from "@/lib/autofill-lanes";

interface Props {
  /** Auto-fill config is owned by a GROUP when a channel belongs to one, and by the
   *  channel itself otherwise. Same fields either way — the lane table repeats the column
   *  names precisely so this one form can drive both. */
  target: { kind: "channel" | "group"; id: number };
  /** One entry per surface this owner offers, saved-or-default — see toLanePanels. */
  lanes: LanePanelData[];
  /** Which surfaces this owner can offer. Always includes "feed"; includes "story" only
   *  when a story-capable channel is in scope, so a lane that could never fire is never
   *  configurable. One entry means no switch at all. */
  surfaces: Surface[];
  bppEveryDays: number;
  /** Marked posts this unit can actually send. */
  bppPoolSize: number;
  /** config.bandTimes — the worker's derive_band inputs. Labels each posting time with its
   *  band, and defines the window bands used to compute the coverage warning below. */
  bandTimes: { morning: string; afternoon: string; evening: string };
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

/**
 * Auto-fill for one unit, one LANE at a time.
 *
 * A single Instagram account runs a feed rotation and a Story rotation on independent
 * cadences, so this panel edits whichever surface the switch is on. It is one panel with a
 * switch rather than two stacked copies because the panel's job is to make the schedule
 * legible at a glance, and a second full-height copy of it buries the thing the owner
 * opened the page to read. The collapsed header still names BOTH lanes.
 *
 * The switch is hidden entirely when only one surface is on offer, so a Telegram-only
 * channel sees exactly the panel it always has.
 */
export function AutofillConfig(props: Props) {
  const endpoint =
    props.target.kind === "group"
      ? `/api/channel-groups/${props.target.id}`
      : `/api/channels/${props.target.id}`;
  const noun = props.target.kind === "group" ? "group" : "channel";
  const [open, setOpen] = useState(false);
  const [surface, setSurface] = useState<Surface>(props.surfaces[0] ?? "feed");
  const multi = props.surfaces.length > 1;

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface-sunken/50 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        {/* Reads what is SAVED, for every lane at once. It is the whole panel's status
            line, and a header that tracked the open lane's unsaved edits would go quiet
            about the other one exactly when the owner wants to compare them. */}
        <span className="text-xs font-medium text-ink-soft">
          Auto-fill{" "}
          <span className="text-faint">· {panelSummary(props.lanes, props.surfaces)}</span>
        </span>
        <span className="text-xs text-muted">{open ? "Hide" : "Edit"}</span>
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          {multi ? (
            <div>
              <div
                role="group"
                aria-label="Which rotation to edit"
                className="inline-flex gap-0.5 rounded-md border border-border bg-surface p-0.5"
              >
                {props.surfaces.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSurface(s)}
                    aria-pressed={s === surface}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                      s === surface
                        ? "bg-brand text-on-brand"
                        : "text-muted hover:text-ink-soft"
                    }`}
                  >
                    {surfaceLabel(s)}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-muted">
                {props.surfaces.map(surfaceLabel).join(" and ")} fill independently — each
                has its own cadence, queue depths and reuse rule. Saving one leaves the
                other untouched.
              </p>
            </div>
          ) : null}

          {/* Keyed on the surface so switching REMOUNTS the editor and every field
              re-seeds from that lane. The alternative — syncing six useStates in an
              effect — is the version that eventually shows the feed's 18:00 on a Story
              lane that has never been configured, which would post at the wrong hour the
              moment it was switched on. */}
          <LaneEditor
            key={surface}
            lane={laneFor(props.lanes, surface)}
            multi={multi}
            noun={noun}
            endpoint={endpoint}
            bandTimes={props.bandTimes}
            bppEveryDays={props.bppEveryDays}
            bppPoolSize={props.bppPoolSize}
          />
        </div>
      ) : null}
    </div>
  );
}

function LaneEditor({
  lane,
  multi,
  noun,
  endpoint,
  bandTimes,
  bppEveryDays,
  bppPoolSize,
}: {
  lane: LanePanelData;
  /** Whether the panel offers more than one surface — decides whether the fields need to
   *  say which lane they belong to. */
  multi: boolean;
  noun: string;
  endpoint: string;
  bandTimes: { morning: string; afternoon: string; evening: string };
  bppEveryDays: number;
  bppPoolSize: number;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(lane.enabled);
  const [cadence, setCadence] = useState<Cadence>(() => parseCadence(lane.cadenceConfig));
  // Switching modes must not throw away what was set on the other one — a mis-click on the
  // radio is recoverable, and only Save commits whichever mode is showing.
  const [savedTimes, setSavedTimes] = useState<Cadence>(() =>
    cadence.mode === "times" ? cadence : DEFAULT_TIMES,
  );
  const [savedInterval, setSavedInterval] = useState<Cadence>(() =>
    cadence.mode === "interval" ? cadence : DEFAULT_INTERVAL,
  );
  const [minDepth, setMinDepth] = useState(lane.minQueueDepth);
  const [target, setTarget] = useState(lane.targetQueueDepth);
  const [reuseDays, setReuseDays] = useState(lane.reuseMinAgeDays);
  const [bpp, setBpp] = useState(bppEveryDays);
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);

  // BPP recycling is an OWNER-level, feed-only dial (migration 0028 deliberately left the
  // bpp_* columns off the lane), so it neither shows nor saves from a Story lane.
  const isFeed = lane.surface === "feed";

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
      // Which lane is named, and whether BPP travels with it, are write-path rules with
      // no visible markup — so they live in a pure function the tests can assert on.
      body: JSON.stringify(
        lanePatchBody(lane, { enabled, cadence, minDepth, target, reuseDays, bpp }),
      ),
    });
    setSaved(true);
    startT(() => router.refresh());
  }

  const field = "rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-brand";

  const covered = coveredBands(cadence, bandTimes);
  const uncoveredWarnings = (["morning", "afternoon", "evening"] as const)
    .filter((band) => (lane.bandCounts[band] ?? 0) > 0 && !covered.has(band))
    .map((band) => ({ band, count: lane.bandCounts[band] }));

  return (
    <>
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Automatically keep this {noun}&rsquo;s{" "}
        {multi ? `${surfaceLabel(lane.surface)} ` : ""}queue topped up
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
            const band = deriveBand(slot.time, bandTimes);
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
        {isFeed ? (
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
        ) : null}
      </div>

      {/* Says what the number DOES, in slots, because "4" on its own is ambiguous —
          and states the 0 case, since off is the default and the reader needs to know
          they are looking at the off state rather than an unset one. */}
      {/* The consequence, not just the setting. "Every 14 days" with two posts
          marked means each one reappears monthly — a number the owner would
          otherwise have to work out, and the exact thing they asked to be obvious. */}
      {isFeed ? (
        <div className="-mt-1 text-[11px]">
          {bpp > 0 ? (
            <>
              <p className="text-muted">
                <span className="data text-ink-soft">{bppPoolSize}</span> post
                {bppPoolSize === 1 ? "" : "s"} marked BPP ·{" "}
                {bppPoolSize > 0 ? (
                  <>
                    each one comes back roughly every{" "}
                    <span className="data text-ink-soft">{bppPoolSize * bpp}</span> days
                  </>
                ) : (
                  "nothing marked yet, so nothing will be reposted"
                )}
              </p>
              {bppPoolSize > 0 && bppPoolSize * bpp < 90 ? (
                <p className="mt-1 text-status-publishing">
                  Small pool — the same posts will come round often. Mark more, or
                  increase the gap.
                </p>
              ) : null}
              {bppPoolSize === 0 ? (
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
      ) : null}

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={pending}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
        >
          {/* Names the lane it will write, so Save can never look like it commits both. */}
          {pending
            ? "Saving…"
            : multi
              ? `Save ${surfaceLabel(lane.surface)} auto-fill`
              : "Save auto-fill"}
        </button>
        {saved && !pending ? (
          <span className="text-xs text-status-posted">Saved</span>
        ) : null}
      </div>
    </>
  );
}
