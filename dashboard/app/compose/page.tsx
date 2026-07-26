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
  }));
  const defaultDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // tomorrow (UTC)
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
