import Link from "next/link";
import { notFound } from "next/navigation";
import { ChannelAvatar } from "@/components/ui";
import { HBarList, HeatGrid, TrendChart, YearRibbon } from "@/components/charts";
import { InsightsRefresh } from "@/components/insights-refresh";
import {
  getAccountDays, getChannelCounts, getChannelPosts, getDemographics,
  getInsightsChannel, pickDemographics,
} from "@/lib/insights-queries";
import {
  GENDER_LABELS, POST_SORTS, RANGES, bestTimeGrid, buildKpis, compact, densify,
  engagementOf, exact, formatDelta, latestMetric, postKindLabel, postKinds, rangeDays,
  sortAgeBuckets, sortPosts, topBuckets, windowRows,
  type MetricKey, type PostSortKey,
} from "@/lib/insights";
import { channelColor, tzAbbrev } from "@/lib/format";
import { platformLabel } from "@/lib/platforms";

export const dynamic = "force-dynamic";

/*
  One account, in depth.

  Every control here is a link that sets a search param, so the whole page stays a server
  component: no client bundle, and any view is a URL somebody can bookmark or send. The
  interactions are cheap enough server-side that shipping React state for them would cost
  more than it bought.
*/

const METRICS: Record<string, { key: MetricKey; label: string; kind: "flow" | "level" }[]> = {
  instagram: [
    { key: "reach", label: "Reach", kind: "flow" },
    { key: "views", label: "Views", kind: "flow" },
    { key: "profile_views", label: "Profile views", kind: "flow" },
    { key: "accounts_engaged", label: "Accounts engaged", kind: "flow" },
    { key: "total_interactions", label: "Interactions", kind: "flow" },
    { key: "follows_gained", label: "New followers", kind: "flow" },
  ],
  threads: [
    { key: "views", label: "Views", kind: "flow" },
    { key: "likes", label: "Likes", kind: "flow" },
    { key: "replies", label: "Replies", kind: "flow" },
    { key: "shares", label: "Reposts", kind: "flow" },
    { key: "followers_count", label: "Followers", kind: "level" },
  ],
};

// What each platform genuinely cannot report, stated on the page so a blank reads as a
// platform limit rather than a broken sync.
const GAPS: Record<string, string> = {
  threads:
    "Threads reports no reach and no saves, and its account history starts the day this install first synced — there is no backfill endpoint.",
  instagram: "",
};

// Per-post columns each platform actually fills. A column that can only ever be "—"
// reads as a broken sync, so it is dropped rather than shown empty; the GAPS note above
// says why it is missing.
const POST_COLUMNS: Record<
  string,
  { key: "reach" | "likes" | "comments" | "saves" | "shares"; label: string }[]
> = {
  instagram: [
    { key: "reach", label: "Reach" },
    { key: "likes", label: "Likes" },
    { key: "comments", label: "Comments" },
    { key: "saves", label: "Saves" },
  ],
  threads: [
    { key: "likes", label: "Likes" },
    { key: "comments", label: "Replies" },
    { key: "shares", label: "Reposts" },
  ],
};

