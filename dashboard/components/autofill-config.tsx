"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

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
}

/** Accepts both cadence shapes: the original single `time`, and `times` for accounts
 *  posting several times a day. Always hands back a list, so the form has one model. */
function parseCadence(raw: string | null): { days: string[]; times: string[] } {
  try {
    const c = JSON.parse(raw || "");
    const times = Array.isArray(c.times) && c.times.length
      ? c.times
      : c.time
        ? [c.time]
        : ["18:00"];
    return { days: Array.isArray(c.days) ? c.days : [], times };
  } catch {
    return { days: [], times: ["18:00"] };
  }
}

export function AutofillConfig(props: Props) {
  const router = useRouter();
  const endpoint =
    props.target.kind === "group"
      ? `/api/channel-groups/${props.target.id}`
      : `/api/channels/${props.target.id}`;
  const noun = props.target.kind === "group" ? "group" : "channel";
  const [open, setOpen] = useState(false);
  const initial = parseCadence(props.cadenceConfig);
  const [enabled, setEnabled] = useState(props.enabled);
  const [days, setDays] = useState<string[]>(initial.days);
  const [times, setTimes] = useState<string[]>(initial.times);
  const [minDepth, setMinDepth] = useState(props.minQueueDepth);
  const [target, setTarget] = useState(props.targetQueueDepth);
  const [reuseDays, setReuseDays] = useState(props.reuseMinAgeDays);
  const [bpp, setBpp] = useState(props.bppEveryDays);
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);

  function toggleDay(d: string) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  async function save() {
    setSaved(false);
    await fetch(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autofill_enabled: enabled,
        // Written as `times` even when there is one, so the stored shape stops depending
        // on how many the owner happens to have chosen. Readers accept both.
        cadence_config: JSON.stringify({ days, times: times.filter(Boolean).sort() }),
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
    ? `${days.length ? days.map((d) => d[0].toUpperCase() + d.slice(1)).join("/") : "no days"} @ ${times.join(", ")} · keep ≥${minDepth}, fill to ${target}`
    : "Off";

  const field = "rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-brand";

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

          <div>
            <p className="mb-1 text-xs text-muted">Post on</p>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d) => (
                <button
                  key={d}
                  onClick={() => toggleDay(d)}
                  className={`rounded-md px-2 py-1 text-xs font-medium capitalize ${
                    days.includes(d)
                      ? "bg-brand text-white"
                      : "border border-border bg-surface text-muted hover:bg-surface-sunken"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {/* One row per posting time. An account posting 2-4 times a day sets several;
                everyone else sees exactly what they saw before, one time with no extra
                controls to reason about. */}
            <div className="text-xs text-ink-soft">
              <span className="mb-1 block">
                {times.length > 1 ? `Times (${times.length} a day)` : "Time"}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {times.map((t, i) => (
                  <span key={i} className="inline-flex items-center gap-1">
                    <input
                      type="time"
                      value={t}
                      onChange={(e) =>
                        setTimes(times.map((x, j) => (j === i ? e.target.value : x)))
                      }
                      className={field}
                    />
                    {times.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => setTimes(times.filter((_, j) => j !== i))}
                        className="text-faint hover:text-status-failed"
                        aria-label={`Remove the ${t} slot`}
                        title="Remove this time"
                      >
                        ×
                      </button>
                    ) : null}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setTimes([...times, "12:00"])}
                  className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:border-border-strong hover:text-ink-soft"
                >
                  + Add a time
                </button>
              </div>
              {times.length > 1 ? (
                <p className="mt-1 text-[11px] text-muted">
                  <span className="data">{times.length}</span> posts on each active day.
                  Time-of-day tags are ignored while more than one time is set — the
                  cadence decides.
                </p>
              ) : null}
            </div>
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
