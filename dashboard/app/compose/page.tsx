import Link from "next/link";
import { getActiveChannels, listPeriods, listTags, listPosts } from "@/lib/queries";
import { config } from "@/lib/config";
import { getPublishReadiness } from "@/lib/publish-readiness";
import { PageHeader, EmptyState } from "@/components/ui";
import { ComposeSwitcher } from "@/components/compose-switcher";

export const dynamic = "force-dynamic";

export default function ComposePage() {
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
  const defaultDate = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", {
    timeZone: config.defaultTimezone,
  });
  const defaultTime = "09:00";

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
            readiness={getPublishReadiness()}
          />
        )}
      </div>
    </div>
  );
}
