import assert from "node:assert/strict";
import { test } from "node:test";
import { captionLength } from "./caption-length.ts";

// (string, expected UTF-16 code units)
// This table is duplicated verbatim in worker/tests/test_caption_length.py. The duplication
// is the point: the bug this guards against was the two languages disagreeing, so both
// suites pin the same strings to the same numbers.
const CASES: [string, number][] = [
  ["", 0],
  ["hello", 5],
  ["\u{1F600}", 2], // grinning face — one code point, two UTF-16 units
  ["\u{1F44B}\u{1F3FD}", 4], // waving hand + skin-tone modifier
  ["\u{1F468}‍\u{1F469}‍\u{1F467}", 8], // family: 3 emoji + 2 ZWJ
  ["Great day! \u{1F600}\u{1F389}\u{1F53A}", 17],
  ["café", 4], // a BMP accent still counts 1
];

for (const [text, expected] of CASES) {
  test(`counts ${JSON.stringify(text)} as ${expected} UTF-16 code units`, () => {
    assert.equal(captionLength(text), expected);
  });
}

test("code-point counting would be wrong here, and this documents why", () => {
  // [...s].length counts CODE POINTS. That is what Python's len() did, and it is the bug:
  // it under-counts, letting an over-length caption reach a platform that then refuses it.
  // If someone ever "fixes" captionLength to spread the string, this test fails loudly.
  const text = "\u{1F600}";
  assert.equal([...text].length, 1, "spread counts code points");
  assert.equal(captionLength(text), 2, "captionLength must count UTF-16 code units");
});

test("agrees with the worker on the caption that exposed the bug", () => {
  // Python len() gave 14 here while JS .length gave 17 — a 3-character disagreement on an
  // entirely ordinary caption, on the side that decides whether a publish is allowed.
  assert.equal(captionLength("Great day! \u{1F600}\u{1F389}\u{1F53A}"), 17);
});
