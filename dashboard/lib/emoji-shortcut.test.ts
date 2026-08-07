import assert from "node:assert/strict";
import { test } from "node:test";
import { detectPlatform, emojiShortcutHint } from "./emoji-shortcut.ts";

test("Windows gets the Windows shortcut and never the Mac one", () => {
  const hint = emojiShortcutHint("win32") ?? "";
  assert.match(hint, /Win \+ \./);
  assert.doesNotMatch(hint, /Cmd/);
});

test("macOS gets the Mac shortcut and never the Windows one", () => {
  const hint = emojiShortcutHint("darwin") ?? "";
  assert.match(hint, /Ctrl \+ Cmd \+ Space/);
  assert.doesNotMatch(hint, /Win \+/);
});

test("an unknown platform gets nothing rather than a wrong guess", () => {
  // A wrong shortcut is worse than no shortcut — it sends someone hunting for a key
  // combination their computer does not have.
  assert.equal(emojiShortcutHint("freebsd"), null);
  assert.equal(emojiShortcutHint(""), null);
});

test("detectPlatform maps real navigator.platform values", () => {
  assert.equal(detectPlatform("Win32"), "win32");
  assert.equal(detectPlatform("Windows"), "win32");
  assert.equal(detectPlatform("MacIntel"), "darwin");
  assert.equal(detectPlatform("macOS"), "darwin");
  assert.equal(detectPlatform("Linux x86_64"), "unknown");
});

test("an unrecognised navigator string produces no hint end to end", () => {
  assert.equal(emojiShortcutHint(detectPlatform("Linux x86_64")), null);
});

test("the end-to-end path works for both real platforms", () => {
  assert.match(emojiShortcutHint(detectPlatform("Win32")) ?? "", /Win \+ \./);
  assert.match(emojiShortcutHint(detectPlatform("MacIntel")) ?? "", /Cmd/);
});
