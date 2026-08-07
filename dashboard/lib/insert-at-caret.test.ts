import assert from "node:assert/strict";
import { test } from "node:test";
import { insertAtCaret } from "./insert-at-caret.ts";

test("inserts at the caret rather than appending", () => {
  // The bug this prevents: appending to the end, which is the obvious implementation and is
  // wrong for anyone editing the middle of a caption.
  const r = insertAtCaret("Hello world", "😀", 5, 5);
  assert.equal(r.text, "Hello😀 world");
});

test("the caret lands after the inserted emoji, not before it", () => {
  const r = insertAtCaret("Hello world", "😀", 5, 5);
  // '😀' is 2 UTF-16 code units, so the caret moves by 2, not 1. setSelectionRange counts
  // the same units, which is why this must not use code points.
  assert.equal(r.caret, 7);
  assert.equal(r.text.slice(0, r.caret), "Hello😀");
});

test("replaces a selection", () => {
  const r = insertAtCaret("Hello world", "😀", 0, 5);
  assert.equal(r.text, "😀 world");
  assert.equal(r.caret, 2);
});

test("appends when the caret is at the end", () => {
  const r = insertAtCaret("Hi", "🎉", 2, 2);
  assert.equal(r.text, "Hi🎉");
  assert.equal(r.caret, 4);
});

test("handles an empty field", () => {
  const r = insertAtCaret("", "🔺", 0, 0);
  assert.equal(r.text, "🔺");
  assert.equal(r.caret, 2);
});

test("inserting twice in a row stays in order", () => {
  // Guards the caret arithmetic: if the returned caret were wrong, the second insert would
  // land in the wrong place and this would read "🎉😀" or split a surrogate pair.
  const first = insertAtCaret("ab", "😀", 1, 1);
  const second = insertAtCaret(first.text, "🎉", first.caret, first.caret);
  assert.equal(second.text, "a😀🎉b");
});

test("a multi-code-unit emoji never splits when inserted next to one", () => {
  const first = insertAtCaret("", "👨‍👩‍👧", 0, 0);
  const second = insertAtCaret(first.text, "🔥", first.caret, first.caret);
  assert.equal(second.text, "👨‍👩‍👧🔥");
  assert.equal(second.caret, first.caret + 2);
});
