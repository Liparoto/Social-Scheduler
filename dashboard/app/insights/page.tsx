import Link from "next/link";
import { PageHeader, EmptyState, ChannelAvatar } from "@/components/ui";
import { Sparkline } from "@/components/charts";
import { InsightsRefresh } from "@/components/insights-refresh";
import {
  getInsightsChannels,
  getAccountDays,
  getChannelCounts,
} from "@/lib/insights-queries";
import {
  buildKpis, compact, densify, exact, formatDelta, latestMetric, windowRows,
  type MetricKey,
} from "@/lib/insights";
import { channelColor } from "@/lib/format";
import { platformBadge, platformLabel } from "@/lib/platforms";

export const dynamic = "force-dynamic";

/*
  The hub: one card per account, each linking to its own page.

  There is deliberately no combined "all accounts" total. Reach cannot be summed across
  accounts without double-counting the people who follow both, so any such number would
  be wrong in a way nobody could see. Comparison happens by putting the cards side by
  side, which is honest and just as fast to read.
*/

// Platforms with an account-insights endpoint. Discord and Telegram have none at all,
// and Facebook Pages arrive with their own adapter later — stating that on the card is
// better than an empty card that reads as a bug.
const HAS_ACCOUNT_INSIGHTS = new Set(["instagram", "threads"]);

const CARD_METRICS: Record<string, { key: MetricKey; label: string }[]> = {
  instagram: [
    { key: "reach", label: "Reach" },
    { key: "views", label: "Views" },
    { key: "accounts_engaged", label: "Engaged" },
  ],
  threads: [
    { key: "views", label: "Views" },
    { key: "likes", label: "Likes" },
    { key: "replies", label: "Replies" },
  ],
};

