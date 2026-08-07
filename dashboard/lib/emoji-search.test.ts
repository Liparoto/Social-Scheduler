import assert from "node:assert/strict";
import { test } from "node:test";
import { searchEmoji, type Emoji } from "./emoji-search.ts";

const FIXTURE: Emoji[] = [
  { char: "😀", name: "grinning face", group: "Smileys & Emotion", keywords: ["smile", "happy"] },
  { char: "🎉", name: "party popper", group: "Activities", keywords: ["celebration", "tada"] },
  { char: "🔺", name: "red triangle pointed up", group: "Symbols", keywords: ["triangle"] },
];

test("an empty query returns everything, unfiltered", () => {
  assert.equal(searchEmoji(FIXTURE, "").length, 3);
  assert.equal(searchEmoji(FIXTURE, "   ").length, 3);
});

test("matches on name", () => {
  assert.deepEqual(
    searchEmoji(FIXTURE, "party").map((e) => e.char),
    ["🎉"]
  );
});

test("matches on keyword, not just name", () => {
  // "tada" appears nowhere in the name — keyword matching is the whole point.
  assert.deepEqual(
    searchEmoji(FIXTURE, "tada").map((e) => e.char),
    ["🎉"]
  );
});

test("is case- and whitespace-insensitive", () => {
  assert.deepEqual(
    searchEmoji(FIXTURE, "  PARTY ").map((e) => e.char),
    ["🎉"]
  );
});

test("a query matching nothing returns empty, not everything", () => {
  assert.deepEqual(searchEmoji(FIXTURE, "zzzz"), []);
});

test("prefers a name match over a keyword match", () => {
  // 🔺 has "triangle" in its NAME; nothing else does. If the two bands were merged into one
  // filter this would still pass by luck, so the ordering assertion below is the real check.
  const results = searchEmoji(FIXTURE, "triangle");
  assert.equal(results[0].char, "🔺", "the name match should rank first");
});

test("name matches rank above keyword matches when both exist", () => {
  const both: Emoji[] = [
    { char: "🅰️", name: "keyword only", group: "X", keywords: ["smile"] },
    { char: "😀", name: "smile face", group: "X", keywords: [] },
  ];
  assert.deepEqual(
    searchEmoji(both, "smile").map((e) => e.char),
    ["😀", "🅰️"],
    "the emoji NAMED smile must come before the one merely tagged smile"
  );
});
