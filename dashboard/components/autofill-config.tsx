"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

interface Props {
  channelId: number;
  enabled: boolean;
  cadenceConfig: string | null;
  minQueueDepth: number;
  targetQueueDepth: number;
  reuseMinAgeDays: number;
}

function parseCadence(raw: string | null): { days: string[]; time: string } {
  try {
    const c = JSON.parse(raw || "");
    return { days: Array.isArray(c.days) ? c.days : [], time: c.time || "18:00" };
  } catch {
    return { days: [], time: "18:00" };
  }
}

export function AutofillConfig(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const initial = parseCadence(props.cadenceConfig);
  const [enabled, setEnabled] = useState(props.enabled);
  const [days, setDays] = useState<string[]>(initial.days);
  const [time, setTime] = useState(initial.time);
  const [minDepth, setMinDepth] = useState(props.minQueueDepth);
  const [target, setTarget] = useState(props.targetQueueDepth);
  const [reuseDays, setReuseDays] = useState(props.reuseMinAgeDays);
  const [pending, startT] = useTransition();
  const [saved, setSaved] = useState(false);

  function toggleDay(d: string) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  async function save() {
    setSaved(false);
    await fetch(`/api/channels/${props.channelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        autofill_enabled: enabled,
        cadence_config: JSON.stringify({ days, time }),
        min_queue_depth: minDepth,
        target_queue_depth: target,
        reuse_min_age_days: reuseDays,
      }),
    });
    setSaved(true);
    startT(() => router.refresh());
  }

  const summary = enabled
    ? `${days.length ? days.map((d) => d[0].toUpperCase() + d.slice(1)).join("/") : "no days"} @ ${time} · keep ≥${minDepth}, fill to ${target}`
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
            Automatically keep this channel&rsquo;s queue topped up
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
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Time</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={field} />
            </label>
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
