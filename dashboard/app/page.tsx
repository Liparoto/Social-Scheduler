import Link from "next/link";
import {
  blockedPublicationIds,
  getActiveChannels,
  getPublicationsOverview,
  getWorkerStatus,
  listPeriods,
  listTags,
} from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import { NoChannelsYet, OverviewBody } from "@/components/overview-body";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  const channels = getActiveChannels();
  const pubs = getPublicationsOverview();
  const worker = getWorkerStatus();

  const scheduledByChannel = new Map<number, number>();
  const nextByChannel = new Map<number, string>();
  for (const p of pubs) {
    if (p.status === "scheduled" || p.status === "pending_approval") {
      scheduledByChannel.set(p.channel_id, (scheduledByChannel.get(p.channel_id) ?? 0) + 1);
      if (!nextByChannel.has(p.channel_id)) nextByChannel.set(p.channel_id, p.scheduled_at);
    }
  }
  // Derived once, on the server, and handed down — so the rows and the counter below
  // judge "overdue" against the SAME instant, and the value is baked into the HTML
  // rather than recomputed at hydration (which would flash or mismatch).
  const blockedIds = blockedPublicationIds(pubs);
  const failedCount = pubs.filter((p) => p.status === "failed").length;
  // Blocked sends need a human too — they are stuck, just not dead. Leaving them out of
  // this line is what let a post sit "Scheduled" and unnoticed.
  const attention = [
    failedCount > 0 ? `${failedCount} failed` : null,
    blockedIds.length > 0 ? `${blockedIds.length} blocked` : null,
    // filter(Boolean) does not narrow the type on its own, and this now crosses a
    // component boundary that cares.
  ].filter((line): line is string => line !== null);

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Everything queued, and exactly which account it's headed to."
        action={
          <Link
            href="/compose"
            className="inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent shadow-sm hover:bg-accent-ink"
          >
            Compose post
          </Link>
        }
      />

      <div className="px-8 py-6 space-y-8">
        {channels.length > 0 ? (
          <OverviewBody
            channels={channels}
            // Maps are rebuilt client-side from plain arrays: what crosses the boundary
            // stays obviously serialisable.
            scheduledCounts={[...scheduledByChannel.entries()]}
            nextScheduled={[...nextByChannel.entries()]}
            attention={attention}
            failedCount={failedCount}
            pubs={pubs}
            // Read server-side, exactly as /library does — small, stable lists the
            // quick-edit dialog needs for its period and tag pickers.
            periods={listPeriods()}
            timeOfDayTags={listTags("time_of_day")}
            topicTags={listTags("topic")}
            workerOnline={worker.online}
            workerLastSeenAt={worker.lastSeenAt}
            blockedIds={blockedIds}
          />
        ) : (
          <NoChannelsYet />
        )}
      </div>
    </div>
  );
}
