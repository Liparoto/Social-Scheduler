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

/** A fresh PKCE verifier. 48 random bytes → 64 base64url characters, inside RFC 7636's
 *  43–128 range. */
export function createVerifier(): string {
  return base64url(randomBytes(48));
}

/** S256: the unpadded base64url SHA-256 of the verifier. */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
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
