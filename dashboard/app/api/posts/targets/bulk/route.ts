import { NextRequest, NextResponse } from "next/server";
import {
  bulkAddTargets,
  bulkRemoveTargets,
  getCaptionVariants,
  getChannel,
  getPost,
} from "@/lib/queries";
import { captionLimitError } from "@/lib/caption-limits";

export const runtime = "nodejs";

// How many offending posts to name in the failure message before summarising the rest.
// Enough to act on, short of a wall of text when someone selects the whole library.
const MAX_REPORTED = 3;

/**
 * Bulk re-target: add or remove one or more channels as targets across many posts.
 * This is how a newly added account gets folded into existing content — targeting
 * controls which accounts auto-fill can post a given piece of content to.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const postIds: number[] = Array.isArray(body.post_ids) ? body.post_ids : [];
  const channelIds: number[] = Array.isArray(body.channel_ids) ? body.channel_ids : [];
  const action = body.action;

  if (postIds.length === 0) {
    return NextResponse.json({ error: "Select at least one post." }, { status: 400 });
  }
  if (channelIds.length === 0) {
    return NextResponse.json({ error: "Select at least one channel." }, { status: 400 });
  }
  if (action !== "add" && action !== "remove") {
    return NextResponse.json({ error: "action must be 'add' or 'remove'." }, { status: 400 });
  }
  const channels = channelIds.map((cid) => getChannel(cid));
  const unknownIdx = channels.findIndex((c) => !c);
  if (unknownIdx !== -1) {
    return NextResponse.json({ error: `Unknown channel ${channelIds[unknownIdx]}.` }, { status: 400 });
  }
  const targetChannels = channels.map((c) => c!);

  // This is exactly the "recycle a good post to every channel" workflow the caption
  // limit exists for: an evergreen post fine on Instagram can be fine to LOOK at when
  // Telegram is added here, then autofill queues it and the worker fails it terminally
  // forever, with nothing in the UI having warned. Only "add" can introduce a new,
  // possibly-too-strict platform; "remove" can only relax constraints.
  //
  // Every offender is collected and the rest are applied. This used to `return` on the
  // FIRST post over a limit, before any write, so one long caption in a selection of fifty
  // meant nothing happened at all and the message named only that one post — leaving no way
  // to retarget a mixed selection in one go, and no way to find out which others would fail
  // short of fixing them one at a time. Skipping the offender is the right call rather than
  // applying it anyway: the send it would create dies terminally at the worker.
  const skipped: { post_id: number; reason: string }[] = [];
  let eligible = postIds;

  if (action === "add") {
    eligible = [];
    for (const postId of postIds) {
      const post = getPost(postId);
      // Unknown ids stay silently ignored, as they always were here — but they are no
      // longer counted as updated either. A count has to mean posts that actually changed.
      if (!post) continue;
      const variants = getCaptionVariants(postId).map((v) => ({ platform: v.platform, body: v.body }));
      const captionError = captionLimitError(targetChannels, variants, post.caption, post.post_type);
      if (captionError) {
        skipped.push({ post_id: postId, reason: captionError });
        continue;
      }
      eligible.push(postId);
    }
  }

  if (eligible.length === 0) {
    // Nothing was applied, so this is not a success. Returning 200 with updated:0 would
    // show the caller's green "Added 0 accounts" notice and read as though it had worked.
    const detail = skipped
      .slice(0, MAX_REPORTED)
      .map((s) => `#${s.post_id}: ${s.reason}`)
      .join(" ");
    const more =
      skipped.length > MAX_REPORTED ? ` (+${skipped.length - MAX_REPORTED} more)` : "";
    return NextResponse.json(
      {
        error:
          `No changes made — ${skipped.length} post(s) have a caption too long for a ` +
          `channel you're adding. ${detail}${more}`,
        skipped,
      },
      { status: 400 }
    );
  }

  if (action === "add") {
    bulkAddTargets(eligible, channelIds);
  } else {
    bulkRemoveTargets(eligible, channelIds);
  }

  // A partial success is a success with a caveat, not a failure: the caller reports what
  // changed AND what did not, from these two numbers.
  return NextResponse.json({ updated: eligible.length, skipped }, { status: 200 });
}
