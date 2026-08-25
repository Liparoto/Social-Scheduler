import Link from "next/link";
import { getActiveChannels, listPeriods, listTags, listPosts } from "@/lib/queries";
import { config } from "@/lib/config";
import { getPublishReadiness } from "@/lib/publish-readiness";
import { PageHeader, EmptyState } from "@/components/ui";
import { ComposeSwitcher } from "@/components/compose-switcher";

export const dynamic = "force-dynamic";

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const channels = getActiveChannels().map((c) => ({
    id: c.id,
    platform: c.platform,
    account_name: c.account_name,
    timezone: c.timezone,
    requires_approval: c.requires_approval === 1,
    color_hue: c.color_hue,
    avatar_path: c.avatar_path,
  }));
  const timeOfDayTags = listTags("time_of_day");
  const topicTags = listTags("topic");
  const libraryPosts = listPosts().map((p) => ({
    id: p.id,
    first_asset_id: p.first_asset_id,
    caption: p.caption,
    content_kind: p.content_kind,
    content_status: p.content_status,
    post_type: p.post_type,
    // Drives the picker's '4 slides → 4 Stories' note before scheduling.
    asset_count: p.asset_count,
    // First asset's dimensions/duration, so ChannelSurfacePicker can grey out an
    // out-of-spec Facebook Reel target the same way the composer already does.
    first_asset_width: p.first_asset_width,
    first_asset_height: p.first_asset_height,
    first_asset_duration_ms: p.first_asset_duration_ms,
    // So ChannelSurfacePicker can tell an out-of-spec original from one that's already
    // been conformed for the feed — see lib/media-limits.ts's destinationDisabledReason.
    first_asset_byte_size: p.first_asset_byte_size,
    first_asset_publish_path: p.first_asset_publish_path,
    first_asset_conform_mode: p.first_asset_conform_mode,
  }));
  // "Tomorrow" in the INSTALL's timezone, not UTC. toISOString() is UTC, so from ~5pm
  // Pacific onwards this returned the day AFTER tomorrow and the composer opened on the
  // wrong default date every evening. en-CA formats as YYYY-MM-DD, which is what a
  // <input type="date"> expects.
  //
  // The purity rule below is suppressed deliberately: a scheduling default is genuinely
  // "now"-dependent, and this page is per-request and uncached, so reading the clock
  // during render is the intended behaviour rather than an accident.
  // eslint-disable-next-line react-hooks/purity
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", {
    timeZone: config.defaultTimezone,
  });
  // The calendar's empty-day "+" links here with the day it was clicked, so spotting a gap
  // and filling it is one click. Validated rather than trusted: this is a query string the
  // owner can edit, and a malformed value would reach a date input and render an empty,
  // un-obviously-broken field.
  const fromCalendar = /^\d{4}-\d{2}-\d{2}$/.test(params.date ?? "")
    ? (params.date as string)
    : null;
  const defaultDate = fromCalendar ?? tomorrow;
  const defaultTime = "09:00";
  // Only prefilled when a date was actually asked for. A plain visit to Compose still
  // opens with an empty datetime, because "Pick a date and time" is a deliberate prompt —
  // silently defaulting it is how a post goes out on a day nobody chose.
  const defaultScheduledLocal = fromCalendar ? `${fromCalendar}T${defaultTime}` : "";

  return (
    <div>
      <PageHeader
        title="Compose"
        subtitle="Assemble a post, set its order, and choose exactly where it goes."
      />
      <div className="px-8 py-6">
        {channels.length === 0 ? (
          <EmptyState title="Add a channel first">
            You need at least one active account before composing. Head to{" "}
            <Link href="/channels" className="text-brand underline underline-offset-2">
              Channels
            </Link>
            .
          </EmptyState>
        ) : (
          <ComposeSwitcher
            channels={channels}
            defaultTimezone={config.defaultTimezone}
            periods={listPeriods()}
            timeOfDayTags={timeOfDayTags}
            topicTags={topicTags}
            libraryPosts={libraryPosts}
            defaultDate={defaultDate}
            defaultTime={defaultTime}
            defaultScheduledLocal={defaultScheduledLocal}
            readiness={getPublishReadiness()}
          />
        )}
      </div>
    </div>
  );
}
