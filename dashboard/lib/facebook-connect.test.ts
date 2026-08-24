import assert from "node:assert/strict";
import { test } from "node:test";
import { missingTasks, verifyPageToken } from "./facebook-connect.ts";

const PAGE_ID = "111222333";

/** A token that passes every check — each test below spoils exactly one thing. */
const GOOD = {
  type: "PAGE",
  scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
  expires_at: 0,
  profile_id: PAGE_ID,
};

test("a fully valid Page token is accepted", () => {
  assert.equal(verifyPageToken(GOOD, PAGE_ID), null);
});

// ---- the four token checks, one test each ---------------------------------------

test("a USER token on a Page channel is refused", () => {
  // It reads fine and never publishes, so nothing downstream would catch this.
  const problem = verifyPageToken({ ...GOOD, type: "USER" }, PAGE_ID);
  assert.ok(problem);
  assert.match(problem!, /not a Page token/);
});

test("a token without pages_manage_posts is refused, and names the error it would cause", () => {
  // Its absence is the (#200) Permissions error and nothing else is — worth naming,
  // because the failure appears at publish time with no reference to a missing scope.
  const scopes = GOOD.scopes.filter((s) => s !== "pages_manage_posts");
  const problem = verifyPageToken({ ...GOOD, scopes }, PAGE_ID);
  assert.ok(problem);
  assert.match(problem!, /pages_manage_posts/);
  assert.match(problem!, /#200/);
  // An existing token never gains a scope retroactively — without saying so, the obvious
  // next move is to add the permission and retry with the same dead token.
  assert.match(problem!, /NEW token|new token/);
});

test("a Page token that still expires is refused — the whole reason this step exists", () => {
  // THE bug from exchange_token.py's header: a Page token derived from an UNEXTENDED
  // user token is indistinguishable from a permanent one until it dies that afternoon.
  // expires_at is the only thing that can tell them apart.
  const inAnHour = 1_777_000_000;
  const problem = verifyPageToken({ ...GOOD, expires_at: inAnHour }, PAGE_ID);
  assert.ok(problem);
  assert.match(problem!, /still expires/);
});

test("a token for a different Page is refused", () => {
  // Guards against storing Page B's token on Page A's channel, which publishes happily
  // to the wrong audience rather than failing.
  const problem = verifyPageToken({ ...GOOD, profile_id: "999888777" }, PAGE_ID);
  assert.ok(problem);
  assert.match(problem!, /999888777/);
  assert.match(problem!, new RegExp(PAGE_ID));
});

test("a numeric profile_id still matches a string page id", () => {
  // Meta is inconsistent about quoting ids. A type mismatch here would reject a correct
  // token with "belongs to a different Page", which is a maddening thing to debug.
  assert.equal(verifyPageToken({ ...GOOD, profile_id: Number(PAGE_ID) }, PAGE_ID), null);
});

test("a missing type is refused rather than treated as absent-therefore-fine", () => {
  const problem = verifyPageToken({ scopes: GOOD.scopes, expires_at: 0 }, PAGE_ID);
  assert.ok(problem, "an empty debug_token response must not pass");
});

// ---- the fifth check: roles held on the Page itself ------------------------------

test("both publishing roles are required", () => {
  assert.deepEqual(missingTasks(["CREATE_CONTENT", "MANAGE", "MODERATE"]), []);
  assert.deepEqual(missingTasks(["CREATE_CONTENT"]), ["MANAGE"]);
  assert.deepEqual(missingTasks(["MANAGE"]), ["CREATE_CONTENT"]);
  assert.deepEqual(missingTasks(["ANALYZE"]), ["CREATE_CONTENT", "MANAGE"]);
});

test("an absent or malformed tasks list means no roles, not all roles", () => {
  // The safe direction: a missing tasks array must not read as full access. Meta omits
  // the field in some responses, and defaulting it open would skip the check entirely.
  assert.deepEqual(missingTasks(undefined), ["CREATE_CONTENT", "MANAGE"]);
  assert.deepEqual(missingTasks(null), ["CREATE_CONTENT", "MANAGE"]);
  assert.deepEqual(missingTasks("CREATE_CONTENT"), ["CREATE_CONTENT", "MANAGE"]);
});
