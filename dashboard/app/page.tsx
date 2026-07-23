import Link from "next/link";
import { getActiveChannels, getPublicationsOverview } from "@/lib/queries";
import { PageHeader, StatusBadge, ChannelChip, EmptyState } from "@/components/ui";
import { PublicationActions } from "@/components/publication-actions";
import { formatInTz, tzAbbrev, channelColor } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function OverviewPage() {
  const channels = getActiveChannels();
  const pubs = getPublicationsOverview();

  const scheduledByChannel = new Map<number, number>();
  const nextByChannel = new Map<number, string>();
  for (const p of pubs) {
    if (p.status === "scheduled" || p.status === "pending_approval") {
      scheduledByChannel.set(p.channel_id, (scheduledByChannel.get(p.channel_id) ?? 0) + 1);
      if (!nextByChannel.has(p.channel_id)) nextByChannel.set(p.channel_id, p.scheduled_at);
    }
  }
  const failedCount = pubs.filter((p) => p.status === "failed").length;

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Everything queued, and exactly which account it's headed to."
        action={
          <Link
            href="/compose"
            className="inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent-ink"
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
              {failedCount > 0 ? (
                <span className="data text-xs font-medium text-status-failed">
                  {failedCount} failed · needs attention
                </span>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {channels.map((c) => {
                const color = channelColor(c.id);
                const count = scheduledByChannel.get(c.id) ?? 0;
                const next = nextByChannel.get(c.id);
                return (
                  <div
                    key={c.id}
                    className="rounded-card border border-border bg-surface p-4"
                    style={{ borderLeft: `3px solid ${color.dot}` }}
                  >
                    <div className="flex items-center justify-between">
                      <ChannelChip id={c.id} platform={c.platform} name={c.account_name} />
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
          <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wide text-muted">
            Publications
          </h2>
          {pubs.length === 0 ? (
            <EmptyState title="Nothing here yet">
              Composed posts and their scheduled sends show up here — failures float to the
              top so they&rsquo;re never silent.
            </EmptyState>
          ) : (
            <div className="overflow-hidden rounded-card border border-border bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-faint">
                    <th className="px-4 py-2.5 font-medium">Post</th>
                    <th className="px-4 py-2.5 font-medium">Channel</th>
                    <th className="px-4 py-2.5 font-medium">When</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pubs.map((p) => (
                    <tr key={p.id} className="border-b border-border last:border-0 align-top">
                      <td className="px-4 py-3">
                        <div className="flex items-start gap-3">
                          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-surface-sunken">
                            {p.first_asset_id ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={`/api/media/${p.first_asset_id}?variant=thumb`}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : null}
                          </div>
                          <div className="min-w-0">
                            <p className="line-clamp-2 max-w-xs text-ink">
                              {p.post_caption || (
                                <span className="text-faint italic">No caption</span>
                              )}
                            </p>
                            <p className="data mt-0.5 text-[11px] text-faint">
                              {p.post_type}
                              {p.asset_count > 1 ? ` · ${p.asset_count} imgs` : ""}
                              {p.remote_post_id && p.remote_post_id !== "DRYRUN"
                                ? ` · ${p.remote_post_id}`
                                : ""}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <ChannelChip
                          id={p.channel_id}
                          platform={p.channel_platform}
                          name={p.channel_name}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span className="data text-xs text-ink-soft">
                          {formatInTz(p.scheduled_at, p.channel_timezone)}
                        </span>
                        <span className="data block text-[10px] text-faint">
                          {tzAbbrev(p.channel_timezone)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={p.status} dryRun={p.is_dry_run === 1} />
                        {p.last_error ? (
                          <p className="mt-1 max-w-xs text-[11px] text-status-failed line-clamp-2">
                            {p.last_error}
                          </p>
                        ) : null}
                        {p.attempt_count > 0 && p.status !== "failed" ? (
                          <p className="data mt-0.5 text-[10px] text-faint">
                            attempt {p.attempt_count}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <PublicationActions id={p.id} status={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
