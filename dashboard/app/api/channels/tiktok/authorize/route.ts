import { NextRequest, NextResponse } from "next/server";
import { TIKTOK_SCOPES, authorizeUrl, challengeFor, createVerifier } from "@/lib/tiktok-oauth";
import { randomBytes } from "node:crypto";
import { tiktokCredentials } from "@/lib/config";

export const runtime = "nodejs";

/**
 * Step one of connecting a TikTok account: send the creator to TikTok.
 *
 * The PKCE verifier and the CSRF state live in httpOnly cookies for the length of one
 * redirect. A cookie rather than a table because the value is meaningless thirty seconds
 * later — a schema row for it would outlive its purpose and need cleaning up.
 *
 * The redirect URI is built from the request's own origin so it follows whatever port the
 * dashboard is running on, but TikTok matches it against the app's REGISTERED value, so
 * docs/tiktok-setup.md names the exact string to register.
 */
export function GET(req: NextRequest) {
  // Read live, not from a snapshot taken at import: swapping a production key for a
  // sandbox one is exactly when this route gets used, and a cached key fails silently.
  const { clientKey } = tiktokCredentials();
  if (!clientKey) {
    // Fail with an explanation rather than sending a malformed URL to TikTok, which
    // answers with an opaque error page that says nothing about .env.
    return NextResponse.json(
      {
        error:
          "TIKTOK_CLIENT_KEY is not set in .env. Register your own TikTok app " +
          "(see docs/tiktok-setup.md), then add TIKTOK_CLIENT_KEY and " +
          "TIKTOK_CLIENT_SECRET and restart the dashboard.",
      },
      { status: 400 },
    );
  }

  const verifier = createVerifier();
  const state = randomBytes(16).toString("hex");
  const redirectUri = new URL("/api/channels/tiktok/callback", req.nextUrl.origin).toString();

  const res = NextResponse.redirect(
    authorizeUrl({
      clientKey,
      redirectUri,
      state,
      challenge: challengeFor(verifier),
      scopes: TIKTOK_SCOPES,
    }),
  );
  // httpOnly: the verifier is half of the PKCE proof — script on the page must never be
  // able to read it. sameSite 'lax' so the cookie survives TikTok's redirect back.
  const options = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 600 };
  res.cookies.set("tiktok_pkce_verifier", verifier, options);
  res.cookies.set("tiktok_oauth_state", state, options);
  return res;
}
