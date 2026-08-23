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

test("the challenge is the HEX sha256 of the verifier, not base64url", () => {
  // TikTok deviates from RFC 7636 here and requires hex. This test previously asserted
  // the RFC's own base64url vector — it passed, and the integration still failed at the
  // token exchange, because the RFC is not what is on the other end of the wire.
  assert.equal(
    challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "13d31e961a1ad8ec2f16b10c4c982e0876a878ad6df144566ee1894acb70f9c3",
  );
  // The base64url form of that same digest, which is what a well-meaning "fix" back to
  // the standard would produce. Pinned so that change fails loudly here.
  assert.notEqual(
    challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("the challenge is 64 lowercase hex characters", () => {
  assert.match(challengeFor(createVerifier()), /^[0-9a-f]{64}$/);
});

test("the verifier uses only the characters TikTok allows", () => {
  // TikTok's unreserved set: [A-Z] [a-z] [0-9] "-" "." "_" "~", length 43-128.
  assert.match(createVerifier(), /^[A-Za-z0-9\-._~]{43,128}$/);
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