function sinceLabel(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function InsightsPage() {
  const channels = getInsightsChannels();
  const supported = channels.filter((c) => HAS_ACCOUNT_INSIGHTS.has(c.platform));
  const unsupported = channels.filter((c) => !HAS_ACCOUNT_INSIGHTS.has(c.platform));

  return (
    <div>
      <PageHeader
        title="Insights"
        subtitle="How each connected account is actually doing — every post, not just the ones scheduled here."
      />

      <div className="px-8 py-6 space-y-8">
        {supported.length === 0 ? (
          <EmptyState title="No accounts with insights yet">
            Connect an Instagram or Threads account on the{" "}
            <Link href="/channels" className="text-brand-strong underline">
              Channels
            </Link>{" "}
            page. Metrics start collecting on the worker&rsquo;s next cycle.
          </EmptyState>
        ) : (
          <section>
            <div className="grid gap-4 lg:grid-cols-2">
              {supported.map((channel) => {
                const color = channelColor(channel.id, channel.color_hue);
                const days = getAccountDays(channel.id);
                const counts = getChannelCounts(channel.id);
                const metrics = CARD_METRICS[channel.platform] ?? CARD_METRICS.instagram;
                const kpis = buildKpis(
                  days,
                  metrics.map((m) => ({ ...m, kind: "flow" as const })),
                  30,
                );
                const followers = latestMetric(days, "followers_count");
                const followerDelta = buildKpis(
                  days,
                  [{ key: "follows_gained", label: "New", kind: "flow" }],
                  30,
                )[0];
                const spark = densify(windowRows(days, 30), 30).map((d) => ({
                  day: d.day,
                  value: d.reach ?? d.views,
                }));

                return (
                  <article
                    key={channel.id}
                    className="rounded-card border border-border bg-surface"
                  >
                    <Link
                      href={`/insights/${channel.id}`}
                      className="block rounded-card px-5 pt-5 pb-4 transition-colors hover:bg-surface-sunken/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ChannelAvatar
                            id={channel.id}
                            name={channel.account_name}
                            colorHue={channel.color_hue}
                            avatarPath={channel.avatar_path}
                            size={28}
                          />
                          <div className="min-w-0">
                            <h2 className="truncate font-display text-[15px] font-semibold text-ink">
                              {channel.account_name}
                            </h2>
                            <p className="text-[11px] uppercase tracking-wide text-faint">
                              {platformBadge(channel.platform)}
                              {channel.business_label ? ` · ${channel.business_label}` : ""}
                            </p>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="data text-2xl font-semibold leading-none text-ink">
                            {compact(followers)}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-wide text-faint">
                            followers
                          </div>
                        </div>
                      </div>

                      <div className="mt-4">
                        <Sparkline
                          points={spark}
                          color={color.fg}
                          label={`30-day trend for ${channel.account_name}`}
                        />
                      </div>

                      {/* Instrument row: hairline-divided cells, mono figures. */}
                      <dl className="mt-3 grid grid-cols-3 divide-x divide-border border-t border-border pt-3">
                        {kpis.map((kpi, index) => {
                          const delta = formatDelta(kpi.delta);
                          // Same honesty rule as the detail page: a metric the platform
                          // only reports for a day or two must not sit under a "30 days"
                          // heading as though it covered the month.
                          const partial =
                            kpi.value !== null && kpi.daysWithData < kpi.windowDays;
                          return (
                            <div
                              key={kpi.key}
                              className={index === 0 ? "pr-3" : "px-3 last:pr-0"}
                            >
                              <dt className="text-[10px] uppercase tracking-wide text-faint">
                                {kpi.label}
                              </dt>
                              <dd className="data mt-0.5 text-base font-medium text-ink">
                                {compact(kpi.value)}
                                {partial ? (
                                  <span
                                    className="ml-1.5 text-[10px] font-medium text-status-publishing"
                                    title={`Only ${kpi.daysWithData} of the last ${kpi.windowDays} days are recorded for this metric`}
                                  >
                                    {kpi.daysWithData}d
                                  </span>
                                ) : delta ? (
                                  <span
                                    className={`ml-1.5 text-[10px] font-medium ${
                                      kpi.delta! > 0
                                        ? "text-status-posted"
                                        : "text-status-failed"
                                    }`}
                                  >
                                    {delta}
                                  </span>
                                ) : null}
                              </dd>
                            </div>
                          );
                        })}
                      </dl>
                    </Link>

                    <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-2.5 text-[11px] text-muted">
                      <span>
                        <span className="data">{exact(counts.posts)}</span> posts tracked ·{" "}
                        <span className="data">{exact(counts.ours)}</span> scheduled here
                        {followerDelta.value === null ? (
                          ""
                        ) : (
                          <>
                            {" · "}
                            <span className="data">+{followerDelta.value}</span> new
                            followers in 30d
                          </>
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        <span>synced {sinceLabel(channel.insights_synced_at)}</span>
                        <InsightsRefresh
                          channelId={channel.id}
                          pending={Boolean(channel.insights_refresh_requested)}
                        />
                      </span>
                    </footer>

                    {channel.insights_error ? (
                      <p className="border-t border-border px-5 py-2 text-[11px] text-status-failed">
                        Last sync failed: {channel.insights_error}
                      </p>
                    ) : null}
                    {!channel.media_backfill_complete ? (
                      <p className="border-t border-border px-5 py-2 text-[11px] text-muted">
                        Still backfilling history — numbers below will keep filling in.
                      </p>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {unsupported.length > 0 ? (
          <section>
            <h2 className="mb-2 font-display text-sm font-semibold uppercase tracking-wide text-muted">
              No insights available
            </h2>
            <div className="rounded-card border border-border bg-surface px-5 py-4">
              <ul className="space-y-1.5 text-sm text-ink-soft">
                {unsupported.map((channel) => (
                  <li key={channel.id} className="flex items-center gap-2">
                    <ChannelAvatar
                      id={channel.id}
                      name={channel.account_name}
                      colorHue={channel.color_hue}
                      avatarPath={channel.avatar_path}
                      size={16}
                    />
                    <span className="font-medium">{channel.account_name}</span>
                    <span className="text-muted">
                      — {platformLabel(channel.platform)}{" "}
                      {channel.platform === "facebook"
                        ? "insights are not wired up yet"
                        : "has no insights endpoint at all"}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
                Discord and Telegram publish through a webhook and a bot API. Neither
                platform exposes analytics, so there is nothing to read — this is a
                limitation of those services, not a missing feature here.
              </p>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
