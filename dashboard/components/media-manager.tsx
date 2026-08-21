"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { humanBytes, videoPreviewSrc } from "@/lib/format";
import { truncateChars } from "@/lib/truncate";
import { DownloadMediaButton } from "@/components/download-media-button";
import { MediaBadge, MediaLightbox, type LightboxAsset } from "@/components/media-lightbox";
import type { AssetWithUsage } from "@/lib/queries";

// How many linked posts to show before collapsing the rest behind "+N more". Two keeps a
// heavily-reused asset's card the same height as everyone else's; evergreen media on this
// install is reused freely, so "a few" is the normal case rather than the exception.
const INLINE_POSTS = 2;

/**
 * What to call a post on a media card.
 *
 * The caption's FIRST LINE, not the id: "post #47" gives nothing to recognise a post by, so
 * the one working link still had to be opened to find out whether it was the right one.
 *
 * truncateChars, never slice: captions here are mostly emoji, and cutting inside a surrogate
 * pair sends a lone surrogate that fails hydration for the WHOLE page, not just this label.
 */
export function postLabel(caption: string | null, postId: number): string {
  const firstLine = (caption ?? "").trim().split("\n")[0].trim();
  return firstLine ? truncateChars(firstLine, 42) : `post #${postId}`;
}

function durationLabel(ms: number | null): string | null {
  if (!ms) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function MediaManager({ assets }: { assets: AssetWithUsage[] }) {
  const [openMedia, setOpenMedia] = useState<{ asset: LightboxAsset; label: string } | null>(
    null
  );
  // Which cards have had their "+N more" opened. Per asset, so expanding one heavily-reused
  // file does not push every other card down the page.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const router = useRouter();
  const [pending, startT] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function remove(a: AssetWithUsage) {
    const name = a.original_filename ?? `Asset ${a.id}`;
    if (
      !confirm(
        `Delete "${name}" (${humanBytes(a.byte_size)})?\n\n` +
          `The file is removed from disk permanently. This cannot be undone.`
      )
    )
      return;
    setError(null);
    setBusyId(a.id);
    try {
      const res = await fetch(`/api/assets/${a.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not delete that file.");
        return;
      }
      startT(() => router.refresh());
    } catch {
      setError("Could not reach the server. Is the dashboard still running?");
    } finally {
      setBusyId(null);
    }
  }

  const summary = useMemo(() => {
    // "Unused" has to mean "nothing at all references this", not "no post references this".
    // A Reels cover (assets.cover_asset_id) has no post_assets row but IS referenced, and
    // deleteAsset() refuses it — counting its bytes here would promise space that cannot be
    // reclaimed. Any future reference to an asset belongs in this condition too.
    const unused = assets.filter((a) => a.post_count === 0 && a.cover_use_count === 0);
    const bytes = (list: AssetWithUsage[]) =>
      list.reduce((sum, a) => sum + (a.byte_size ?? 0), 0);
    return {
      count: assets.length,
      total: bytes(assets),
      unusedCount: unused.length,
      unusedBytes: bytes(unused),
    };
  }, [assets]);

  return (
    <div>
      <p className="mb-6 text-sm text-faint">
        {summary.count} {summary.count === 1 ? "item" : "items"} · {humanBytes(summary.total)}
        {summary.unusedCount > 0 ? (
          <>
            {" "}
            · {summary.unusedCount} unused ({humanBytes(summary.unusedBytes)})
          </>
        ) : null}
      </p>

      {error ? (
        <p className="mb-4 rounded-lg bg-accent-weak px-3 py-2 text-sm text-accent-strong">
          {error}
        </p>
      ) : null}

      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((a) => {
          const name = a.original_filename ?? `Asset ${a.id}`;
          const inPost = a.post_count > 0;
          const isCover = a.cover_use_count > 0;
          const isExpanded = expanded.has(a.id);
          // Plain words, because this line is the whole explanation of why a file has no
          // Delete button. A cover is attached to a VIDEO, not to a post, so "in post #N"
          // would be a lie — and the post link would point at nothing.
          //
          // Two spellings rather than one lowercased at the call site: "Reels" is a proper
          // noun and .toLowerCase() rendered it as "a reels cover".
          const coverTail = a.cover_use_count > 1 ? ` (${a.cover_use_count} videos)` : "";
          const coverLabel = `Used as a Reels cover${coverTail}`;
          const coverAlso = `also used as a Reels cover${coverTail}`;
          return (
            <li
              key={a.id}
              className="overflow-hidden rounded-card border border-border bg-surface"
            >
              <div className="relative aspect-square bg-surface-sunken">
                {a.media_kind === "video" ? (
                  // No thumbnail file exists for video (no ffmpeg dependency by design) —
                  // render the real file with preload="metadata" so the browser decodes
                  // just one frame. Same approach as library-view.tsx.
                  <video
                    src={videoPreviewSrc(a.id, a.cover_frame_ms)}
                    preload="metadata"
                    muted
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/${a.id}?variant=thumb`}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                )}
                <DownloadMediaButton assetId={a.id} label={name} variant="overlay" />
                <MediaBadge
                  mediaKind={a.media_kind}
                  label={name}
                  onOpen={() =>
                    setOpenMedia({
                      label: name,
                      asset: {
                        id: a.id,
                        media_kind: a.media_kind,
                        cover_frame_ms: a.cover_frame_ms,
                        width: a.width,
                        height: a.height,
                      },
                    })
                  }
                />
              </div>

              <div className="space-y-1 p-3">
                <p className="truncate text-sm font-medium" title={name}>
                  {name}
                </p>
                <p className="text-xs text-faint">
                  {humanBytes(a.byte_size)}
                  {a.width && a.height ? ` · ${a.width}×${a.height}` : ""}
                  {durationLabel(a.duration_ms) ? ` · ${durationLabel(a.duration_ms)}` : ""}
                </p>
                {inPost ? (
                  <div className="space-y-0.5 text-xs text-faint">
                    {a.posts.length > 1 ? <p>In {a.posts.length} posts:</p> : null}
                    {(isExpanded ? a.posts : a.posts.slice(0, INLINE_POSTS)).map((linked) => (
                      // EVERY post gets its own link. The old card linked one — whichever had
                      // the lowest id — and rendered the rest as the dead text "+N more", so
                      // most posts using a reused asset could not be reached from here at all.
                      <p key={linked.post_id} className="truncate">
                        {a.posts.length > 1 ? "" : "In "}
                        <Link
                          href={`/library/${linked.post_id}`}
                          className="text-brand underline underline-offset-2"
                          title={linked.caption ?? `post #${linked.post_id}`}
                        >
                          {postLabel(linked.caption, linked.post_id)}
                        </Link>
                        {linked.status ? ` (${linked.status})` : ""}
                      </p>
                    ))}
                    {!isExpanded && a.posts.length > INLINE_POSTS ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((prev) => new Set(prev).add(a.id))
                        }
                        className="text-brand underline underline-offset-2"
                      >
                        +{a.posts.length - INLINE_POSTS} more
                      </button>
                    ) : null}
                    {isCover ? <p>{coverAlso}</p> : null}
                  </div>
                ) : isCover ? (
                  // Referenced, but by a video rather than a post — so it gets a reason and
                  // no Delete button, matching what deleteAsset() would actually allow.
                  <p className="text-xs text-faint">{coverLabel}</p>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-faint">Unused</span>
                    <button
                      type="button"
                      onClick={() => remove(a)}
                      disabled={busyId === a.id || pending}
                      aria-label={`Delete ${name}`}
                      className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-status-failed hover:bg-surface-sunken disabled:opacity-50"
                    >
                      {busyId === a.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {openMedia ? (
        <MediaLightbox
          assets={[openMedia.asset]}
          label={openMedia.label}
          onClose={() => setOpenMedia(null)}
        />
      ) : null}
    </div>
  );
}
