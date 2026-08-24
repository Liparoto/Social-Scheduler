import { NextResponse } from "next/server";
import { listPages, selectPage, type MetaAppConfig } from "@/lib/facebook-connect";
import { config } from "@/lib/config";

export const runtime = "nodejs";

/**
 * Turn a short-lived Facebook USER token into a permanent Page token, without a terminal.
 *
 * Two actions rather than one, because a person picks a Page in between:
 *   list   — extend the token, return Pages as id + name only
 *   select — extend again, verify the chosen Page's token, return just that token
 *
 * The browser re-sends the token it already holds for the second call, so the EXTENDED
 * user token never leaves the server. See lib/facebook-connect.ts for why that matters:
 * a long-lived user token is more powerful than the Page token being created.
 *
 * Setup-time and stateless, like the id lookup: nothing is read from or written to the
 * database. The verified Page token goes back to an unsaved form, and saving it is still
 * a separate, deliberate act.
 */
export async function POST(req: Request) {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const { action, token, pageId } = (payload ?? {}) as {
    action?: unknown;
    token?: unknown;
    pageId?: unknown;
  };

  if (typeof token !== "string" || token.trim() === "") {
    return NextResponse.json({ error: "Paste your user token first." }, { status: 400 });
  }

  const metaConfig: MetaAppConfig = {
    graphVersion: config.graphVersion,
    appId: config.metaAppId,
    appSecret: config.metaAppSecret,
  };

  // A rejected token or a Page you lack rights on is a 200 with ok:false, not a 4xx: the
  // request was well-formed and the outcome is something to read and act on. Only a
  // malformed call is a 4xx.
  if (action === "list") {
    const result = await listPages(token.trim(), metaConfig);
    return NextResponse.json(result);
  }

  if (action === "select") {
    if (typeof pageId !== "string" || pageId.trim() === "") {
      return NextResponse.json({ error: "No Page was chosen." }, { status: 400 });
    }
    const result = await selectPage(token.trim(), pageId.trim(), metaConfig);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
