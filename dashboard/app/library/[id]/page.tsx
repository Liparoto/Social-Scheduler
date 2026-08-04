import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPost,
  getPostAssets,
  countScheduledSendsForAsset,
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

  // Read once: PostEditor needs the list, and the framing dialog needs a per-asset count of
  // the sends its framing would change.
  const assets = getPostAssets(postId);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/library" className="inline-block text-sm text-brand underline underline-offset-2">
        ← Back to Library
      </Link>
      <PostEditor
        post={post}
        assets={assets}
        scheduledSendCounts={Object.fromEntries(
          assets.map((a) => [a.id, countScheduledSendsForAsset(a.id)])
        )}
        channels={getChannels()}
        sends={getPostPublications(postId)}
        sendableChannels={getActiveChannels()}
        periods={listPeriods()}
        timeOfDayTags={listTags("time_of_day")}
        topicTags={listTags("topic")}
        initialTargets={getPostTargets(postId)}
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
