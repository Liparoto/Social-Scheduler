"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * How selective the standout hints are, for THIS account.
 *
 * There is no right answer to bake in: a large back catalogue may want the strictest 2%,
 * a small library building a rotation may want half of it, and the right tolerance moves
 * as an account grows — what was exceptional at 1,000 followers is not at 20,000.
 *
 * The live count is the point of the control. "Top 5%" is abstract; "suggests 21 of your
 * 146 posts" is a number somebody can react to, so the setting is tuned by watching the
 * result rather than by guessing at percentages.
 */
export function BppTolerance({
  channelId,
  strongPct,
  broadPct,
  matched,
  total,
}: {
  channelId: number;
  strongPct: number;
  broadPct: number;
  matched: number;
  total: number;
}) {
  const router = useRouter();
  const [strong, setStrong] = useState(strongPct);
  const [broad, setBroad] = useState(broadPct);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const dirty = strong !== strongPct || broad !== broadPct;

  async function save() {
    setBusy(true);
    await fetch(`/api/channels/${channelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bpp_strong_pct: strong, bpp_broad_pct: broad }),
    });
    setBusy(false);
    startTransition(() => router.refresh());
  }

  const field =
    "w-14 rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink focus:border-brand";

  return (
    <div className="flex flex-wrap items-end gap-3 text-[11px]">
      <label className="text-muted">
        <span className="mb-1 block">Outstanding on one metric</span>
        <span className="flex items-center gap-1">
          top
          <input
            type="number" min={1} max={100} value={strong}
            onChange={(e) => setStrong(Number(e.target.value))}
            className={field}
          />
          %
        </span>
      </label>
      <label className="text-muted">
        <span className="mb-1 block">Good across two or more</span>
        <span className="flex items-center gap-1">
          top
          <input
            type="number" min={1} max={100} value={broad}
            onChange={(e) => setBroad(Number(e.target.value))}
            className={field}
          />
          %
        </span>
      </label>

      {dirty ? (
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
        >
          {busy ? "Saving…" : "Apply"}
        </button>
      ) : (
        <span className="pb-1.5 text-muted">
          suggests <span className="data text-ink-soft">{matched}</span> of{" "}
          <span className="data text-ink-soft">{total}</span> posts
        </span>
      )}
    </div>
  );
}