function Pill({
  href, active, children,
}: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-brand-weak text-brand-strong"
          : "text-muted hover:bg-surface-sunken hover:text-ink-soft"
      }`}
      aria-current={active ? "true" : undefined}
    >
      {children}
    </Link>
  );
}

function Section({
  title, hint, action, children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
        <div>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted">
            {title}
          </h2>
          {hint ? <p className="mt-0.5 text-[11px] text-faint">{hint}</p> : null}
        </div>
        {action}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export default async function ChannelInsightsPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const channelId = Number(id);
  const channel = Number.isInteger(channelId) ? getInsightsChannel(channelId) : null;
  if (!channel) notFound();

  const rangeKey = typeof query.range === "string" ? query.range : "30d";
  const days = rangeDays(rangeKey);
  const metricList = METRICS[channel.platform] ?? METRICS.instagram;
  const metricKey = (typeof query.metric === "string" ? query.metric : metricList[0].key) as MetricKey;
  const activeMetric = metricList.find((m) => m.key === metricKey) ?? metricList[0];
  const columns = POST_COLUMNS[channel.platform] ?? POST_COLUMNS.instagram;
  // Sorting defaults to the platform's own headline column, so Threads does not open on
  // "Reach" — a column it never fills, which would leave the default order arbitrary.
  const sorts = POST_SORTS.filter(
    (s) =>
      s.key === "engagement" ||
      s.key === "published_at" ||
      columns.some((c) => c.key === s.key),
    // A control and the column it sorts must share one name. Threads calls comments
    // "replies" and shares "reposts"; offering "Sort by Shares" above a column headed
    // "Reposts" makes the reader work out that they are the same thing.
  ).map((s) => ({
    ...s,
    label: columns.find((c) => c.key === s.key)?.label ?? s.label,
  }));
  const sortKey = (typeof query.sort === "string" ? query.sort : sorts[0].key) as PostSortKey;
  const kindFilter = typeof query.kind === "string" ? query.kind : "all";

  const color = channelColor(channel.id, channel.color_hue);
  const allDays = getAccountDays(channel.id);
  const counts = getChannelCounts(channel.id);
  const posts = getChannelPosts(channel.id);
  const demographics = getDemographics(channel.id);

  const kpis = buildKpis(allDays, metricList, days);
  const activeKpi = kpis.find((k) => k.key === activeMetric.key);

  const followers = latestMetric(allDays, "followers_count");
  const windowed = densify(windowRows(allDays, days), days);
  const seriesPoints = windowed.map((d) => ({ day: d.day, value: d[activeMetric.key] }));
  // Threads reports no reach at all, so the ribbon falls back to views there — and says
  // so in its own title rather than labelling views as reach.
  const ribbonMetric = channel.platform === "threads" ? "views" : "reach";
  const ribbon = densify(windowRows(allDays, 365), 365).map((d) => ({
    day: d.day,
    value: ribbonMetric === "views" ? d.views : d.reach,
  }));

  const kinds = postKinds(posts);
  const filtered = kindFilter === "all"
    ? posts
    : posts.filter((p) => postKindLabel(p) === kindFilter);
  const ranked = sortPosts(filtered, sortKey).slice(0, 25);

  const withParam = (key: string, value: string) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ range: rangeKey, metric: metricKey, sort: sortKey, kind: kindFilter })) {
      if (v) next.set(k, String(v));
    }
    next.set(key, value);
    return `/insights/${channel.id}?${next.toString()}`;
  };

  const age = sortAgeBuckets(pickDemographics(demographics, "followers", "age"));
  const gender = pickDemographics(demographics, "followers", "gender");
  const countries = topBuckets(pickDemographics(demographics, "followers", "country"), 6);
  const cities = topBuckets(pickDemographics(demographics, "followers", "city"), 6);
  const reachedAge = sortAgeBuckets(pickDemographics(demographics, "reached", "age"));
  const genderTotal = gender.reduce((sum, g) => sum + g.value, 0);
  const gap = GAPS[channel.platform];

  return (
    <div>
      <header className="border-b border-border px-8 py-6">
        <Link href="/insights" className="text-xs text-muted hover:text-ink-soft">
          ← All accounts
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <ChannelAvatar
              id={channel.id}
              name={channel.account_name}
              colorHue={channel.color_hue}
              avatarPath={channel.avatar_path}
              size={40}
            />
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
                {channel.account_name}
              </h1>
              <p className="mt-0.5 text-sm text-muted">
                {platformLabel(channel.platform)} ·{" "}
                <span className="data">{exact(followers)}</span> followers ·{" "}
                <span className="data">{exact(counts.posts)}</span> posts tracked
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <nav className="flex items-center gap-0.5 rounded-lg bg-surface-sunken p-0.5">
              {RANGES.map((r) => (
                <Pill key={r.key} href={withParam("range", r.key)} active={r.key === rangeKey}>
                  {r.label}
                </Pill>
              ))}
            </nav>
            <InsightsRefresh
              channelId={channel.id}
              pending={Boolean(channel.insights_refresh_requested)}
            />
          </div>
        </div>
        {channel.insights_error ? (
          <p className="mt-3 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-status-failed">
            Last sync failed: {channel.insights_error}
          </p>
        ) : null}
      </header>

      <div className="space-y-6 px-8 py-6">
        {/* Instrument row */}
        <section className="rounded-card border border-border bg-surface">
          <dl className="grid divide-y divide-border sm:grid-cols-3 sm:divide-y-0 sm:divide-x lg:grid-cols-6">
            {kpis.map((kpi) => {
              const delta = formatDelta(kpi.delta);
              const partial =
                kpi.kind === "flow" &&
                kpi.value !== null &&
                kpi.daysWithData < kpi.windowDays;
              return (
                <div key={kpi.key} className="px-5 py-4">
                  <dt className="text-[10px] uppercase tracking-wide text-faint">
                    {kpi.label}
                  </dt>
                  <dd className="data mt-1 text-xl font-semibold leading-none text-ink">
                    {exact(kpi.value)}
                  </dd>
                  <dd className="mt-1.5 text-[11px]">
                    {partial ? (
                      // Say so rather than letting a 2-day sum sit under a 30-day heading.
                      <span className="text-status-publishing">
                        <span className="data">{kpi.daysWithData}</span> of{" "}
                        <span className="data">{kpi.windowDays}</span> days recorded
                      </span>
                    ) : delta ? (
                      <span
                        className={
                          kpi.delta! > 0 ? "text-status-posted" : "text-status-failed"
                        }
                      >
                        {delta}{" "}
                        <span className="text-faint">vs previous {days}d</span>
                      </span>
                    ) : (
                      <span className="text-faint">no prior period</span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>

        {/* Signature: every day of the last year, one bar each */}
        <Section
          title={`Daily ${ribbonMetric} · past year`}
          hint={`One bar per day. Gaps are days the worker did not record, not days with no ${ribbonMetric}.`}
        >
          <YearRibbon
            points={ribbon}
            color={color.fg}
            label={`Daily ${ribbonMetric} for ${channel.account_name} over the past year`}
          />
        </Section>

        <Section
          title={`${activeMetric.label} · past ${days} days`}
          hint={
            // A metric with two days of data inside a 90-day window draws as a lone
            // spike, which reads as a broken chart rather than a reporting limit. Say
            // which it is.
            activeKpi && activeKpi.daysWithData < activeKpi.windowDays
              ? `${platformLabel(channel.platform)} only reports this metric for the most recent day or two, so the rest of this window has no data to draw.`
              : undefined
          }
          action={
            <nav className="flex flex-wrap items-center gap-0.5">
              {metricList.map((m) => (
                <Pill key={m.key} href={withParam("metric", m.key)} active={m.key === metricKey}>
                  {m.label}
                </Pill>
              ))}
            </nav>
          }
        >
          <TrendChart
            points={seriesPoints}
            color={color.fg}
            label={`${activeMetric.label} over the past ${days} days`}
          />
        </Section>

        {/* Leaderboard */}
        <Section
          title="Top content"
          hint={`${counts.withMetrics} of ${counts.posts} posts have metrics · ${counts.ours} were scheduled here`}
          action={
            <div className="flex flex-wrap items-center gap-3">
              <nav className="flex flex-wrap items-center gap-0.5">
                {sorts.map((s) => (
                  <Pill key={s.key} href={withParam("sort", s.key)} active={s.key === sortKey}>
                    {s.label}
                  </Pill>
                ))}
              </nav>
              {kinds.length > 1 ? (
                <nav className="flex flex-wrap items-center gap-0.5 border-l border-border pl-3">
                  <Pill href={withParam("kind", "all")} active={kindFilter === "all"}>
                    All
                  </Pill>
                  {kinds.map((k) => (
                    <Pill key={k} href={withParam("kind", k)} active={k === kindFilter}>
                      {k}
                    </Pill>
                  ))}
                </nav>
              ) : null}
            </div>
          }
        >
          {ranked.length === 0 ? (
            <p className="text-sm text-muted">
              No posts synced yet. The worker mirrors the account&rsquo;s posts on its next
              cycle.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-faint">
                    <th className="pb-2 font-medium">Post</th>
                    {columns.map((c) => (
                      <th key={c.key} className="pb-2 text-right font-medium">
                        {c.label}
                      </th>
                    ))}
                    <th className="pb-2 text-right font-medium">Engagement</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ranked.map((post) => (
                    <tr key={post.id} className="align-middle">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-3">
                          {/* Meta's CDN thumbnail URLs expire, and Threads returns none
                              at all. The fallback is a plain tinted square rather than
                              truncated text — the kind is already named by the badge
                              beside it, so "IMAG" would just be noise. */}
                          <span
                            className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-surface-sunken"
                            aria-hidden
                          >
                            {post.thumbnail_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={post.thumbnail_url}
                                alt=""
                                className="h-full w-full object-cover"
                                loading="lazy"
                              />
                            ) : null}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-muted">
                                {postKindLabel(post)}
                              </span>
                              {post.publication_id ? (
                                <span className="rounded bg-brand-weak px-1.5 py-0.5 text-[10px] font-medium text-brand-strong">
                                  scheduled here
                                </span>
                              ) : null}
                              <span className="data text-[11px] text-faint">
                                {post.published_at ? post.published_at.slice(0, 10) : "—"}
                              </span>
                            </div>
                            <p className="mt-0.5 max-w-md truncate text-[13px] text-ink-soft">
                              {post.permalink ? (
                                <a
                                  href={post.permalink}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="hover:underline"
                                >
                                  {post.caption?.trim().split("\n")[0] || "No caption"}
                                </a>
                              ) : (
                                post.caption?.trim().split("\n")[0] || "No caption"
                              )}
                            </p>
                          </div>
                        </div>
                      </td>
                      {columns.map((c, i) => (
                        <td
                          key={c.key}
                          className={`data py-2.5 text-right ${
                            i === 0 ? "text-ink" : "text-ink-soft"
                          }`}
                        >
                          {exact(post[c.key])}
                        </td>
                      ))}
                      <td className="data py-2.5 text-right font-medium text-ink">
                        {exact(engagementOf(post))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Audience */}
        <div className="grid gap-6 lg:grid-cols-2">
          <Section
            title="Audience"
            hint={
              age.length || gender.length
                ? "Who follows this account, as the platform reports it"
                : undefined
            }
          >
            {age.length === 0 && gender.length === 0 ? (
              <p className="text-sm text-muted">
                No demographics yet. Platforms withhold these entirely until an account
                passes about 100 followers, and they refresh once a day.
              </p>
            ) : (
              <div className="space-y-5">
                {gender.length > 0 ? (
                  <div>
                    <h3 className="mb-2 text-[11px] uppercase tracking-wide text-faint">
                      Gender
                    </h3>
                    <div className="flex h-2 overflow-hidden rounded-full bg-surface-sunken">
                      {gender.map((g, i) => (
                        <div
                          key={g.dimension}
                          style={{
                            width: `${genderTotal ? (g.value / genderTotal) * 100 : 0}%`,
                            backgroundColor: color.fg,
                            opacity: 1 - i * 0.3,
                          }}
                          title={`${GENDER_LABELS[g.dimension] ?? g.dimension}: ${g.value.toLocaleString()}`}
                        />
                      ))}
                    </div>
                    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                      {gender.map((g, i) => (
                        <li key={g.dimension} className="flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: color.fg, opacity: 1 - i * 0.3 }}
                            aria-hidden
                          />
                          {GENDER_LABELS[g.dimension] ?? g.dimension}
                          <span className="data text-ink-soft">
                            {genderTotal ? Math.round((g.value / genderTotal) * 100) : 0}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {age.length > 0 ? (
                  <div>
                    <h3 className="mb-2 text-[11px] uppercase tracking-wide text-faint">
                      Age
                    </h3>
                    <HBarList
                      rows={topBuckets(age, 10).buckets.sort(
                        (a, b) => parseInt(a.dimension, 10) - parseInt(b.dimension, 10),
                      )}
                      color={color.fg}
                      formatValue={(v) => compact(v) ?? ""}
                    />
                  </div>
                ) : null}

                {reachedAge.length > 0 ? (
                  <p className="border-t border-border pt-3 text-[11px] text-muted">
                    The people this account <em>reached</em> skew differently from its
                    followers — compare with the reached-audience split the worker also
                    stores.
                  </p>
                ) : null}
              </div>
            )}
          </Section>

          <Section title="Where they are">
            {countries.buckets.length === 0 ? (
              <p className="text-sm text-muted">No location data yet.</p>
            ) : (
              <div className="space-y-5">
                <div>
                  <h3 className="mb-2 text-[11px] uppercase tracking-wide text-faint">
                    Countries
                  </h3>
                  <HBarList
                    rows={countries.buckets}
                    color={color.fg}
                    formatValue={(v) => compact(v) ?? ""}
                  />
                  {countries.remainder > 0 ? (
                    <p className="mt-2 text-[11px] text-faint">
                      <span className="data">{compact(countries.remainder)}</span> more
                      across other countries
                    </p>
                  ) : null}
                </div>
                <div>
                  <h3 className="mb-2 text-[11px] uppercase tracking-wide text-faint">
                    Cities
                  </h3>
                  <HBarList
                    rows={cities.buckets}
                    color={color.fg}
                    formatValue={(v) => compact(v) ?? ""}
                  />
                </div>
              </div>
            )}
          </Section>
        </div>

        <Section
          title="When this account does best"
          hint="Average engagement by slot, computed from this account's own posts — not a platform recommendation"
        >
          <HeatGrid
            cells={bestTimeGrid(posts, channel.timezone)}
            color={color.fg}
            timeZoneLabel={tzAbbrev(channel.timezone)}
          />
        </Section>

        {gap ? (
          <p className="rounded-card border border-dashed border-border px-5 py-3 text-xs text-muted">
            <span className="font-medium text-ink-soft">What {platformLabel(channel.platform)} does not report:</span>{" "}
            {gap}
          </p>
        ) : null}
      </div>
    </div>
  );
}
