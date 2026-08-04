import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPost,
  getPostAssets,
  getPostTargets,
  getPostTags,
  getPostPeriods,
  getCaptionVariants,
  getChannels,
  getActiveChannels,
  getPostPublications,
  listPeriods,
  listTags,
} from "@/lib/queries";
import { getPublishReadiness } from "@/lib/publish-readiness";
import { PostEditor } from "@/components/post-editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EditPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const postId = Number(id);
  const post = getPost(postId);
  if (!post) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/library" className="inline-block text-sm text-brand underline underline-offset-2">
        ← Back to Library
      </Link>
      <PostEditor
        post={post}
        assets={getPostAssets(postId)}
        channels={getChannels()}
        sends={getPostPublications(postId)}
        sendableChannels={getActiveChannels()}
        periods={listPeriods()}
        timeOfDayTags={listTags("time_of_day")}
        topicTags={listTags("topic")}
        // The editor's picker still speaks in channel ids; Phase 4 replaces it with
        // the surface picker. Story targets are preserved on save by the content
        // route, not by this list, so narrowing to feed here cannot lose them.
        initialTargets={getPostTargets(postId)
          .filter((t) => t.surface === "feed")
          .map((t) => t.channel_id)}
        initialTagIds={getPostTags(postId).map((t) => t.id)}
        initialPeriods={Object.fromEntries(
          getPostPeriods(postId).map((l) => [l.period_id, l.mode])
        )}
        initialCaptions={getCaptionVariants(postId).map((c) => ({
          platform: c.platform ?? "",
          body: c.body,
        }))}
        readiness={getPublishReadiness()}
      />
    </div>
  );
}
