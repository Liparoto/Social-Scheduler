"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { humanBytes, videoPreviewSrc } from "@/lib/format";
import { MediaBadge, MediaLightbox, type LightboxAsset } from "@/components/media-lightbox";
import type { AssetWithUsage } from "@/lib/queries";

function durationLabel(ms: number | null): string | null {
  if (!ms) return null;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function MediaManager({ assets }: { assets: AssetWithUsage[] }) {
  const [openMedia, setOpenMedia] = useState<{ asset: LightboxAsset; label: string } | null>(
    null
  );
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
    const unused = assets.filter((a) => a.post_count === 0);
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
          const used = a.post_count > 0;
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
                {used ? (
                  <p className="text-xs text-faint">
                    In{" "}
                    <Link
                      href={`/library/${a.first_post_id}`}
                      className="text-brand underline underline-offset-2"
                    >
                      post #{a.first_post_id}
                    </Link>
                    {a.first_post_status ? ` (${a.first_post_status})` : ""}
                    {a.post_count > 1 ? ` +${a.post_count - 1} more` : ""}
                  </p>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-faint">Unused</span>
                    <button
                      type="button"
                      onClick={() => remove(a)}
                      disabled={busyId === a.id || pending}
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
          asset={openMedia.asset}
          label={openMedia.label}
          onClose={() => setOpenMedia(null)}
        />
      ) : null}
    </div>
  );
}
