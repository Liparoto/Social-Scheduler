"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { incompatibleChannelsForPostType, platformLabel } from "@/lib/platforms";
import { channelColor, videoPreviewSrc } from "@/lib/format";
import type { PublishReadiness } from "@/lib/publish-readiness";
import { PostNowReadinessNotice } from "@/components/post-now-readiness";
import { ChannelAvatar } from "@/components/ui";
import { ChannelSurfacePicker } from "@/components/channel-surface-picker";
import type { PostTarget } from "@/lib/types";

export type LibraryPickItem = {
  id: number;
  first_asset_id: number | null;
  caption: string | null;
  content_kind: string;
  content_status: string;
  post_type: string;
  // Needed so the picker can say '4 slides → 4 Stories' BEFORE scheduling.
  asset_count: number;
};
export type ChannelLite = {
  id: number;
  platform: string;
  account_name: string;
  timezone: string;
  requires_approval: boolean;
  color_hue: number | null;
  avatar_path: string | null;
};

const card = "rounded-card border border-border bg-surface p-5";
const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-strong" : "text-muted hover:text-ink"
  }`;

export function ScheduleFromLibrary({
  posts,
  channels,
  defaultDate,
  defaultTime,
  readiness,
}: {
  posts: LibraryPickItem[];
  channels: ChannelLite[];
  defaultDate: string;
  defaultTime: string;
  readiness: PublishReadiness;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // Targets, not channel ids: Instagram's Feed and Story are independent sends.
  const [targets, setTargets] = useState<PostTarget[]>([]);
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultTime);
  const [postNow, setPostNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = posts.find((p) => p.id === selectedId) ?? null;
  const shown = posts.filter((p) =>
    query.trim() ? (p.caption ?? "").toLowerCase().includes(query.trim().toLowerCase()) : true
  );
  const incompatibleIds = useMemo(
    () =>
      new Set(
        selected ? incompatibleChannelsForPostType(selected.post_type, channels).map((c) => c.id) : []
      ),
    [selected, channels]
  );
  // Changing which post is selected can make a previously-picked target incompatible
  // (e.g. switching from a Threads text post to an Instagram image post's target
  // selection carrying over) — derive the effective set instead of writing it back into
  // state, so there's nothing to keep in sync.
  const effectiveTargets = useMemo(
    () => targets.filter((t) => !incompatibleIds.has(t.channel_id)),
    [targets, incompatibleIds]
  );
  // Per-ACCOUNT count for the button label: one Instagram account picked for both
  // Feed and Story is two sends but still one account.
  const targetAccountCount = new Set(effectiveTargets.map((t) => t.channel_id)).size;
  async function schedule() {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const res = await fetch(`/api/posts/${selected.id}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: effectiveTargets,
        ...(postNow ? { post_now: true } : { date, time }),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not schedule.");
      return;
    }
    const b = await res.json();
    setNotice(
      postNow
        ? `Posting now to ${b.created} account${b.created === 1 ? "" : "s"}.`
        : `Scheduled to ${b.created} account${b.created === 1 ? "" : "s"}.`
    );
    setTargets([]);
    // Re-fetch server state so the dry-run / kill-switch / worker readiness banner
    // (PostNowReadinessNotice) can't go stale across repeated sends on this page —
    // same class of bug as the cached-.env readiness fix, just via a stale page.
    router.refresh();
  }

  if (!selected) {
    return (
      <div className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Pick a post to schedule</h3>
        <input
          className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand"
          placeholder="Search captions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {shown.length === 0 ? (
          <p className="text-sm text-muted">No posts. Create one in “New post” or the Library.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {shown.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className="flex gap-3 rounded-lg border border-border p-2 text-left hover:bg-surface-sunken"
              >
                {p.first_asset_id ? (
                  p.post_type === "reel" ? (
                    // No thumbnail file exists for video (no ffmpeg dependency by
                    // design) — render the real file with preload="metadata" so the
                    // browser decodes just the first frame, same approach as
                    // post-editor.tsx / cover-frame-picker.tsx. videoPreviewSrc's #t=
                    // fragment is what makes that frame actually paint in Safari; this
                    // list doesn't load cover_frame_ms (would need a new query), so it
                    // always uses the small non-zero fallback offset.
                    <video
                      src={videoPreviewSrc(p.first_asset_id)}
                      preload="metadata"
                      muted
                      playsInline
                      className="h-14 w-14 shrink-0 rounded object-cover"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/media/${p.first_asset_id}?variant=thumb`}
                      alt=""
                      className="h-14 w-14 shrink-0 rounded object-cover"
                    />
                  )
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-surface-sunken text-center text-[10px] text-faint">
                    {p.post_type === "text" ? "Text post" : "no image"}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{p.caption || "(no caption)"}</p>
                  <p className="data mt-1 text-[11px] text-muted">
                    {p.content_kind} · {p.content_status}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className={card}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            {selected.first_asset_id ? (
              selected.post_type === "reel" ? (
                // videoPreviewSrc's #t= fragment forces Safari to paint a frame for a
                // preload="metadata" video (Chrome already does this for free). No
                // cover_frame_ms on this row (would need a new query), so it falls
                // back to a small non-zero offset.
                <video
                  src={videoPreviewSrc(selected.first_asset_id)}
                  preload="metadata"
                  muted
                  playsInline
                  className="h-20 w-20 shrink-0 rounded-lg object-cover"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/media/${selected.first_asset_id}?variant=thumb`}
                  alt=""
                  className="h-20 w-20 shrink-0 rounded-lg object-cover"
                />
              )
            ) : (
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-center text-xs text-faint">
                {selected.post_type === "text" ? "Text post" : "no image"}
              </div>
            )}
            <div>
              <p className="text-sm text-ink">{selected.caption || "(no caption)"}</p>
              <p className="data mt-1 text-[11px] text-muted">
                {selected.content_kind} · {selected.content_status}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="shrink-0 text-xs text-brand underline underline-offset-2"
          >
            Change
          </button>
        </div>
        <p className="mt-3 text-xs text-faint">
          Scheduling reuses this post as-is. To change wording or targets, edit it in the{" "}
          <Link href={`/library/${selected.id}`} className="text-brand underline underline-offset-2">
            Library
          </Link>{" "}
          first.
        </p>
      </div>

      <div className={card}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-display text-sm font-semibold text-ink">Where & when</h3>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            <button
              type="button"
              className={segBtn(!postNow)}
              onClick={() => setPostNow(false)}
            >
              Schedule
            </button>
            <button
              type="button"
              className={segBtn(postNow)}
              onClick={() => setPostNow(true)}
            >
              Post now
            </button>
          </div>
        </div>
        <div className="mb-3">
          <ChannelSurfacePicker
            channels={channels}
            value={effectiveTargets}
            onChange={setTargets}
            hasVideo={selected?.post_type === "reel"}
            textOnly={selected?.post_type === "text"}
            slideCount={selected?.asset_count ?? 0}
            postNow={postNow}
          />
        </div>
        {!postNow ? (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-soft mb-1">Date</label>
              <input type="date" className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-soft mb-1">Time (each account’s local)</label>
              <input type="time" className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
        ) : (
          <PostNowReadinessNotice readiness={readiness} />
        )}

        {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
        {notice ? (
          <p className="mt-3 text-sm text-status-posted">
            {notice} <Link href="/" className="underline underline-offset-2">View queue →</Link>
          </p>
        ) : null}

        <div className="mt-4 flex justify-end">
          <button
            onClick={schedule}
            disabled={busy || effectiveTargets.length === 0}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
          >
            {busy
              ? postNow
                ? "Sending…"
                : "Scheduling…"
              : postNow
              ? `Post now to ${targetAccountCount} account${targetAccountCount === 1 ? "" : "s"}`
              : `Schedule to ${targetAccountCount} account${targetAccountCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
