"use client";

import Link from "next/link";
import { channelColor, videoPreviewSrc } from "@/lib/format";

export interface ChipSend {
  id: number;
  postId: number;
  status: string;
  isDryRun: boolean;
  surface: string;
  time: string;
  caption: string | null;
  channelName: string;
  channelId: number;
  channelColorHue: number | null;
  assetId: number | null;
  assetMediaKind: "image" | "video" | null;
  assetCoverFrameMs: number | null;
  canMove: boolean;
}

/**
 * Truncate by code point, never by UTF-16 unit.
 *
 * `"…🔺".slice(0, n)` can cut an emoji in half and leave a lone surrogate. React then
 * renders one thing on the server and another after the browser's HTML parser has
 * replaced the orphan with U+FFFD, and the whole tree fails to hydrate — which is exactly
 * what happened here, on a caption ending in an emoji. Array.from splits on code points,
 * so a surrogate pair travels together.
 */
function snippet(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** Tints a chip by what the send is doing, without spending a whole badge on it —
 *  a month cell has room for a stripe, not a pill. */
function accentVar(status: string): string {
  if (status === "failed") return "--color-status-failed";
  if (status === "posted") return "--color-status-posted";
  if (status === "publishing") return "--color-status-publishing";
  if (status === "canceled") return "--color-status-canceled";
  return "--color-status-scheduled";
}

/**
 * One send on the calendar.
 *
 * A link, not a button: it goes to the post, so it should middle-click, open in a new tab
 * and show its target on hover like any other link. The drag handlers ride on top —
 * HTML5 drag works on an anchor, and dragging one does not fire its click.
 */
export function CalendarChip({
  send,
  dense,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  send: ChipSend;
  /** Month cells are tight: thumbnail and time only, caption dropped. */
  dense: boolean;
  onDragStart: (send: ChipSend) => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const color = channelColor(send.channelId, send.channelColorHue);
  const accent = `var(${accentVar(send.status)})`;

  return (
    <Link
      href={`/library/${send.postId}`}
      draggable={send.canMove}
      onDragStart={(e) => {
        if (!send.canMove) return;
        // setData is required or Firefox refuses to start the drag at all.
        e.dataTransfer.setData("text/plain", String(send.id));
        e.dataTransfer.effectAllowed = "move";
        onDragStart(send);
      }}
      onDragEnd={onDragEnd}
      title={
        `${send.time} · ${send.channelName}` +
        (send.caption ? ` · ${snippet(send.caption, 60)}` : "") +
        (send.canMove ? " — drag to another day to reschedule" : "")
      }
      className={`group flex items-center gap-1.5 overflow-hidden rounded-md border border-border bg-surface px-1.5 py-1 text-left transition-colors hover:border-border-strong hover:bg-surface-sunken ${
        dragging ? "opacity-40" : ""
      } ${send.canMove ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      {send.assetId ? (
        <span className="relative h-5 w-5 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
          {send.assetMediaKind === "video" ? (
            <video
              src={videoPreviewSrc(send.assetId, send.assetCoverFrameMs)}
              className="h-full w-full object-cover"
              preload="metadata"
              muted
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/media/${send.assetId}`}
              alt=""
              className="h-full w-full object-cover"
            />
          )}
        </span>
      ) : null}
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color.dot }}
        aria-hidden
      />
      <span className="data shrink-0 text-[10px] text-ink-soft">{send.time}</span>
      {/* A month cell is barely wider than a thumbnail and a clock, so the word labels are
          dropped there and survive only in the tooltip — spelled out they were clipped
          mid-word ("STOR"), which reads as a rendering fault rather than a label. Week
          cells are full-width and have room for them. */}
      {dense ? null : (
        <>
          <span className="truncate text-[11px] text-ink-soft">
            {send.caption ?? "Untitled"}
          </span>
          {send.isDryRun ? (
            <span className="shrink-0 text-[9px] uppercase text-faint">dry</span>
          ) : null}
          {send.surface === "story" ? (
            <span className="shrink-0 text-[9px] uppercase text-faint">story</span>
          ) : null}
        </>
      )}
    </Link>
  );
}
