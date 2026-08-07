/**
 * The operating system's own emoji shortcut, or null if we don't recognise the platform.
 *
 * Worth surfacing even though this app now has its own picker: the OS picker works in every
 * other program on their computer, and a one-line tip is how someone finds that out. The
 * in-app picker covers this app; this covers the rest of their day.
 *
 * Takes the platform as an argument rather than reading it internally, for the same reason
 * converterAdvice() does — every branch stays testable from one machine.
 */
export function emojiShortcutHint(platform: string): string | null {
  if (platform === "win32") return "Win + . opens your computer's own emoji picker";
  if (platform === "darwin") return "Ctrl + Cmd + Space opens your Mac's own emoji picker";
  // Linux and anything else: desktop environments differ too much to guess, and a wrong
  // shortcut is worse than none.
  return null;
}

/**
 * Map a browser's reported platform string onto the values emojiShortcutHint expects.
 *
 * `navigator.platform` is deprecated but still the most widely populated signal; modern
 * Chromium also exposes `navigator.userAgentData.platform`. Both are checked, and anything
 * unrecognised yields null so no hint renders at all.
 */
export function detectPlatform(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("win")) return "win32";
  if (s.includes("mac") || s.includes("iphone") || s.includes("ipad")) return "darwin";
  return "unknown";
}
