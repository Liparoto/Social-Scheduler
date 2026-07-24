"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ConformMode } from "@/lib/conform";

const segBtn = (active: boolean) =>
  `rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
    active ? "bg-brand-weak text-brand-strong" : "text-muted hover:text-ink"
  }`;

export function ConformControl({
  assetId,
  conformMode,
  needsReview,
}: {
  assetId: number;
  conformMode: ConformMode;
  needsReview: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<ConformMode>(conformMode);
  const [reviewed, setReviewed] = useState(needsReview === 0);
  const [bust, setBust] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: ConformMode) {
    if (next === mode && reviewed) return;
    setError(null);
    const res = await fetch(`/api/assets/${assetId}/conform`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not update framing.");
      return;
    }
    setMode(next);
    setReviewed(true);
    setBust((b) => b + 1);
    startTransition(() => router.refresh());
  }

  if (reviewed) {
    return (
      <p className="mt-1 text-[10px] text-faint">
        Framing set{mode !== "none" ? ` — ${mode}` : ""}
      </p>
    );
  }

  return (
    <div className="mt-1 space-y-1">
      <span className="inline-block rounded bg-accent-weak px-1.5 py-0.5 text-[10px] font-medium text-accent-strong">
        Auto-cropped — review framing
      </span>
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-md border border-border p-0.5">
          <button
            type="button"
            disabled={pending}
            className={segBtn(mode === "crop")}
            onClick={() => choose("crop")}
          >
            Crop
          </button>
          <button
            type="button"
            disabled={pending}
            className={segBtn(mode === "pad")}
            onClick={() => choose("pad")}
          >
            Pad
          </button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/media/${assetId}?variant=publish&v=${bust}`}
          alt="Conformed preview"
          className="h-10 w-10 rounded border border-border object-cover"
        />
      </div>
      {error ? <p className="text-[10px] text-status-failed">{error}</p> : null}
    </div>
  );
}
