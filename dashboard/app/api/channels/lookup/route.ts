import { NextResponse } from "next/server";
import { lookupAccounts, supportsIdLookup } from "@/lib/account-lookup";
import { config } from "@/lib/config";

export const runtime = "nodejs";

/**
 * Resolve the account id(s) a pasted access token belongs to.
 *
 * Setup-time only, and deliberately stateless: it reads nothing from the database and
 * writes nothing to it. The answer goes straight back to the unsaved Add Channel form,
 * where the owner still has to press Save. Nothing here can alter an existing channel.
 *
 * The token arrives in the POST body rather than the query string on purpose — a query
 * string is logged by proxies and shows up in browser history; a body is not. It is used
 * for one outbound call and then goes out of scope. It is never logged, never persisted,
 * and never echoed back in the response, including in error paths (see lib/account-lookup.ts).
 */
export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const { platform, token } = (payload ?? {}) as { platform?: unknown; token?: unknown };

  if (typeof platform !== "string" || !supportsIdLookup(platform)) {
    return NextResponse.json(
      { error: "That platform cannot look up an account id from a token." },
      { status: 400 }
    );
  }

  if (typeof token !== "string" || token.trim() === "") {
    return NextResponse.json({ error: "Paste an access token first." }, { status: 400 });
  }

  const result = await lookupAccounts(platform, token.trim(), {
    graphVersion: config.graphVersion,
    threadsApiVersion: config.threadsApiVersion,
    graphBase: config.graphBase,
  });

  if (!result.ok) {
    // 200 with an error field, not a 4xx: the lookup itself behaved correctly, and the
    // outcome is something for the person to read and act on — a rejected token is not a
    // malformed request. Keeping it a 200 also stops it from surfacing as a scary red
    // entry in the browser console during ordinary setup.
    return NextResponse.json({ ok: false, error: result.error });
  }

  return NextResponse.json({ ok: true, accounts: result.accounts });
}
