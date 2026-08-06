"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Mark a post as one of the owner's keepers, from wherever they happen to be looking.
 *
 * Deliberately a plain toggle with no confirmation: marking is cheap, reversible, and
 * done in bulk during a review pass. A dialog on every click would make the pass tedious
 * enough to skip, and skipping it is the failure mode that matters — an empty pool means
 * the whole feature does nothing.
 *
 * Disabled when the post has no library entry: the leaderboard lists everything on the
 * account, but only posts this tool can actually republish (assets + caption) can be
 * marked. Saying why beats a button that silently fails.
 */
export function BppMark({
  postId,
  initial,
  compact = false,
}: {
  postId: number | null;
  initial: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [marked, setMarked] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  if (postId === null) {
    return (
      <span
        className="text-[10px] text-faint"
        title="Only posts in your library can be reposted — this one was published outside SocialScheduler, so there is no caption or image to send again."
      >
        not in library
      </span>
    );
  }

  async function toggle() {
    const next = !marked;
    setBusy(true);
    setMarked(next); // optimistic: the review pass should feel immediate
    const response = await fetch(`/api/posts/${postId}/bpp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_bpp: next }),
    });
    setBusy(false);
    if (!response.ok) {
      setMarked(!next); // put it back rather than show a lie
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={marked}
      title={marked ? "Remove from your BPP pool" : "Add to your BPP pool for reposting"}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
        marked
          ? "border-brand bg-brand-weak text-brand-strong"
          : "border-border text-muted hover:border-border-strong hover:text-ink-soft"
      }`}
    >
      <span aria-hidden>{marked ? "★" : "☆"}</span>
      {compact ? null : marked ? "BPP" : "Mark BPP"}
    </button>
  );
}
