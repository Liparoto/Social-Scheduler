"use client";

import { useSyncExternalStore } from "react";
import { detectPlatform, emojiShortcutHint } from "@/lib/emoji-shortcut";

/**
 * One muted line telling this user their operating system's own emoji shortcut.
 *
 * The hint is a CLIENT-ONLY value: the server has no idea what machine is asking, so
 * emitting platform-specific text during server rendering guarantees a hydration mismatch.
 * useSyncExternalStore is the idiom built for exactly that — `getServerSnapshot` returns
 * null so the server renders nothing, and the client fills it in on hydration. (A mount
 * effect calling setState would work too, but it triggers a cascading render and the lint
 * rule that catches it.)
 *
 * Renders nothing at all on a platform we cannot identify — a wrong shortcut is worse than
 * no shortcut, because it sends someone hunting for a key combination they do not have.
 */

// Computed once, lazily. getSnapshot must return a stable value across calls or
// useSyncExternalStore re-renders forever.
let cached: string | null | undefined;

function getSnapshot(): string | null {
  if (cached === undefined) {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const raw = nav.userAgentData?.platform || navigator.platform || "";
    cached = emojiShortcutHint(detectPlatform(raw));
  }
  return cached;
}

// The platform never changes mid-session, so there is nothing to subscribe to.
function subscribe(): () => void {
  return () => {};
}

export function EmojiHint() {
  const hint = useSyncExternalStore(subscribe, getSnapshot, () => null);
  if (!hint) return null;
  return <p className="mt-1 text-xs text-faint">Tip: {hint}.</p>;
}
