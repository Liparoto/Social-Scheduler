/**
 * Which timestamp a send should display.
 *
 * The queue showed `scheduled_at` for every row regardless of status, so a post that went
 * out late reported the time it was *meant* to go, not the time it went. On this install
 * that was not a rounding error: real sends drifted 2 hours, 8 hours, and in one case 19
 * hours when the Mac was asleep past its slot. The column silently claimed they were
 * punctual.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTime } from "./send-time.ts";

const SCHEDULED = "2026-08-11T19:30:00+00:00";
const PUBLISHED = "2026-08-12T14:20:08.123292+00:00";

test("a posted send reports when it actually went out", () => {
  const t = sendTime({
    status: "posted",
    scheduled_at: SCHEDULED,
    published_at: PUBLISHED,
  });

  assert.equal(t.iso, PUBLISHED);
  assert.equal(t.actual, true);
});

test("a scheduled send reports when it is due — there is no other answer yet", () => {
  const t = sendTime({ status: "scheduled", scheduled_at: SCHEDULED, published_at: null });

  assert.equal(t.iso, SCHEDULED);
  assert.equal(t.actual, false);
});

test("a send still in flight reports its due time, not a half-written one", () => {
  // published_at is only written once the platform has accepted the post, so a
  // 'publishing' row has nothing truer to show.
  const t = sendTime({ status: "publishing", scheduled_at: SCHEDULED, published_at: null });

  assert.equal(t.iso, SCHEDULED);
  assert.equal(t.actual, false);
});

test("a failed send reports its due time", () => {
  const t = sendTime({ status: "failed", scheduled_at: SCHEDULED, published_at: null });
  assert.equal(t.iso, SCHEDULED);
  assert.equal(t.actual, false);
});

test("a posted send with no recorded publish time falls back rather than showing nothing", () => {
  // Shouldn't happen — publish_one writes both in one statement — but a blank cell would
  // be a worse answer than an approximate one, and older rows predate some of the writes.
  const t = sendTime({ status: "posted", scheduled_at: SCHEDULED, published_at: null });

  assert.equal(t.iso, SCHEDULED);
  assert.equal(t.actual, false, "must not claim an inferred time is the real one");
});

test("a dry run reports when the rehearsal ran", () => {
  // A dry run publishes nothing, but it did happen, and at a real moment.
  const t = sendTime({
    status: "posted",
    scheduled_at: SCHEDULED,
    published_at: PUBLISHED,
  });
  assert.equal(t.iso, PUBLISHED);
});

// ---- lateness ------------------------------------------------------------------------
test("a send that went out about when planned is not called late", () => {
  // The worker polls every 30s, so a punctual send is still a minute or so off. Flagging
  // that would put "late" on nearly every row and teach the owner to ignore it.
  const t = sendTime({
    status: "posted",
    scheduled_at: SCHEDULED,
    published_at: "2026-08-11T19:30:22.941061+00:00",
  });

  assert.equal(t.lateMinutes, null);
});

test("a send held up for hours reports how far behind it was", () => {
  const t = sendTime({
    status: "posted",
    scheduled_at: SCHEDULED,
    published_at: PUBLISHED,
  });

  assert.equal(t.lateMinutes, 1130);
});

test("a send that went out early is not reported as late", () => {
  // Post now, or a reschedule into the past, can land before scheduled_at.
  const t = sendTime({
    status: "posted",
    scheduled_at: SCHEDULED,
    published_at: "2026-08-11T18:00:00+00:00",
  });

  assert.equal(t.lateMinutes, null);
});

test("an unparseable timestamp does not invent a lateness", () => {
  const t = sendTime({
    status: "posted",
    scheduled_at: "not-a-date",
    published_at: PUBLISHED,
  });

  assert.equal(t.iso, PUBLISHED);
  assert.equal(t.lateMinutes, null);
});
