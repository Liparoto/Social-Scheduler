/**
 * How long is a caption, in the units the target platform actually counts?
 *
 * Every platform this app enforces a limit for counts UTF-16 CODE UNITS, in which any
 * character outside the Basic Multilingual Plane — every emoji — counts 2, and a ZWJ
 * sequence counts the sum of its parts plus its joiners. JavaScript's `.length` is already
 * exactly that, so this function is a no-op wrapper.
 *
 * It exists anyway, for one reason: `s.length` LOOKS like a bug next to an emoji, and the
 * obvious "fix" — `[...s].length`, which counts code points — would silently break Telegram
 * and Discord and make Threads unsafe. This function is where that reasoning lives so nobody
 * has to rediscover it.
 *
 * This is not hypothetical. The worker used Python's len() (code points) while the dashboard
 * used .length (UTF-16), and they disagreed by 3 on "Great day! 😀🎉🔺". The worker is the
 * authoritative gate, so it was the side letting an over-length caption through to be refused
 * by the platform at send time — a post that read "scheduled" and then died terminally.
 *
 * Per-platform units, researched rather than assumed:
 *
 *   - Telegram   UTF-16 code units. VERIFIED — its entities spec is explicit that BMP
 *                characters count 1 and everything else counts 2.
 *   - Discord    UTF-16 code units. VERIFIED — an emoji costs 2, a ZWJ family 7+.
 *   - Threads    UNKNOWN. Meta documents "500 characters" without defining the unit, and
 *                third-party trackers contradict each other. UTF-16 is chosen because it is
 *                the STRICTER candidate: counting high can only warn early, while counting
 *                low lets a caption through that dies terminally on publish. A SAFE DEFAULT,
 *                not something Meta confirmed. See
 *                docs/superpowers/specs/2026-08-07-emoji-picker-design.md.
 *   - Instagram
 *     / Facebook No limit is enforced by this app (their captionChars maps are empty).
 *
 * Mirrored by worker/caption_length.py, whose tests pin the same strings to the same numbers.
 * If you change one, change both.
 */
export function captionLength(text: string): number {
  return text.length;
}
