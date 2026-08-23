"use client";

import { useState } from "react";

/**
 * Says out loud that a composed caption does not travel to TikTok.
 *
 * TikTok's inbox upload endpoint accepts the video file and nothing else — no title, no
 * description. The creator writes the caption inside TikTok's own editor when they tap the
 * notification. Without this notice, a caption box sitting next to a selected TikTok
 * channel quietly implies the opposite, and the surprise only surfaces on the phone.
 *
 * The caption is still worth writing and storing: it is what gets copied across, and on
 * every other selected channel it is published normally.
 */

export interface NoticeChannel {
  id: number;
  platform: string;
  account_name: string;
}

export function needsTikTokCaptionNotice(channels: NoticeChannel[]): boolean {
  return channels.some((c) => c.platform === "tiktok");
}

export function TikTokCaptionNotice({
  channels,
  caption,
}: {
  channels: NoticeChannel[];
  caption: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!needsTikTokCaptionNotice(channels)) return null;

  const trimmed = (caption ?? "").trim();

  async function copy() {
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (permissions, an insecure origin). Staying silent
      // is right here: the caption is on screen and can be selected by hand, so a failed
      // convenience must not look like a failed post.
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs text-muted">
      <p>
        <span className="font-medium text-ink">TikTok:</span> your caption isn&rsquo;t sent
        — TikTok has you write it in the app when you publish. It&rsquo;s saved here so you
        can copy it.
      </p>
      {trimmed ? (
        <button
          type="button"
          onClick={copy}
          className="rounded-md border border-border px-2 py-1 font-medium text-ink transition-colors hover:bg-surface"
        >
          {copied ? "Copied" : "Copy caption"}
        </button>
      ) : null}
    </div>
  );
}
