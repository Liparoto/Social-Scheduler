"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Every overlay currently on screen, oldest first. One press of Escape must close exactly
// one of them — the topmost — and nothing else on the page can work that out on its own:
// a nested overlay (the asset picker opened from inside quick edit) is not a React child of
// the dialog it visually sits on top of, it is a sibling portal into document.body.
//
// Module-level because that's the only place all the independent listeners can agree. Each
// overlay pushes a token on mount and splices it out on unmount, and React mounts the
// nested one LAST, so "last in the array" is "on top of the pile".
//
// Before this existed, QuickEditModal's capture-phase Escape listener swallowed the key for
// the picker mounted inside it and closed BOTH dialogs at once, throwing away an edit in
// progress just because someone backed out of the picker.
const openLayers: object[] = [];

/**
 * Registers this overlay on the app-wide modal stack for as long as it is mounted.
 *
 * Call it from any component that handles Escape as a modal, and ignore the key when
 * `isTop()` is false. Modals that use useModalFocusTrap get this for free; QuickEditModal
 * rolls its own Escape handling (it has to ask before discarding) and calls this directly.
 *
 * Before the registering effect runs — a static render, or the first commit — `isTop()`
 * answers true, which is the single-modal behaviour every existing caller already had.
 */
export function useModalLayer(): { isTop: () => boolean } {
  // Object identity is the whole token; useState so nothing is written during render.
  const [token] = useState<object>(() => ({}));
  useEffect(() => {
    openLayers.push(token);
    return () => {
      const at = openLayers.lastIndexOf(token);
      if (at !== -1) openLayers.splice(at, 1);
    };
  }, [token]);
  return useMemo(
    () => ({
      isTop: () =>
        openLayers.length === 0 || openLayers[openLayers.length - 1] === token,
    }),
    [token]
  );
}

// Every focusable thing a modal panel can contain. Shared so the trap, the initial focus,
// and the Tab cycling all agree on what "focusable" means — they broke apart once when only
// one of the three was updated.
//
// `video[controls]` comes from media-lightbox's copy, which had it; merge-modal's copy had
// drifted without it. It is the superset, and it is safe as the shared default: a native
// video player's controls are focusable, so leaving it out would let Tab walk out of a
// lightbox showing a video. Modals with no <video> match nothing extra.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * The behaviour every modal in this app shares: focus the first control on open, keep Tab
 * inside the panel, close on Escape, lock body scroll while open, and put focus back where
 * it was on close.
 *
 * Extracted from media-lightbox.tsx and merge-modal.tsx, which had it near-identically twice
 * — the two copies had drifted apart on whether `video[controls]` was included.
 *
 * `onClose` and `onKeyDown` are read through refs rather than closed over, so the listener
 * installs ONCE on mount and never needs re-binding when the caller re-renders with new
 * callbacks. (Writing a ref during render is flagged by the React Compiler's refs rule, so
 * both are updated in an effect instead.)
 *
 * @param onKeyDown Optional extra key handling, consulted AFTER Escape and BEFORE Tab.
 *                  Return true to say "handled — stop here". The lightbox uses this for
 *                  ArrowLeft/ArrowRight; a plain confirm dialog passes nothing.
 */
export function useModalFocusTrap({
  panelRef,
  onClose,
  onKeyDown,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onKeyDown?: (e: KeyboardEvent) => boolean;
}): void {
  const layer = useModalLayer();
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const onKeyDownRef = useRef(onKeyDown);
  useEffect(() => {
    onCloseRef.current = onClose;
    onKeyDownRef.current = onKeyDown;
  });

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const focusables = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
    (focusables()[0] ?? panel)?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      // Another overlay is stacked on top of this one — Escape, Tab and the caller's own
      // keys all belong to it, not to us. Every listener is on `document`, so without this
      // both traps would run for the same key press.
      if (!layer.isTop()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      // The caller's slot: after Escape, before Tab. Exactly where the lightbox's arrow
      // handling sat before this was extracted.
      if (onKeyDownRef.current?.(e)) return;
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel?.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
    // Mount-only, deliberately: panelRef is a stable ref object, `layer` is memoised on a
    // token that never changes, and both callbacks are read through refs above. Re-running
    // would tear down and re-install the listener on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
