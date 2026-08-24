import "server-only";

import { platformLabel, supportsIdLookup } from "./platforms";

export { supportsIdLookup };

/**
 * Read an account id back from the access token that already grants access to it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every Meta channel needs two things pasted in: a token and an account id. The token
 * you have — you just generated it. The id is a bare 17-digit number with no label on
 * it, and the failure it causes is the worst kind: docs/meta-setup.md:304 records that
 * an Instagram id used on a Threads channel returns "Object with ID … does not exist",
 * which reads exactly like a broken token. Somebody then regenerates a token that was
 * never the problem.
 *
 * The token already identifies the account. Asking the platform who it belongs to is a
 * single call, so the dashboard asks instead of making somebody find the number.
 *
 * WHY THE DASHBOARD MAKES THIS CALL AT ALL
 * ----------------------------------------
 * app/api/channels/[id]/avatar/refresh/route.ts is emphatic that the worker owns every
 * platform call and the DB is the contract between them. That rule is about publishing
 * and metrics for channels that already exist. This runs BEFORE any channel row exists,
 * so there is no row for the worker to pick up and nothing to poll — the same reason
 * the TikTok OAuth callback route calls TikTok directly. The DB is untouched here; this
 * only ever hands values back to a form the owner has not saved yet.
 *
 * `server-only` above is the enforcement of CLAUDE.md's "never call an API from the
 * frontend": importing this from a client component fails the build rather than quietly
 * shipping a token-bearing request from the browser.
 */

export type FoundAccount = {
  id: string;
  name: string | null;
  /**
   * True when `name` is an @-handle (Instagram and Threads return `username`), false when
   * it is a display name (a Facebook Page returns `name`). The UI renders "@liparoto" but
   * "LFK Events" — writing "@LFK Events" would invent a handle that does not exist. Only
   * the parser can tell these apart, because only it knows which JSON field it read.
   */
  isHandle: boolean;
};

export type LookupResult =
  | { ok: true; accounts: FoundAccount[] }
  | { ok: false; error: string };

export type GraphVersions = {
  graphVersion: string;
  threadsApiVersion: string;
  /** META_GRAPH_BASE — see lookupUnavailableReason for why this gates the IG lookup. */
  graphBase: string;
};

/** The one host on which an Instagram token identifies the Instagram account itself. */
const INSTAGRAM_LOGIN_HOST = "https://graph.instagram.com";

/**
 * Why this platform's lookup cannot run on THIS install, or null if it can.
 *
 * Only Instagram has such a reason, and it is worth spelling out because the obvious fix
 * is wrong. worker/clients.py:46 resolves Instagram's host from META_GRAPH_BASE, which
 * defaults to graph.facebook.com (.env.example:71). That default means the install is on
 * the Facebook-Login path, where the stored "Instagram" credential is a FACEBOOK user
 * token and the IG id is reached through a Page
 * (GET /{page-id}?fields=instagram_business_account), not through /me.
 *
 * So there are three possible behaviours here, and only one is safe:
 *   1. Keep calling graph.instagram.com  -> a valid token is rejected as "invalid or
 *      expired", sending someone to regenerate a token that was fine. (The bug as found.)
 *   2. Follow META_GRAPH_BASE blindly    -> graph.facebook.com/me?fields=id,username
 *      answers happily with the FACEBOOK USER's id. It is a plausible-looking number that
 *      is not an Instagram id at all, and it would be filled in and saved without
 *      complaint. Silently wrong beats loudly wrong every time — this is the worst option.
 *   3. Decline, and say exactly why.     <- this.
 *
 * Option 3 is not the permanent answer; discovering the id via the Page is. But an honest
 * "I can't do this here, and here is the call that does" is strictly better than either
 * failing for the wrong reason or inventing an id.
 */
export function lookupUnavailableReason(
  platform: string,
  versions: GraphVersions
): string | null {
  if (platform !== "instagram") return null;
  const base = versions.graphBase.replace(/\/+$/, "");
  if (base === INSTAGRAM_LOGIN_HOST) return null;
  return (
    `This install is on the Facebook-Login path (META_GRAPH_BASE is ${base}), where an ` +
    `Instagram id is not readable from the token — it belongs to a linked Page. Look it ` +
    `up with:\n\n` +
    `    GET /{page-id}?fields=instagram_business_account\n\n` +
    `and paste the id it returns. (On the Instagram-Login path — META_GRAPH_BASE set to ` +
    `${INSTAGRAM_LOGIN_HOST} — this button works directly.)`
  );
}

