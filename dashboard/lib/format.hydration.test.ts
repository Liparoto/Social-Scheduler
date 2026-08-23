import { test } from "node:test";
import assert from "node:assert/strict";
import { formatInTz, formatParts } from "./format.ts";

/**
 * Guards the two ways Intl output drifts between Node and a browser. When it drifts,
 * React discards the server HTML and re-renders the whole page on the client — so these
 * characters are a hydration bug, not a cosmetic one.
 */

const ISO = "2026-08-24T01:00:00Z"; // 6:00 PM in Los Angeles

test("no narrow/no-break space survives — it is invisible in React's mismatch diff", () => {
  const s = formatInTz(ISO, "America/Los_Angeles");
  assert.equal(
    /[\u00a0\u202f\u2009]/.test(s),
    false,
    `found a no-break space in ${JSON.stringify(s)}`
  );
});

test("the date/time connector is pinned to ', ', never CLDR's newer ' at '", () => {
  const s = formatInTz(ISO, "America/Los_Angeles");
  assert.equal(/\bat\b/.test(s), false, `found an "at" connector in ${JSON.stringify(s)}`);
  assert.equal(s, "Aug 23, 6:00 PM");
});

test("normalisation only touches literals — the values still come from Intl", () => {
  // Same instant, two zones: the pinning must not flatten a real timezone difference.
  assert.equal(formatInTz(ISO, "America/New_York"), "Aug 23, 9:00 PM");
  assert.equal(formatInTz(ISO, "UTC"), "Aug 24, 1:00 AM");
});

test("caller options still pass through", () => {
  assert.equal(
    formatInTz(ISO, "America/Los_Angeles", { weekday: "short" }),
    "Sun, Aug 23, 6:00 PM"
  );
});

test("a date-only format is left alone", () => {
  assert.equal(
    formatParts(new Date(ISO), { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }),
    "Aug 24, 2026"
  );
});

test("null and unparseable input still render the em dash", () => {
  assert.equal(formatInTz(null, "UTC"), "—");
  assert.equal(formatInTz("not a date", "UTC"), "—");
});
