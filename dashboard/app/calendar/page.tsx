import { getPublicationsInRange, getActiveChannels } from "@/lib/queries";
import { config } from "@/lib/config";
import { PageHeader } from "@/components/ui";
import { CalendarView, type CalendarSend } from "@/components/calendar-view";
import { addDays, monthGrid, todayInTz, weekDays, bucketByDay } from "@/lib/calendar";
import { splitInTz } from "@/lib/time";
import { FINISHED_STATUSES } from "@/lib/queue-sections";
import { PLATFORMS } from "@/lib/platforms";

export const dynamic = "force-dynamic";

/** A day either side, because a channel-local date can resolve outside the UTC window
 *  that produced it — an evening send in New York is already tomorrow in UTC. */
const SLACK_DAYS = 1;

function isValidDate(v: string | undefined): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    anchor?: string;
    account?: string;
    platform?: string;
  }>;
}) {
  const params = await searchParams;
  const view = params.view === "week" ? "week" : "month";
  const account = params.account ?? "all";
  const platform = params.platform ?? "all";
  const today = todayInTz(config.defaultTimezone);
  // A malformed ?anchor= falls back to today rather than rendering an empty grid — the
  // value is user-editable in the address bar and reaches date maths directly.
  const anchor = isValidDate(params.anchor) ? params.anchor : today;

  const days = view === "week" ? weekDays(anchor) : monthGrid(anchor).flat();
  const first = days[0];
  const last = days[days.length - 1];

  // Query in UTC across the widened span; bucketByDay then files each send under its own
  // channel's local date and anything landing outside the grid simply finds no cell.
  const all = getPublicationsInRange(
    `${addDays(first, -SLACK_DAYS)}T00:00:00Z`,
    `${addDays(last, SLACK_DAYS + 1)}T00:00:00Z`
  );

  // Filtered here rather than hidden in the grid, so the header's count describes what is
  // actually on screen. An unrecognised value filters nothing, which is the same thing the
  // absent parameter means — a hand-edited URL should not silently empty the calendar.
  const rows = all.filter(
    (r) =>
      (account === "all" || String(r.channel_id) === account) &&
      (platform === "all" || r.channel_platform === platform)
  );

  const buckets = bucketByDay(rows);
  const sendsByDay: Record<string, CalendarSend[]> = {};
  for (const day of days) {
    const inDay = buckets.get(day);
    if (!inDay?.length) continue;
    sendsByDay[day] = inDay.map((r) => ({
      id: r.id,
      postId: r.post_id,
      status: r.status,
      isDryRun: r.is_dry_run === 1,
      surface: r.surface,
      // Channel-local clock, matching every other screen. Its own zone, not the grid's.
      time: splitInTz(
        r.status === "posted" && r.published_at ? r.published_at : r.scheduled_at,
        r.channel_timezone
      ).time,
      caption: r.post_caption,
      channelName: r.channel_name,
      channelId: r.channel_id,
      channelColorHue: r.channel_color_hue,
      assetId: r.first_asset_id,
      assetMediaKind: r.first_asset_media_kind,
      assetCoverFrameMs: r.first_asset_cover_frame_ms,
      // Only a send the reschedule API will actually accept is draggable, so the cursor
      // tells the truth before the drop rather than after it.
      canMove: !FINISHED_STATUSES.includes(r.status as "posted" | "canceled")
        && r.status !== "publishing"
        && r.status !== "failed",
    }));
  }

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="The shape of the schedule — what is coming, and what already went out."
      />
      <div className="px-8 py-6">
        <CalendarView
          view={view}
          anchor={anchor}
          today={today}
          days={days}
          sendsByDay={sendsByDay}
          gridTimezone={config.defaultTimezone}
          channels={getActiveChannels().map((c) => ({
            id: c.id,
            account_name: c.account_name,
            platform: c.platform,
          }))}
          platforms={PLATFORMS.map((p) => ({ value: p.value, label: p.label }))}
          account={account}
          platform={platform}
        />
      </div>
    </div>
  );
}