/** A lookup call: where to ask, and whether the answer is one account or a list. */
export type LookupEndpoint = { url: string; isList: boolean };

/**
 * Does this platform answer with a LIST of accounts rather than a single one?
 *
 * A property of the platform, not of any particular URL: only Facebook's /me/accounts
 * returns several, because only a Facebook user token can administer several Pages.
 * Kept separate from lookupEndpoint so parsing a response never needs a config it has no
 * business knowing about — an earlier version fabricated one with empty version strings
 * purely to read this flag back off the URL builder.
 */
function returnsList(platform: string): boolean {
  return platform === "facebook";
}

/**
 * The three hosts are NOT interchangeable, and swapping them is a real failure mode
 * rather than a style choice — worker/clients.py:24 keeps the same split, and
 * worker/graph_api.py:703 notes Threads versions its API independently of the
 * Instagram/Facebook epoch (v1.0 vs v25.0+), which is why two version values exist.
 */
export function lookupEndpoint(
  platform: string,
  versions: GraphVersions
): LookupEndpoint | null {
  switch (platform) {
    case "instagram":
      // Instagram-Login tokens answer on graph.instagram.com and nowhere else. Note this
      // host is unversioned in the path, matching the call in docs/meta-setup.md.
      return { url: "https://graph.instagram.com/me?fields=id,username", isList: false };
    case "threads":
      return {
        url: `https://graph.threads.net/${versions.threadsApiVersion}/me?fields=id,username`,
        isList: false,
      };
    case "facebook":
      // /me/accounts, not /me: the pasted token is a USER token, and what the channel
      // actually needs is one of the PAGE ids that user administers. A user token's own
      // id is not a Page id and would fail at publish time, not here.
      // limit=100 because /me/accounts pages at Meta's default (25) otherwise, and a
      // truncated list is indistinguishable from "the token does not manage that Page" —
      // which points at permissions and sends someone to fix a scope that was never wrong.
      return {
        url: `https://graph.facebook.com/${versions.graphVersion}/me/accounts?fields=id,name&limit=100`,
        isList: true,
      };
    default:
      return null;
  }
}

/**
 * Remove the token from anything on its way to a screen or a log.
 *
 * Meta has no reason to echo a token back and, in probing, never did. This is defence in
 * depth: an error string is the single most likely thing here to end up in a screenshot,
 * a bug report, or a terminal someone pastes into a chat — which is the exact accident
 * this whole feature exists to stop needing.
 */
function scrub(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join("[token]");
}

function readAccount(raw: unknown): FoundAccount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = record.id;
  if (id === undefined || id === null || id === "") return null;
  // String() BEFORE anything else can touch it. Ids run past Number.MAX_SAFE_INTEGER
  // (27869507045998853 is a real one), so a JSON number here would already be rounded —
  // silently producing a valid-looking id for a different account.
  const handle = typeof record.username === "string" ? record.username : null;
  const displayName = typeof record.name === "string" ? record.name : null;
  return { id: String(id), name: handle ?? displayName, isHandle: handle !== null };
}

/**
 * Turn a raw response into either accounts or a sentence explaining what to do.
 *
 * Kept separate from the network call so the translations below are tested against the
 * response shapes actually observed from Meta, rather than the ones we assume.
 */
