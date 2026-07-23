import Link from "next/link";
import { listPosts, getActiveChannels } from "@/lib/queries";
import { PageHeader, EmptyState } from "@/components/ui";
import { LibraryView } from "@/components/library-view";

export const dynamic = "force-dynamic";

export default function LibraryPage() {
  const posts = listPosts().map((p) => ({
    id: p.id,
    caption: p.caption,
    post_type: p.post_type,
    status: p.status,
    first_asset_id: p.first_asset_id,
    asset_count: p.asset_count,
    scheduled_count: p.scheduled_count,
    posted_count: p.posted_count,
    last_posted_at: p.last_posted_at,
  }));
  const channels = getActiveChannels().map((c) => ({
    id: c.id,
    account_name: c.account_name,
    platform: c.platform,
    timezone: c.timezone,
    requires_approval: c.requires_approval === 1,
  }));

  return (
    <div>
      <PageHeader
        title="Library"
        subtitle="Every post you've made — select several to bulk-schedule at a cadence, or reuse for recycling."
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
          <LibraryView posts={posts} channels={channels} />
        )}
      </div>
    </div>
  );
}
