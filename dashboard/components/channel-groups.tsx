"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AutofillConfig } from "./autofill-config";
import { ChannelTimezone } from "./channel-timezone";
import { TimezonePicker } from "./timezone-picker";
import { tzAbbrev } from "@/lib/format";

export interface GroupRow {
  id: number;
  name: string;
  timezone: string;
  autofill_enabled: number;
  cadence_config: string | null;
  min_queue_depth: number;
  target_queue_depth: number;
  reuse_min_age_days: number;
  bpp_every_days: number;
  bpp_pool_size: number;
  /** Ready feed posts per time_of_day band, across every member — see getBandCounts. */
  band_counts: Record<string, number>;
  members: { id: number; account_name: string; platform: string }[];
}

export function ChannelGroups({
  groups,
  defaultTimezone,
  bandTimes,
}: {
  groups: GroupRow[];
  /** The install's DEFAULT_TIMEZONE (from lib/config). A new group starts here rather
   *  than at a hardcoded "UTC" — a group left on the wrong zone posts to real accounts
   *  at the wrong wall-clock hour. */
  defaultTimezone: string;
  /** config.bandTimes, passed down from the server page — this is a client component and
   *  lib/config.ts is server-only, so it cannot import it directly. */
  bandTimes: { morning: string; afternoon: string; evening: string };
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [tzValid, setTzValid] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startT] = useTransition();

  // Stable identity so TimezonePicker's effect doesn't re-fire every render.
  const handleTzValidity = useCallback((v: boolean) => setTzValid(v), []);

  async function create() {
    setError(null);
    const res = await fetch("/api/channel-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, timezone }),
    });
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error || "Could not create the group.");
      return;
    }
    setName("");
    setTimezone(defaultTimezone);
    startT(() => router.refresh());
  }

  async function remove(id: number, label: string) {
    if (
      !window.confirm(
        `Delete the group "${label}"?\n\nIts channels go back to auto-filling on their own. ` +
          `Nothing already scheduled is changed or deleted.`
      )
    ) {
      return;
    }
    await fetch(`/api/channel-groups/${id}`, { method: "DELETE" });
    startT(() => router.refresh());
  }

  const field =
    "rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-brand";

  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-ink">Auto-fill groups</h2>
        <p className="mt-1 text-xs text-muted">
          Channels in a group auto-fill together — the same content, at the same moment, on one
          cadence. A channel that can&rsquo;t take a post (Threads and video, say) sits that slot
          out; anything blocked by a cooldown or blackout holds the whole group back.
        </p>
      </div>

      <div className="space-y-3">
        {groups.map((g) => (
          <div key={g.id} className="rounded-card border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-ink">{g.name}</p>
                <p className="mt-0.5 text-xs text-muted">
                  <span className="data">
                    {g.timezone} · {tzAbbrev(g.timezone)}
                  </span>{" "}
                  ·{" "}
                  {g.members.length
                    ? g.members.map((m) => m.account_name).join(" + ")
                    : "no channels yet"}
                </p>
              </div>
              <button
                onClick={() => remove(g.id, g.name)}
                disabled={pending}
                className="text-xs text-muted hover:text-status-failed disabled:opacity-50"
              >
                Delete
              </button>
            </div>
            {/* The group owns its members' timezone: one preview, one confirm, every
                member's pending sends moved together. Same control the ungrouped
                channels use. */}
            <ChannelTimezone target={{ kind: "group", id: g.id }} timezone={g.timezone} />
            <AutofillConfig
              target={{ kind: "group", id: g.id }}
              enabled={g.autofill_enabled === 1}
              cadenceConfig={g.cadence_config}
              minQueueDepth={g.min_queue_depth}
              targetQueueDepth={g.target_queue_depth}
              reuseMinAgeDays={g.reuse_min_age_days}
              bppEveryDays={g.bpp_every_days ?? 0}
              bppPoolSize={g.bpp_pool_size ?? 0}
              bandTimes={bandTimes}
              bandCounts={g.band_counts ?? {}}
            />
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-card border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start gap-3">
          <label className="text-xs text-ink-soft">
            <span className="mb-1 block">New group</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Personal"
              className={field}
            />
          </label>
          <div className="min-w-56 text-xs text-ink-soft">
            <span className="mb-1 block">Timezone</span>
            {/* Same picker the channel form uses, so an invalid zone can't be typed —
                and a group that silently stayed on "UTC" posted at the wrong hour. */}
            <TimezonePicker
              value={timezone}
              onChange={setTimezone}
              onValidityChange={handleTzValidity}
              className={`w-full ${field}`}
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={create}
            disabled={pending || !name.trim() || !tzValid}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
          >
            Create group
          </button>
          {error ? <span className="text-xs text-status-failed">{error}</span> : null}
        </div>
      </div>
    </section>
  );
}
