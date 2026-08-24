import { test } from "node:test";
import assert from "node:assert/strict";
import { limitsFor, checkMedia } from "./media-limits.ts";
import matrix from "./media-limits-matrix.json" with { type: "json" };

test("facebook reel limits load from the shared file", () => {
  const lim = limitsFor("facebook", "reel", "video");
  assert.equal(lim?.min_duration_ms, 3000);
  assert.equal(lim?.max_duration_ms, 90000);
});

test("an unknown platform has no limits — absent means NOT ENFORCED", () => {
  assert.equal(limitsFor("myspace", "feed", "video"), null);
});

test("unknown metadata never refuses", () => {
  const asset = { media_kind: "video", duration_ms: null, width: null, height: null };
  assert.deepEqual(checkMedia("facebook", "reel", asset), []);
});

// The whole point of the shared file: this matrix is the SAME file the Python side
// reads in test_media_limits_agreement.py. A case added here is covered on both sides.
for (const [i, c] of matrix.cases.entries()) {
  test(`matrix case ${i}: ${c.platform}/${c.surface}`, () => {
    const got = checkMedia(c.platform, c.surface, c.asset).map((v) => v.kind).sort();
    assert.deepEqual(got, [...c.expect].sort());
  });
}
