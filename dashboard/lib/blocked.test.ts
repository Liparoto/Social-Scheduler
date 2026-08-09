import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlocked } from "./format";

/**
 * "Blocked" is the state between scheduled and failed: the worker tried, could not get
 * the post out, and will try again. It exists because a send held up by something
 * persistent — a VPN or mesh-network app owning DNS, say — otherwise sits in the queue
 * reading as a calm blue "Scheduled" indefinitely, which is how a stuck post goes
 * unnoticed. Each condition below is load-bearing.
 */

const NOW = Date.parse("2026-08-08T21:00:00Z");
const PAST = "2026-08-08T19:30:00Z";
const FUTURE = "2026-08-09T19:30:00Z";

test("overdue, still scheduled, and errored -> blocked", () => {
  assert.equal(
    isBlocked({ status: "scheduled", last_error: "no tunnel", scheduled_at: PAST }, NOW),
    true
  );
});

test("a failed send is not blocked — it is terminal and already reads as urgent", () => {
  assert.equal(
    isBlocked({ status: "failed", last_error: "boom", scheduled_at: PAST }, NOW),
    false
  );
});

test("a clean overdue send is not blocked — it just has not been picked up yet", () => {
  assert.equal(
    isBlocked({ status: "scheduled", last_error: null, scheduled_at: PAST }, NOW),
    false
  );
});

test("a FUTURE send carrying a stale error is not blocked", () => {
  // The case the overdue check exists for: retrying clears last_error, but rescheduling
  // does not, so without this a rescheduled send would wear the badge on old text alone.
  assert.equal(
    isBlocked({ status: "scheduled", last_error: "old failure", scheduled_at: FUTURE }, NOW),
    false
  );
});

test("a posted send is never blocked, even if its error text survived", () => {
  assert.equal(
    isBlocked({ status: "posted", last_error: "earlier failure", scheduled_at: PAST }, NOW),
    false
  );
});

test("an empty-string error counts as no error", () => {
  assert.equal(
    isBlocked({ status: "scheduled", last_error: "", scheduled_at: PAST }, NOW),
    false
  );
});

test("an unparseable date does not mark everything blocked", () => {
  assert.equal(
    isBlocked({ status: "scheduled", last_error: "no tunnel", scheduled_at: "junk" }, NOW),
    false
  );
});

test("the boundary instant counts as due", () => {
  assert.equal(
    isBlocked(
      { status: "scheduled", last_error: "no tunnel", scheduled_at: "2026-08-08T21:00:00Z" },
      NOW
    ),
    true
  );
});
