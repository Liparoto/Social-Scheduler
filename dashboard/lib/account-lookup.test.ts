import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lookupEndpoint,
  lookupUnavailableReason,
  parseLookup,
  supportsIdLookup,
} from "./account-lookup.ts";

// graphBase is the Instagram-Login host here — the path on which the IG lookup works.
const VERSIONS = {
  graphVersion: "v25.0",
  threadsApiVersion: "v1.0",
  graphBase: "https://graph.instagram.com",
};
const FACEBOOK_LOGIN = { ...VERSIONS, graphBase: "https://graph.facebook.com" };
const TOKEN = "THQ_pretend_this_is_a_real_token_0123456789";

// ---- which platforms offer a lookup at all --------------------------------------

test("only the three Meta platforms can look up an id from a token", () => {
  assert.equal(supportsIdLookup("instagram"), true);
  assert.equal(supportsIdLookup("threads"), true);
  assert.equal(supportsIdLookup("facebook"), true);
  // TikTok's id arrives with its OAuth callback, Discord has no id field at all, and a
  // Telegram chat id is genuinely not derivable from the bot token — someone has to
  // message the bot first. Offering a button that cannot work is worse than no button.
  assert.equal(supportsIdLookup("tiktok"), false);
  assert.equal(supportsIdLookup("discord"), false);
  assert.equal(supportsIdLookup("telegram"), false);
  assert.equal(supportsIdLookup("nonsense"), false);
});

// ---- endpoint construction ------------------------------------------------------

test("each platform reads identity from its own host", () => {
  // These three hosts are NOT interchangeable — worker/clients.py:24 and the Threads
  // note at worker/graph_api.py:703 say the same thing. graph.facebook.com does not
  // answer for an Instagram-Login token, and Threads is versioned independently.
  assert.match(lookupEndpoint("instagram", VERSIONS)!.url, /^https:\/\/graph\.instagram\.com\/me\?/);
  assert.match(lookupEndpoint("threads", VERSIONS)!.url, /^https:\/\/graph\.threads\.net\/v1\.0\/me\?/);
  assert.match(lookupEndpoint("facebook", VERSIONS)!.url, /^https:\/\/graph\.facebook\.com\/v25\.0\/me\/accounts\?/);
});

test("the version comes from config, so it is not pinned in a second place", () => {
  const url = lookupEndpoint("facebook", { ...VERSIONS, graphVersion: "v26.0" })!.url;
  assert.match(url, /\/v26\.0\//);
});

test("the token is never part of the URL", () => {
  // Verified against the live API (2026-08-23): Meta accepts the token as an
  // Authorization: Bearer header. A URL can end up in a proxy log or an error report;
  // a header is far less likely to. If this ever regresses to a query param, the token
  // starts travelling somewhere it was never meant to go.
  for (const platform of ["instagram", "threads", "facebook"]) {
    const spec = lookupEndpoint(platform, VERSIONS)!;
    assert.ok(!spec.url.includes("access_token"), `${platform} put the token in the URL`);
  }
});

test("a platform with no lookup has no endpoint", () => {
  assert.equal(lookupEndpoint("discord", VERSIONS), null);
});

// ---- parsing the good case ------------------------------------------------------

test("Instagram and Threads return exactly one account", () => {
  // Shape confirmed live 2026-08-23: {"id": "...", "username": "liparoto"}
  const result = parseLookup("threads", 200, { id: "27869507045998853", username: "liparoto" }, TOKEN);
  assert.deepEqual(result, {
    ok: true,
    accounts: [{ id: "27869507045998853", name: "liparoto", isHandle: true }],
  });
});

test("Facebook returns a list, because a user token can manage several Pages", () => {
  const body = { data: [{ id: "111", name: "Advantage Physical Therapy" }, { id: "222", name: "Side Project" }] };
  const result = parseLookup("facebook", 200, body, TOKEN);
  assert.deepEqual(result, {
    ok: true,
    accounts: [
      // isHandle false: a Page has a display name, not an @-handle.
      { id: "111", name: "Advantage Physical Therapy", isHandle: false },
      { id: "222", name: "Side Project", isHandle: false },
    ],
  });
});

test("a numeric id from Meta is normalised to a string", () => {
  // JSON numbers this large lose precision as JS doubles. Meta sends ids as strings, but
  // if one ever arrives unquoted, String() it BEFORE it can be rounded into a different
  // account id. 27869507045998853 is past Number.MAX_SAFE_INTEGER.
  const result = parseLookup("threads", 200, { id: "27869507045998853", username: "x" }, TOKEN);
  assert.equal((result as { accounts: { id: string }[] }).accounts[0].id, "27869507045998853");
});

// ---- parsing the failure cases --------------------------------------------------

test("a 190 cannot tell a bad token from the wrong platform, and says so", () => {
  // Probed live 2026-08-23: a VALID Threads token sent to graph.instagram.com returns
  // byte-identical 401/OAuthException/code 190 to a garbage token. Blaming the token
  // alone would send someone off regenerating a token that was fine all along.
  const body = {
    error: { message: "Invalid OAuth access token - Cannot parse access token", type: "OAuthException", code: 190 },
  };
  const result = parseLookup("instagram", 401, body, TOKEN);
  assert.equal(result.ok, false);
  const error = (result as { error: string }).error;
  assert.match(error, /expired|invalid/i);
  assert.match(error, /Instagram/, "must name the platform that was actually tried");
});

test("a working Facebook token that manages no Pages gets its own explanation", () => {
  // An empty list is a 200. Treating it as success hands back zero accounts and an
  // empty dropdown, which reads like a broken feature rather than a missing permission.
  const result = parseLookup("facebook", 200, { data: [] }, TOKEN);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /pages_show_list/);
});

