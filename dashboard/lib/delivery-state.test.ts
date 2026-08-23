import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryLabel, isAwaitingPublication } from "./platforms";

// A TikTok send that is sitting in the creator's inbox is NOT posted, and the queue must
// never say it is. This is the same class of bug as the Threads metrics one: a value
// standing in for a fact it does not represent.

test("a delivered tiktok send never reads as posted", () => {
  const label = deliveryLabel({ platform: "tiktok", status: "posted", delivery_state: "inbox" });
  assert.match(label ?? "", /inbox/i);
  assert.doesNotMatch(label ?? "", /^posted$/i);
});

test("a published tiktok send says it is live", () => {
  assert.match(
    deliveryLabel({ platform: "tiktok", status: "posted", delivery_state: "published" }) ?? "",
    /live on tiktok/i,
  );
});

test("an unconfirmed send says so rather than guessing either way", () => {
  const label = deliveryLabel({
    platform: "tiktok",
    status: "posted",
    delivery_state: "gave_up",
  });
  assert.match(label ?? "", /unconfirmed/i);
  // "We don't know" must not drift into either "it failed" or "it published". Word
  // boundaries matter here: "Delivered" contains the letters of "live".
  assert.doesNotMatch(label ?? "", /\bfailed\b/i);
  assert.doesNotMatch(label ?? "", /\blive\b/i);
});

test("every platform that publishes on command is unaffected", () => {
  for (const platform of ["instagram", "facebook", "threads", "discord", "telegram"]) {
    assert.equal(deliveryLabel({ platform, status: "posted", delivery_state: null }), null);
  }
});

test("a send that did not reach posted is not relabelled as delivered", () => {
  // delivery_state only means anything once the worker succeeded. A failed row must keep
  // saying failed rather than borrowing a label left over from an earlier attempt.
  for (const status of ["failed", "scheduled", "publishing", "canceled"]) {
    assert.equal(
      deliveryLabel({ platform: "tiktok", status, delivery_state: "inbox" }),
      null,
      `a ${status} send borrowed a delivery label`,
    );
  }
});

test("an unrecognised delivery state looks wrong rather than reading as published", () => {
  const label = deliveryLabel({
    platform: "tiktok",
    status: "posted",
    delivery_state: "sideways",
  });
  assert.match(label ?? "", /unknown/i);
  assert.match(label ?? "", /sideways/);
});

// These two came out of looking at a real browser, not out of the unit tests: the row read
// "Posted" in green with the honest line underneath it, and offered a Refresh metrics
// button for a video nobody had published.

test("a send waiting to be published is not treated as measurable", () => {
  assert.equal(isAwaitingPublication("inbox"), true);
  // Also true for gave_up: we never saw it go live, so there is no post id to fetch.
  assert.equal(isAwaitingPublication("gave_up"), true);
});

test("a published or ordinary send IS measurable", () => {
  assert.equal(isAwaitingPublication("published"), false);
  // null = every platform that publishes on command. Nothing about them changes.
  assert.equal(isAwaitingPublication(null), false);
  assert.equal(isAwaitingPublication(undefined), false);
});

// TikTok's metric vocabulary. The Threads bug this project already fixed was one
// platform's words standing in for another's — TikTok has no reach and no saves.

test("tiktok is a platform the metric renderers know about", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync("components/post-sends-panel.tsx", "utf8"),
  );
  assert.match(src, /case "tiktok":/, "post-sends-panel has no tiktok branch");
  const tiktokBranch = src.slice(src.indexOf('case "tiktok":'), src.indexOf("default:"));
  assert.doesNotMatch(tiktokBranch, /"reach"/, "tiktok must not claim reach");
  assert.doesNotMatch(tiktokBranch, /"saves"/, "tiktok must not claim saves");
  assert.match(tiktokBranch, /"views"/);
});
