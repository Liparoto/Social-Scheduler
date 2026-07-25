"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";
import { platformLabel } from "@/lib/platforms";

/**
 * Edit-panel counterpart to the create form's swatch picker. Saves immediately on
 * pick (matching ChannelToggle's pattern) rather than needing a separate "Save" click —
 * the live preview already tells the owner what they're about to get.
 */
export function ChannelColor({
  channelId,
  platform,
  accountName,
  colorHue,
}: {
  channelId: number;
  platform: string;
  accountName: string;
  colorHue: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<number | null>(colorHue);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(hue: number | null) {
    const previous = value;
    setError(null);
    setValue(hue);
    const res = await fetch(`/api/channels/${channelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color_hue: hue }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setValue(previous);
      setError(body.error ?? "Could not save the accent colour.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-sunken/40 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-medium text-ink-soft">Accent colour</span>
        <span className="text-xs text-muted">{open ? "Hide" : "Edit"}</span>
      </button>

      {open ? (
        <div className="mt-3">
          <ColorSwatchPicker
            value={value}
            onChange={pick}
            previewChannelId={channelId}
            previewName={accountName}
            previewPlatformLabel={platformLabel(platform)}
          />
          {pending ? <p className="mt-2 text-[11px] text-muted">Saving…</p> : null}
          {error ? <p className="mt-2 text-[11px] text-status-failed">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