test("a 200 with no id is a failure, not an account called undefined", () => {
  const result = parseLookup("threads", 200, { something_else: true }, TOKEN);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /unexpected|could not/i);
});

test("Meta's own message is passed through so nothing is swallowed", () => {
  const body = { error: { message: "Application request limit reached", type: "OAuthException", code: 4 } };
  const result = parseLookup("threads", 400, body, TOKEN);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /Application request limit reached/);
});

test("the token never survives into a passed-through error message", () => {
  // Defence in depth. Meta has no reason to echo a token back, but this module is one of
  // the few places one is held in memory, and an error string is the most likely thing
  // to reach a log, a screenshot, or a bug report. CLAUDE.md: never log credentials.
  //
  // Code 4 (not 190) on purpose: that is the branch that relays Meta's own wording, so
  // it is the only branch where a token COULD travel. The 190 branch is covered below.
  const body = { error: { message: `Invalid token ${TOKEN} supplied`, type: "OAuthException", code: 4 } };
  const result = parseLookup("threads", 400, body, TOKEN);
  assert.equal(result.ok, false);
  const error = (result as { error: string }).error;
  assert.ok(!error.includes(TOKEN), "the token leaked into the error message");
  assert.match(error, /\[token\]/);
});

test("the rejected-token branch relays none of Meta's text, so it cannot leak either", () => {
  // This branch replaces Meta's message rather than quoting it. That is what makes it
  // leak-proof, so it is worth pinning: if it is ever changed to include the raw
  // message, it must go through scrub() first.
  const body = { error: { message: `bad token ${TOKEN}`, type: "OAuthException", code: 190 } };
  const result = parseLookup("threads", 401, body, TOKEN);
  assert.equal(result.ok, false);
  assert.ok(!(result as { error: string }).error.includes(TOKEN));
});

test("an unknown platform is refused rather than guessed at", () => {
  const result = parseLookup("myspace", 200, { id: "1" }, TOKEN);
  assert.equal(result.ok, false);
});

// ---- which login path this install is on ----------------------------------------

test("the Instagram lookup declines on the Facebook-Login path instead of guessing", () => {
  // worker/clients.py:46 resolves Instagram's host from META_GRAPH_BASE, whose default is
  // graph.facebook.com (.env.example:71) — the Facebook-Login path. There the credential
  // is a FACEBOOK user token and the IG id lives on a linked Page, not on /me.
  //
  // The tempting "fix" is to follow META_GRAPH_BASE. That is the WORST option available:
  // graph.facebook.com/me?fields=id,username answers with the Facebook user's own id, a
  // real-looking number that is not an Instagram id, and it would be filled in and saved
  // without a murmur. Declining loudly is the only safe behaviour.
  const reason = lookupUnavailableReason("instagram", FACEBOOK_LOGIN);
  assert.ok(reason, "must decline rather than return a Facebook user id as an IG id");
  assert.match(reason!, /instagram_business_account/, "must name the call that does work");
});

test("the Instagram lookup runs normally on the Instagram-Login path", () => {
  assert.equal(lookupUnavailableReason("instagram", VERSIONS), null);
});

test("a trailing slash on the host is not treated as a different host", () => {
  const reason = lookupUnavailableReason("instagram", {
    ...VERSIONS,
    graphBase: "https://graph.instagram.com/",
  });
  assert.equal(reason, null);
});

test("Threads and Facebook are unaffected by the host setting", () => {
  // Both pin their own host (worker/clients.py:24) and never consult META_GRAPH_BASE.
  assert.equal(lookupUnavailableReason("threads", FACEBOOK_LOGIN), null);
  assert.equal(lookupUnavailableReason("facebook", FACEBOOK_LOGIN), null);
});

// ---- pagination and token-shape mix-ups -----------------------------------------

test("the Pages request asks for more than Meta's default page size", () => {
  // Without an explicit limit, /me/accounts returns Meta's default first page. A missing
  // Page then reads as "the token does not administer it", which points at permissions
  // and sends someone to fix a scope that was never wrong.
  assert.match(lookupEndpoint("facebook", VERSIONS)!.url, /[?&]limit=100(&|$)/);
});

test("a Page token sent to the Pages list is explained, not relayed as Meta's gibberish", () => {
  // Meta's own words are "(#100) Tried accessing nonexisting field (accounts) on node type
  // (Page)". Somebody holding the CORRECT permanent Page token is the most likely person
  // to try this, since that is the token the channel actually stores.
  // BOTH spellings. The first is what the live API actually returned when probed on
  // 2026-08-24; the second is what Meta's documentation shows. Matching only the
  // documented one is a bug that unit tests cannot catch, because the fixture would be
  // wrong in exactly the same way as the code.
  const messages = [
    "(#100) Tried accessing nonexisting field (accounts)",
    "(#100) Tried accessing nonexisting field (accounts) on node type (Page)",
  ];
  for (const message of messages) {
    const body = { error: { message, type: "OAuthException", code: 100 } };
    const result = parseLookup("facebook", 400, body, TOKEN);
    assert.equal(result.ok, false, message);
    const error = (result as { error: string }).error;
    assert.match(error, /Page token/, message);
    assert.match(error, /USER token/, message);
    assert.ok(!error.includes("nonexisting field"), "Meta's wording should not be relayed");
  }
});
