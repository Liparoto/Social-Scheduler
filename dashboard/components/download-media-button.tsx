"use client";

/**
 * "Save a copy of this to my computer."
 *
 * Deliberately a plain <a download>, not a fetch-into-a-blob. The server already marks the
 * response as an attachment (see app/api/media/[id]/route.ts), so the browser does the
 * whole job: it picks the filename out of Content-Disposition and puts the file wherever
 * that browser's own download preference says. Ticking "ask where to save each file" in
 * Safari or Chrome turns this into a save dialog on any OS.
 *
 * The obvious-looking alternative, showSaveFilePicker(), is Chromium-only — it does not
 * exist in Safari, so it would silently do nothing for this install's owner.
 */

function DownloadGlyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </svg>
  );
}

export function DownloadMediaButton({
  assetId,
  label,
  variant,
}: {
  assetId: number;
  /** What is being downloaded, for the accessible name — usually a caption or filename. */
  label?: string;
  /**
   * Where this sits, which is really a question of how much room there is:
   * - "lightbox"        the full-size viewer's control cluster
   * - "overlay"         a roomy thumbnail (Media Manager tiles measure 230px)
   * - "overlay-compact" a small thumbnail (Library card chips measure 64px)
   */
  variant: "lightbox" | "overlay" | "overlay-compact";
}) {
  const accessibleName = label ? `Download original — ${label}` : "Download original";

  const position =
    variant === "lightbox"
      ? // Top-LEFT: Close owns the top-right and the carousel chevrons own the vertical
        // midpoints, so this is the only corner of the panel that is actually free.
        "absolute -left-3 -top-3 h-8 w-8 border border-border bg-surface text-ink shadow-lg hover:bg-surface-sunken"
      : variant === "overlay"
        ? // Left of MediaBadge (bottom-1 right-1, w-6), so the two read as one small
          // cluster rather than colliding. Visible rather than hover-only: hover does not
          // exist on a touch screen, and MediaBadge beside it is always visible too.
          "absolute bottom-1 right-8 h-6 w-6 bg-black/70 text-white opacity-80 hover:bg-black/85 hover:opacity-100"
        : // A Library chip is 64px square. A second always-visible 24px control there
          // covers most of the picture the chip exists to show, so this one is smaller,
          // sits in the opposite corner from MediaBadge, and stays hidden until the card
          // is hovered or the link is focused. Keyboard users still reach it — focus
          // brings it back — and touch users have the lightbox's own button, which is
          // where a tap on the chip leads anyway.
          "absolute bottom-1 left-1 h-5 w-5 bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-black/85";

  return (
    <a
      href={`/api/media/${assetId}?download=1`}
      // No value: the filename comes from the server's Content-Disposition, which is the
      // only place that knows the asset's original_filename.
      download
      // The thumbnail sits inside a click-to-open card in both grids that use the overlay
      // variant. Without this, downloading also pops the lightbox open behind the save.
      onClick={(e) => e.stopPropagation()}
      aria-label={accessibleName}
      title={accessibleName}
      className={`z-10 flex items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${position}`}
    >
      <DownloadGlyph size={variant === "overlay-compact" ? 12 : 14} />
    </a>
  );
}
