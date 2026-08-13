/**
 * Shortening user text — captions, mostly — without breaking the page.
 *
 * `String.prototype.slice` counts UTF-16 code units, and an emoji is two of them. Cutting
 * at a boundary inside a surrogate pair leaves half an emoji behind: the server sends the
 * lone surrogate, the browser's HTML parser replaces it with U+FFFD, React compares the
 * two and reports a hydration mismatch. That failure is not local to the label — the tree
 * does not hydrate, so every client handler on the page stops working.
 *
 * Captions here are full of emoji, so this is routine rather than an edge case. It has now
 * been hit twice (the Library view fixed it privately, the Story group header did not, and
 * the calendar chip rediscovered it), which is why the rule lives in exactly one place.
 */

/**
 * Truncate to `max` CODE POINTS, appending an ellipsis only when something was removed.
 *
 * Array.from splits on code points, so a surrogate pair travels together. (A ZWJ emoji
 * sequence — 👨‍👩‍👧 and friends — can still split into its components; that stays valid
 * UTF-16 and cannot break hydration, which is the property being protected here.)
 *
 * The trailing space is trimmed before the ellipsis, because "Backyard …" reads like a
 * typo where "Backyard…" reads like a truncation.
 */
export function truncateChars(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max).join("").trimEnd()}…`;
}
