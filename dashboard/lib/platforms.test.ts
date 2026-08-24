import { test } from "node:test";
import assert from "node:assert/strict";
import { supportsVideo, videoSurfaces } from "./platforms";

test("facebook accepts video on two surfaces", () => {
  assert.equal(supportsVideo("facebook"), true);
  assert.deepEqual(videoSurfaces("facebook").sort(), ["feed", "reel"]);
});

test("instagram has no separate reel surface", () => {
  assert.deepEqual(videoSurfaces("instagram").sort(), ["feed", "story"]);
});

test("an unknown platform gets no video surfaces", () => {
  assert.deepEqual(videoSurfaces("myspace"), []);
});
