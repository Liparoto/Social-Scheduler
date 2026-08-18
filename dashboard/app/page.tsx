import Link from "next/link";
import {
  blockedPublicationIds,
  getActiveChannels,
  getPublicationsOverview,
  getWorkerStatus,
  listPeriods,
  listTags,
} from "@/lib/queries";
import { PageHeader, ChannelChip, EmptyState } from "@/components/ui";
import { RefreshAllMetrics } from "@/components/refresh-all-metrics";
import { PublicationQueue } from "@/components/publication-queue";
import { WorkerStatus } from "@/components/worker-status";
import { formatInTz, tzAbbrev, channelColor } from "@/lib/format";

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
  ].filter(Boolean);

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
        {/* Signature: per-channel queue rail — where & when, at a glance */}
        {channels.length > 0 ? (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted">
                Channel queues
              </h2>
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {channels.map((c) => {
                const color = channelColor(c.id, c.color_hue);
                const count = scheduledByChannel.get(c.id) ?? 0;
                const next = nextByChannel.get(c.id);
                return (
                  <div
                    key={c.id}
                    className="rounded-card border border-border bg-surface p-4"
                    style={{ borderLeft: `3px solid ${color.dot}` }}
                  >
                    <div className="flex items-center justify-between">
                      <ChannelChip id={c.id} platform={c.platform} name={c.account_name} colorHue={c.color_hue} avatarPath={c.avatar_path} />
                      <span className="data text-lg font-semibold text-ink">{count}</span>
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      {count === 0
                        ? "Nothing scheduled ahead"
                        : next
                          ? `Next ${formatInTz(next, c.timezone)} ${tzAbbrev(c.timezone)}`
                          : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <EmptyState title="No channels yet">
            Add an Instagram or Facebook account on the{" "}
            <Link href="/channels" className="text-brand underline underline-offset-2">
              Channels
            </Link>{" "}
            page before scheduling anything.
          </EmptyState>
        )}

        {/* The queue itself */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted">
              Publications
            </h2>
            <div className="flex items-center gap-3">
              <WorkerStatus online={worker.online} lastSeenAt={worker.lastSeenAt} />
              <RefreshAllMetrics workerOnline={worker.online} />
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
              // For the quick-edit dialog a queue row can open. Read here rather than
              // fetched by the dialog because they are small, shared by every post, and
              // already on the server — the same call /library makes.
              periods={listPeriods()}
              timeOfDayTags={listTags("time_of_day")}
              topicTags={listTags("topic")}
              workerOnline={worker.online}
              blockedIds={blockedIds}
            />
          )}
        </section>
      </div>
    </div>
  );
}