export function parseLookup(
  platform: string,
  status: number,
  body: unknown,
  token: string
): LookupResult {
  const endpointExists = supportsIdLookup(platform);
  if (!endpointExists) {
    return { ok: false, error: `${platformLabel(platform)} has no account-id lookup.` };
  }

  const label = platformLabel(platform);
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const metaError = record.error as Record<string, unknown> | undefined;

  if (metaError || status >= 400) {
    const rawMessage = typeof metaError?.message === "string" ? metaError.message : "";
    const code = metaError?.code;

    if (code === 190 || status === 401) {
      // Probed live 2026-08-23: a VALID Threads token sent to graph.instagram.com returns
      // a byte-identical 401/OAuthException/190 to outright garbage. The response cannot
      // distinguish the two, so neither can this message — naming only one cause would
      // send somebody to regenerate a perfectly good token.
      return {
        ok: false,
        error:
          `That token was rejected for ${label}. Either it is invalid or expired, or it ` +
          `belongs to a different platform — a valid token for another network returns ` +
          `this exact same error. Check the platform selector above matches the token, ` +
          `then try a freshly generated one.`,
      };
    }

    // A PAGE token sent to /me/accounts answers "(#100) Tried accessing nonexisting field
    // (accounts)". Relayed verbatim that is unreadable, and it hides a simple cause: the
    // Facebook lookup needs the USER token, because only a user token knows which Pages
    // exist. Somebody holding the correct permanent Page token is especially likely to
    // try it, since that is the token the channel actually stores.
    //
    // Matched on "nonexisting field (accounts)" and NOT on the "on node type (Page)"
    // suffix that Meta's documentation shows: probed live 2026-08-24, the real response
    // omits that suffix entirely. An earlier version of this check required it, so it
    // never fired against the actual API while its unit test — written against the
    // documented wording rather than a real response — passed happily.
    if (platform === "facebook" && code === 100 && /nonexisting field \(accounts\)/i.test(rawMessage)) {
      return {
        ok: false,
        error:
          `That looks like a Page token. Listing Pages needs the USER token from the ` +
          `Graph API Explorer — a Page token only knows about itself. (The Page token is ` +
          `the right thing to store in Access token; it is just not what finds the id.)`,
      };
    }

    return {
      ok: false,
      error: rawMessage
        ? `${label} refused the lookup: ${scrub(rawMessage, token)}`
        : `${label} refused the lookup (HTTP ${status}).`,
    };
  }

  if (returnsList(platform)) {
    const data = Array.isArray(record.data) ? record.data : null;
    if (data === null) {
      return { ok: false, error: `${label} returned an unexpected response with no account list.` };
    }
    const accounts = data.map(readAccount).filter((a): a is FoundAccount => a !== null);
    if (accounts.length === 0) {
      // An empty list arrives as a 200. Reporting success with zero accounts renders an
      // empty dropdown, which looks like a broken feature instead of a missing scope.
      return {
        ok: false,
        error:
          `That token works, but it does not administer any Facebook Pages. Generate it ` +
          `with the pages_show_list permission (and pages_manage_posts, which publishing ` +
          `needs later), then try again.`,
      };
    }
    return { ok: true, accounts };
  }

  const account = readAccount(record);
  if (!account) {
    return { ok: false, error: `${label} returned an unexpected response — could not find an id in it.` };
  }
  return { ok: true, accounts: [account] };
}

/**
 * Ask a platform which account a token belongs to.
 *
 * The token travels as an Authorization: Bearer header, verified working against the
 * live API on 2026-08-23. A query parameter also works and is what docs/meta-setup.md
 * shows for a one-off curl, but a URL is the part of a request that ends up in proxy
 * logs and error reports, so it is the wrong place for a credential the server sends on
 * somebody's behalf.
 */
export async function lookupAccounts(
  platform: string,
  token: string,
  versions: GraphVersions,
  fetchImpl: typeof fetch = fetch
): Promise<LookupResult> {
  const spec = lookupEndpoint(platform, versions);
  if (!spec) {
    return { ok: false, error: `${platformLabel(platform)} has no account-id lookup.` };
  }

  // Checked BEFORE the request, not after: on the Facebook-Login path the call would
  // either fail for a misleading reason or succeed with the wrong account's id.
  const unavailable = lookupUnavailableReason(platform, versions);
  if (unavailable) return { ok: false, error: unavailable };

  let status: number;
  let body: unknown;
  try {
    const response = await fetchImpl(spec.url, {
      headers: { Authorization: `Bearer ${token}` },
      // No id lookup should hang a form. Meta answers this in well under a second.
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    status = response.status;
    body = await response.json().catch(() => ({}));
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
    return {
      ok: false,
      error: `The request to ${platformLabel(platform)} ${reason}. Check your internet connection and try again.`,
    };
  }

  return parseLookup(platform, status, body, token);
}
