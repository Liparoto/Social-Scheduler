import assert from "node:assert/strict";
import { test } from "node:test";
import { converterAdvice } from "./converter-advice.ts";

test("Windows is never told to use Homebrew", () => {
  const advice = converterAdvice("win32");
  assert.ok(!/brew/i.test(advice), `must not mention brew on Windows: ${advice}`);
  assert.ok(/Start-SocialScheduler-Windows\.bat/.test(advice),
    "should point at the launcher, which now installs it automatically");
});

test("macOS keeps the Homebrew hint", () => {
  assert.ok(/brew install ffmpeg/.test(converterAdvice("darwin")));
});

test("other platforms get something generic but still actionable", () => {
  const advice = converterAdvice("linux");
  assert.ok(/ffmpeg/.test(advice));
  assert.ok(!/brew/i.test(advice));
});
