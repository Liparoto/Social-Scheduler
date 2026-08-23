import { NextRequest, NextResponse } from "next/server";
import { upsertOAuthChannel } from "@/lib/queries";
import { config, tiktokCredentials } from "@/lib/config";

export const runtime = "nodejs";

const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_INFO_URL = "https://open.tiktokapis.com/v2/user/info/";

/** Back to /channels with a message, never a rendered error page: an OAuth error response
 *  can echo the authorization code, and a code in the address bar is a credential on
 *  screen. */
function back(req: NextRequest, params: Record<string, string>) {
  const url = new URL("/channels", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.delete("tiktok_pkce_verifier");
  res.cookies.delete("tiktok_oauth_state");
  return res;
}

/**
 * Step two: TikTok sends the creator back with a code; swap it for tokens and create the
 * channel.
 *
 * Everything here is server-side on purpose. The client secret never reaches the browser,
 * and neither does the code — this route runs the exchange itself rather than handing the
 * browser anything to post.
 */
export async function GET(req: NextRequest) {
  // Read live, for the same reason as the authorize route: the key that started the
  // flow must be the key that finishes it, or the exchange fails after the user has
  // already approved.
  const { clientKey, clientSecret } = tiktokCredentials();
  if (!clientKey || !clientSecret) {
    return back(req, { tiktok_error: "TIKTOK_CLIENT_KEY/SECRET are not set in .env." });
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const denied = req.nextUrl.searchParams.get("error");
  if (denied) {
    return back(req, { tiktok_error: `TikTok declined the connection (${denied}).` });
  }

  const expectedState = req.cookies.get("tiktok_oauth_state")?.value;
  const verifier = req.cookies.get("tiktok_pkce_verifier")?.value;
  // A mismatched state is the CSRF check: without it, someone else's authorization code
  // could be walked into this install's database.
  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return back(req, {
      tiktok_error: "That TikTok sign-in didn't match this browser session. Try Connect again.",
    });
  }

  const redirectUri = new URL("/api/channels/tiktok/callback", req.nextUrl.origin).toString();

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    const tokens = await tokenRes.json();
    // The body is the success signal — TikTok answers a refusal with HTTP 200 — but THIS
    // endpoint reports failure in OAuth2 style, flat: {error: "invalid_request",
    // error_description: "...", log_id: "..."}. Every other v2 endpoint nests
    // {error: {code, message}}. Reading .error.code here finds undefined on a string and
    // silently discards the one thing worth showing, which is exactly what happened.
    const flatError = typeof tokens?.error === "string" ? tokens.error : null;
    const nestedError =
      tokens?.error && typeof tokens.error === "object" && tokens.error.code !== "ok"
        ? tokens.error.code
        : null;
    const failure = flatError ?? nestedError;
    if (failure) {
      // error_description is TikTok's own prose about what was wrong ("Redirect_uri is
      // not matched…"), and carries no credential — showing it is the difference between
      // a fixable message and a shrug.
      const detail = tokens?.error_description ?? tokens?.error?.message ?? "";
      return back(req, {
        tiktok_error: `TikTok refused the sign-in: ${failure}${detail ? ` — ${detail}` : ""}`,
      });
    }
    if (!tokens?.access_token || !tokens?.refresh_token) {
      return back(req, {
        tiktok_error:
          "TikTok accepted the sign-in but returned no tokens. Try Connect again.",
      });
    }

    // Name the channel after the account, so the Channels page shows who it posts as
    // rather than an open_id nobody recognises.
    let displayName = "TikTok account";
    try {
      const infoRes = await fetch(`${USER_INFO_URL}?fields=open_id,display_name`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const info = await infoRes.json();
      displayName = info?.data?.user?.display_name || displayName;
    } catch {
      // A failed name lookup must not throw away a good token — the channel is renameable
      // and the connection is the hard part.
    }

    const now = Date.now();
    const iso = (seconds: number) => new Date(now + seconds * 1000).toISOString();
    const { id, created } = upsertOAuthChannel({
      platform: "tiktok",
      account_name: displayName,
      timezone: config.defaultTimezone,
      remote_account_id: tokens.open_id ?? undefined,
      access_token: tokens.access_token,
      // Both expiries are stored now: the access token dies in 24h and the worker refreshes
      // it, and the refresh token's own 365-day clock is what preflight warns about.
      token_expires_at: iso(Number(tokens.expires_in ?? 86400)),
      refresh_token: tokens.refresh_token,
      refresh_token_expires_at: iso(Number(tokens.refresh_expires_in ?? 31536000)),
    });
    return back(req, {
      tiktok_connected: String(id),
      // Reconnecting is routine — the refresh token expires yearly — so the banner should
      // say which happened rather than implying a new channel every time.
      tiktok_reconnected: created ? "0" : "1",
    });
  } catch {
    // Deliberately no error detail: a fetch failure's message can carry the request, and
    // the request body holds the client secret and the code.
    return back(req, { tiktok_error: "Couldn't reach TikTok to finish signing in." });
  }
}
