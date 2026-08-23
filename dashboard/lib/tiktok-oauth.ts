import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE helpers for connecting a TikTok account.
 *
 * TikTok Desktop-type apps require PKCE and permit an `http://localhost` redirect URI;
 * Web-type apps are forced to HTTPS. Registering as Desktop is the whole reason this tool
 * can run an OAuth flow at all without owning a domain or exposing a tunnel — so the app
 * type is not an incidental setting, it is load-bearing (see docs/tiktok-setup.md).
 */

export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";

/**
 * What we ask the creator to grant.
 *
 * `video.publish` — the DIRECT-POST scope — is deliberately absent. It cannot be granted
 * until TikTok audits the app, and this install cannot pass that audit: the review requires
 * a public website with a privacy policy and terms, and explicitly excludes private-use
 * tools. Asking for a scope the app does not hold fails the entire authorisation rather
 * than quietly dropping it, so listing it "just in case" would break connecting outright.
 */
export const TIKTOK_SCOPES = ["user.info.basic", "video.upload", "video.list"] as const;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A fresh PKCE verifier: 48 random bytes as base64url → 64 characters.
 *
 * base64url IS right here (unlike the challenge above): TikTok requires the unreserved
 * set [A-Z] [a-z] [0-9] "-" "." "_" "~" and a length of 43–128, and base64url output is a
 * subset of that at 64 characters.
 */
export function createVerifier(): string {
  return base64url(randomBytes(48));
}

/**
 * The PKCE code challenge — SHA-256 of the verifier, **hex encoded**.
 *
 * NOT base64url. RFC 7636 mandates base64url and every other OAuth provider uses it;
 * TikTok does not. Their Desktop Login Kit doc says it outright — "hashing the code
 * verifier using hex encoding of SHA256" — and their example ends in
 * `.toString(CryptoJS.enc.Hex)`.
 *
 * Getting this wrong fails only at the very END of the flow: authorization succeeds, the
 * user approves, and the token exchange dies with "Code verifier or code challenge is
 * invalid." Do not "correct" this back to base64url to match the RFC; the RFC is not what
 * is on the other end of the wire.
 */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("hex");
}

export function authorizeUrl(opts: {
  clientKey: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: readonly string[];
}): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("client_key", opts.clientKey);
  // Comma-separated, not space-separated — TikTok differs from the OAuth norm here.
  url.searchParams.set("scope", opts.scopes.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
