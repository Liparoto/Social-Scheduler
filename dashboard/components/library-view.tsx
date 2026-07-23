"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { channelColor, formatInTz } from "@/lib/format";

interface PostLite {
  id: number;
  caption: string | null;
  post_type: string;
  status: string;
  first_asset_id: number | null;
  asset_count: number;
  scheduled_count: number;
  posted_count: number;
  last_posted_at: string | null;
}
interface ChannelLite {
  id: number;
  account_name: string;
  platform: string;
  timezone: string;
  requires_approval: boolean;
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function LibraryView({
  posts,
  channels,
}: {
  posts: PostLite[];
  channels: ChannelLite[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<number[]>([]); // ordered = post order
  const [chans, setChans] = useState<Set<number>>(new Set());
  const [everyDays, setEveryDays] = useState(2);
  const [time, setTime] = useState("18:00");
  const [startDate, setStartDate] = useState(tomorrow());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startT] = useTransition();

  function toggle(id: number) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }
  function toggleChan(id: number) {
    setChans((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function schedule() {
    setError(null);
    setNotice(null);
    if (selected.length === 0) return setError("Select at least one post.");
    if (chans.size === 0) return setError("Select at least one channel.");
    const res = await fetch("/api/posts/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        post_ids: selected,
        channel_ids: Array.from(chans),
        every_days: everyDays,
        time,
        start_date: startDate,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "Could not bulk-schedule.");
      return;
    }
    setNotice(`Scheduled ${body.created} publication${body.created === 1 ? "" : "s"}.`);
    setSelected([]);
    setChans(new Set());
    startT(() => router.refresh());
  }

  const field =
    "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";

  return (
    <div className="space-y-5">
      {/* Post grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {posts.map((p) => {
          const on = selected.includes(p.id);
          const order = selected.indexOf(p.id) + 1;
          return (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className={`flex gap-3 rounded-card border bg-surface p-3 text-left transition-colors ${
                on ? "border-brand" : "border-border hover:bg-surface-sunken"
              }`}
            >
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-surface-sunken">
                {p.first_asset_id ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${p.first_asset_id}?variant=thumb`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : null}
                {on ? (
                  <span className="data absolute inset-0 flex items-center justify-center bg-brand/70 text-sm font-semibold text-white">
                    {order}
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm text-ink">
                  {p.caption || <span className="text-faint italic">No caption</span>}
                </p>
                <div className="data mt-1 flex flex-wrap gap-x-2 text-[10px] text-faint">
                  <span>{p.post_type}</span>
                  {p.asset_count > 1 ? <span>{p.asset_count} imgs</span> : null}
                  {p.posted_count > 0 ? (
                    <span className="text-status-posted">posted×{p.posted_count}</span>
                  ) : (
                    <span>never posted</span>
                  )}
                  {p.scheduled_count > 0 ? (
                    <span className="text-status-scheduled">queued×{p.scheduled_count}</span>
                  ) : null}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Bulk schedule bar */}
      <div className="sticky bottom-4 rounded-card border border-border-strong bg-surface p-4 shadow-lg">
        <div className="flex flex-wrap items-end gap-4">
          <div className="text-sm">
            <span className="data text-lg font-semibold text-ink">{selected.length}</span>
            <span className="text-muted"> post{selected.length === 1 ? "" : "s"} selected</span>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Every</span>
              <input
                type="number"
                min={1}
                value={everyDays}
                onChange={(e) => setEveryDays(Number(e.target.value))}
                className={`${field} w-16`}
              />
            </label>
            <span className="pb-2 text-sm text-muted">days at</span>
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Time</span>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={field}
              />
            </label>
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Starting</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={field}
              />
            </label>
          </div>
        </div>

        <div className="mt-3">
          <p className="mb-1.5 text-xs text-ink-soft">To channels:</p>
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => {
              const on = chans.has(c.id);
              const color = channelColor(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleChan(c.id)}
                  className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium"
                  style={
                    on
                      ? { color: color.fg, backgroundColor: color.bg, borderColor: color.dot }
                      : { borderColor: "var(--color-border)", color: "var(--color-muted)" }
                  }
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: on ? color.dot : "var(--color-faint)" }}
                  />
                  {c.account_name}
                </button>
              );
            })}
          </div>
        </div>

        {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-brand-ink">{notice}</p> : null}

        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-[11px] text-faint">
            {selected.length > 0 && chans.size > 0
              ? `${selected.length} post(s) × ${chans.size} channel(s), one every ${everyDays} day(s) from ${formatInTz(
                  `${startDate}T${time}:00Z`,
                  "UTC",
                  { month: "short", day: "numeric" }
                )}.`
              : "Select posts and channels to bulk-schedule."}
          </p>
          <button
            onClick={schedule}
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-ink disabled:opacity-50"
          >
            {pending ? "Scheduling…" : "Bulk schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
