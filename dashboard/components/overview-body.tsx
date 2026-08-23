"use client";

import { useState } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { ChannelQueueRail, type RailChannel } from "@/components/channel-queue-rail";
import { PublicationQueue } from "@/components/publication-queue";
import { RefreshAllMetrics } from "@/components/refresh-all-metrics";
import { WorkerStatus } from "@/components/worker-status";
import type { PublicationRow } from "@/lib/queries";
import type { Period, Tag } from "@/lib/types";

/**
 * The two Overview sections that share one piece of state: which accounts to show.
 *
 * They were separate server-rendered blocks until the rail became clickable. A filter
 * driven from two places has to live above both of them, or the cards and the Accounts
 * dropdown drift apart and the page shows one thing while its controls claim another.
 *
 * Everything expensive is still computed on the SERVER and handed down — this component
 * adds a selection and nothing else. Counts arrive as arrays rather than Maps so the
 * boundary crossing is plain data.
 */
export function OverviewBody({
  channels,
  scheduledCounts,
  nextScheduled,
  attention,
  failedCount,
  pubs,
  periods,
  timeOfDayTags,
  topicTags,
  workerOnline,
  workerLastSeenAt,
  blockedIds,
}: {
  channels: RailChannel[];
  scheduledCounts: [number, number][];
  nextScheduled: [number, string][];
  attention: string[];
  failedCount: number;
  pubs: PublicationRow[];
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  workerOnline: boolean;
  workerLastSeenAt: string | null;
  blockedIds: number[];
}) {
  // Empty = every account. Same meaning an unfiltered list already had, so there is no
  // "all" sentinel that could fall out of step with the cards.
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const counts = new Map(scheduledCounts);
  const nextAt = new Map(nextScheduled);

  function toggle(channelId: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  const filteringLabel =
    selected.size === 0
      ? null
      : selected.size === 1
        ? channels.find((c) => selected.has(c.id))?.account_name ?? "1 account"
        : `${selected.size} accounts`;

  return (
    <>
      <section>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted">
            Channel queues
          </h2>
          <div className="flex items-center gap-3">
            {filteringLabel ? (
              // Says what the page is currently hiding. A filtered list that looks like
              // an unfiltered one is how people conclude their posts vanished.
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-ink-soft hover:bg-surface-sunken"
              >
                Showing {filteringLabel} · clear
              </button>
            ) : null}
            {attention.length > 0 ? (
              <span
                className={`data text-xs font-medium ${
                  failedCount > 0 ? "text-status-failed" : "text-status-blocked"
                }`}
              >
                {attention.join(" · ")} · needs attention
              </span>
            ) : null}
          </div>
        </div>
        <ChannelQueueRail
          channels={channels}
          counts={counts}
          nextAt={nextAt}
          selected={selected}
          onToggle={toggle}
        />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted">
            Publications
          </h2>
          <div className="flex items-center gap-3">
            <WorkerStatus online={workerOnline} lastSeenAt={workerLastSeenAt} />
            <RefreshAllMetrics workerOnline={workerOnline} />
          </div>
        </div>
        {pubs.length === 0 ? (
          <EmptyState title="Nothing here yet">
            Composed posts and their scheduled sends show up here — failures float to the
            top so they&rsquo;re never silent.
          </EmptyState>
        ) : (
          <PublicationQueue
            pubs={pubs}
            channels={channels}
            periods={periods}
            timeOfDayTags={timeOfDayTags}
            topicTags={topicTags}
            workerOnline={workerOnline}
            blockedIds={blockedIds}
            selectedChannels={selected}
            onSelectedChannelsChange={setSelected}
          />
        )}
      </section>
    </>
  );
}

/** Kept so the empty state can still point people at /channels. */
export function NoChannelsYet() {
  return (
    <EmptyState title="No channels yet">
      Add an Instagram or Facebook account on the{" "}
      <Link href="/channels" className="text-brand underline underline-offset-2">
        Channels
      </Link>{" "}
      page before scheduling anything.
    </EmptyState>
  );
}
