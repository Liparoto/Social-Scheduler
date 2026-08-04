import Link from "next/link";
import { getActiveChannels, listPeriods, listPosts, listTags } from "@/lib/queries";
import { PageHeader, EmptyState } from "@/components/ui";
import { LibraryView } from "@/components/library-view";
import { config } from "@/lib/config";
import { localDate } from "@/lib/periods";

export const dynamic = "force-dynamic";

export default function LibraryPage() {
  const evaluationDate = localDate(new Date(), config.defaultTimezone);
  const posts = listPosts().map((p) => ({
    id: p.id,
    caption: p.caption,
    post_type: p.post_type,
    status: p.status,
    first_asset_id: p.first_asset_id,
    first_asset_media_kind: p.first_asset_media_kind,
    first_asset_cover_frame_ms: p.first_asset_cover_frame_ms,
    first_asset_width: p.first_asset_width,
    first_asset_height: p.first_asset_height,
    asset_count: p.asset_count,
    // GROUP_CONCAT can only return a string — split it back into slide order here so the
    // merge-into-carousel modal can seed SlideReorder straight from the selection, with no
    // extra per-post fetch. A post with zero assets (a text post) has a null csv.
    asset_ids: p.asset_ids_csv ? p.asset_ids_csv.split(",").map(Number) : [],
    scheduled_count: p.scheduled_count,
    // Distinct from scheduled_count: excludes 'publishing', which can't be reordered or
    // rescheduled at all. Quick edit's reorder notice needs the narrower number — see
    // its use in library-view.tsx / quick-edit-modal.tsx.
    queued_publication_count: p.queued_publication_count,
    posted_count: p.posted_count,
    last_posted_at: p.last_posted_at,
    content_kind: p.content_kind,
    content_status: p.content_status,
    // cooldown_days and tag_ids aren't shown on the card — they're what quick edit opens
    // with, so the dialog needs no fetch of its own. Same trick as asset_ids above.
    cooldown_days: p.cooldown_days,
    tag_ids: p.tag_ids_csv ? p.tag_ids_csv.split(",").map(Number) : [],
    target_count: p.target_count,
    story_target_count: p.story_target_count,
    periods: p.periods,
    time_of_day_tags: p.time_of_day_tags,
    topic_tags: p.topic_tags,
    target_platforms: p.target_platforms,
    // See PostLibraryRow.queued_publication_count — merging deletes every non-surviving
    // post, and its scheduled/pending_approval publications cascade away with it. The merge
    // modal warns about that before the owner confirms; boolean is all it needs.
    has_queued_publication: p.queued_publication_count > 0,
  }));
  const channels = getActiveChannels().map((c) => ({
    id: c.id,
    account_name: c.account_name,
    platform: c.platform,
    timezone: c.timezone,
    requires_approval: c.requires_approval === 1,
    color_hue: c.color_hue,
    avatar_path: c.avatar_path,
  }));

  return (
    <div>
      <PageHeader
        title="Library"
        subtitle="Every post you've made — select several to bulk-schedule at a cadence, or reuse for recycling."
        action={
          <Link href="/import" className="text-sm text-brand underline underline-offset-2">
            Bulk import →
          </Link>
        }
      />
      <div className="px-8 py-6">
        {posts.length === 0 ? (
          <EmptyState title="No posts yet">
            Create one on{" "}
            <Link href="/compose" className="text-brand underline underline-offset-2">
              Compose
            </Link>{" "}
            — use “Save as draft” to build up a library you can bulk-schedule here.
          </EmptyState>
        ) : channels.length === 0 ? (
          <EmptyState title="Add a channel first">
            You need an active channel before scheduling. Head to{" "}
            <Link href="/channels" className="text-brand underline underline-offset-2">
              Channels
            </Link>
            .
          </EmptyState>
        ) : (
          <LibraryView
            posts={posts}
            channels={channels}
            periods={listPeriods()}
            timeOfDayTags={listTags("time_of_day")}
            topicTags={listTags("topic")}
            evaluationDate={evaluationDate}
            evaluationTimezone={config.defaultTimezone}
          />
        )}
      </div>
    </div>
  );
}
