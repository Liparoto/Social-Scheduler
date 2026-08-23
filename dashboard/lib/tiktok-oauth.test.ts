import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIKTOK_SCOPES,
  authorizeUrl,
  challengeFor,
  createVerifier,
} from "./tiktok-oauth";

test("the verifier is long enough and url-safe", () => {
  const v = createVerifier();
  assert.ok(v.length >= 43 && v.length <= 128, `verifier length ${v.length} is out of RFC range`);
  assert.match(v, /^[A-Za-z0-9\-._~]+$/);
});

test("the challenge is the unpadded base64url sha256 of the verifier", () => {
  // The worked example from RFC 7636 Appendix B — checking our own arithmetic against a
  // known-good vector rather than against ourselves.
  assert.equal(
    challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("the challenge carries no padding or non-url-safe characters", () => {
  const challenge = challengeFor(createVerifier());
  assert.doesNotMatch(challenge, /[=+/]/);
});

test("two verifiers are never the same", () => {
  assert.notEqual(createVerifier(), createVerifier());
});

test("the authorize url carries every parameter TikTok requires", () => {
  const url = new URL(
    authorizeUrl({
      clientKey: "key",
      redirectUri: "http://localhost:3939/api/channels/tiktok/callback",
      state: "st",
      challenge: "ch",
      scopes: TIKTOK_SCOPES,
    }),
  );
  assert.equal(url.origin + url.pathname, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(url.searchParams.get("client_key"), "key");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "ch");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://localhost:3939/api/channels/tiktok/callback",
  );
});

test("the requested scopes cover delivery and metrics but never direct posting", () => {
  const scope = new URL(
    authorizeUrl({
      clientKey: "key",
      redirectUri: "http://localhost:3939/cb",
      state: "st",
      challenge: "ch",
      scopes: TIKTOK_SCOPES,
    }),
  ).searchParams.get("scope");
  assert.equal(scope, "user.info.basic,video.upload,video.list");
  // video.publish is the direct-post scope. It cannot be granted without TikTok's app
  // audit, and asking for a scope the app does not hold fails the whole authorisation
  // rather than degrading to the scopes it does hold.
  assert.doesNotMatch(scope ?? "", /video\.publish/);
});
