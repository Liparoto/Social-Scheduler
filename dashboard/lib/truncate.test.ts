/**
 * Truncating a caption without breaking the page.
 *
 * Captions on this install are full of emoji, and `String.prototype.slice` counts UTF-16
 * code units. Slicing at a boundary that falls inside a surrogate pair leaves half an
 * emoji: the server sends the lone surrogate, the browser's HTML parser swaps it for
 * U+FFFD, React sees two different strings and the whole tree fails to hydrate — every
 * client handler on the page dies, not just the label that was truncated.
 *
 * This was live in the Story group header, and had already been fixed once (privately) in
 * the Library view, which is exactly why it now lives in one place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateChars } from "./truncate.ts";

test("short text is returned untouched, with no ellipsis", () => {
  assert.equal(truncateChars("Backyard boil", 40), "Backyard boil");
});

test("text exactly at the limit is not truncated", () => {
  const exact = "x".repeat(40);
  assert.equal(truncateChars(exact, 40), exact);
});

test("longer text is cut and marked with an ellipsis", () => {
  assert.equal(truncateChars("abcdefghij", 4), "abcd…");
});

test("an emoji at the cut is never split in half", () => {
  // The whole point. "🔺" is one code point but TWO UTF-16 units, so a plain
  // slice(0, 3) here would keep only its leading surrogate.
  const out = truncateChars("ab🔺cd", 3);

  assert.equal(out, "ab🔺…");
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), "no orphaned high surrogate");
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), "no orphaned low surrogate");
});

test("a caption of nothing but emoji survives any cut", () => {
  const out = truncateChars("🔺🔥🌊🐶🦐", 2);

  assert.equal(out, "🔺🔥…");
  assert.ok(!/�/.test(out));
});

test("counting is by code point, so emoji are one character each", () => {
  // .length would call this 10 and refuse to truncate; Array.from calls it 5.
  assert.equal(truncateChars("🔺🔥🌊🐶🦐", 5), "🔺🔥🌊🐶🦐");
});

test("trailing space before the ellipsis is trimmed", () => {
  // "Backyard …" reads like a typo; "Backyard…" reads like a truncation.
  assert.equal(truncateChars("Backyard boil done", 9), "Backyard…");
});

test("empty text stays empty rather than becoming a bare ellipsis", () => {
  assert.equal(truncateChars("", 10), "");
});

test("a real caption from this install cuts cleanly at an emoji boundary", () => {
  // The exact shape that broke hydration: an emoji sitting on the 40-character mark.
  const caption =
    "Apparently this is the world's safest 🌊 beach, mural says so";
  const out = truncateChars(caption, 40);

  assert.ok(!/�/.test(out));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out));
  assert.ok(out.endsWith("…"));
});
