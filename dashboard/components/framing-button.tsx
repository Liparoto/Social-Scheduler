"use client";

import { useState } from "react";
import { FramingDialog } from "@/components/framing-dialog";
import type { Asset } from "@/lib/types";

/*
  Opens the framing dialog for one image.

  Replaces ConformControl, which was feed-only in both name and behaviour. Two things it
  did are deliberately NOT reproduced:

    * it replaced itself with static text once a choice was made, so framing could never be
      revisited. This button is always rendered.
    * it carried its own 40x40 object-cover preview, which rendered Crop and Pad
      identically. Previewing now happens in the dialog, at a size where the options
      actually differ.

  needs_review still decides the LABEL — it is a nudge that we chose for you and you haven't
  looked — but it no longer decides whether the control exists.
*/
export function FramingButton({
  asset,
  scheduledSendCount = 0,
}: {
  asset: Asset;
  /** Scheduled-but-unsent publications this asset's framing governs. Defaults to 0, which
   *  is correct for a freshly uploaded image: it cannot have sends yet. */
  scheduledSendCount?: number;
}) {
  const [open, setOpen] = useState(false);

  // sharp cannot reframe video, so there is nothing to offer for one.
  if (asset.media_kind !== "image") return null;

  const unreviewed = asset.needs_review === 1;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`mt-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
          unreviewed
            ? "bg-accent-weak text-accent-strong hover:opacity-90"
            : "border border-border text-muted hover:text-ink"
        }`}
      >
        {unreviewed ? "Review framing" : "Framing"}
      </button>
      {open ? (
        <FramingDialog
          asset={asset}
          scheduledSendCount={scheduledSendCount}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
