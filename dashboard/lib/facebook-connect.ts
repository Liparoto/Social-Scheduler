import "server-only";

/**
 * Connect a Facebook Page from the dashboard: short-lived user token in, permanent Page
 * token out.
 *
 * WHY THIS EXISTS
 * ---------------
 * A port of worker/exchange_token.py's Facebook flow, which works but lives in a terminal.
 * Asking somebody to run `python -m worker.exchange_token` in the middle of filling in a
 * form is the kind of seam that makes a tool feel unfinished, and this is setup — the one
 * moment a new install has no goodwill to spend.
 *
 * WHAT ACTUALLY GOES WRONG, AND WHY THIS IS NOT JUST AN EXCHANGE
 * --------------------------------------------------------------
 * From exchange_token.py's own header: Meta hands you a token that expires in about an
 * hour and does not say so. A Page token derived from a short-lived user token is
 * byte-indistinguishable from a permanent one — same shape, same successful reads, same
 * passing preflight — and then publishing fails that afternoon for reasons the error does
 * not explain. The exchange is three HTTP calls; the VERIFICATION is the part worth
 * porting carefully, so all five checks come across (see verifyPage / verifyPageToken).
 *
 * WHY THE EXTENDED USER TOKEN NEVER REACHES THE BROWSER
 * -----------------------------------------------------
 * A long-lived USER token is strictly more powerful than the Page token being set up: it
 * can enumerate and act on everything the person administers. So the flow is two requests
 * and the extend happens server-side inside each one:
 *
 *   list   — extend, return Pages as id + name only, NO tokens
 *   select — extend again, take only the chosen Page's token, verify it, return that
 *
 * Extending twice costs one extra HTTP call and is idempotent (fb_exchange_token on an
 * already-long-lived token returns a long-lived token). The alternative — extend once and
 * park it in a server-side session — adds state to an app that has none, and returning
 * every Page's token to the browser hands out credentials nobody asked for.
 */

export type MetaAppConfig = {
  graphVersion: string;
  appId: string;
  appSecret: string;
};

export type PageSummary = {
  id: string;
  name: string;
  /** Roles required to publish that this account lacks on this Page. Empty means fine. */
  missingTasks: string[];
};

export type ConnectError = { ok: false; error: string };
export type ListResult = { ok: true; pages: PageSummary[] } | ConnectError;
export type SelectResult =
  | { ok: true; pageId: string; name: string; pageToken: string }
  | ConnectError;

const TIMEOUT_MS = 20_000;

/** Publishing needs both. Mirrors exchange_token.py's run_facebook tasks check. */
const REQUIRED_TASKS = ["CREATE_CONTENT", "MANAGE"];

/** A Page token whose expires_at is 0 never expires. Anything else is the bug. */
const NEVER = 0;

/**
 * Strip a credential out of anything headed for a screen or a log.
 *
 * Deliberately takes every secret in play, not just the one that failed: this module
 * holds a short-lived token, a long-lived one, a Page token and the app secret at various
 * points, and an error string is the most likely of them all to be screenshotted.
 */
function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

class MetaError extends Error {}

/**
 * GET from the Graph API, turning Meta's error envelope into a readable message.
 *
 * Meta answers a rejected token with HTTP 400 and a JSON body that explains why, so
 * throwing on status alone would discard the only useful part — the same reasoning as
 * exchange_token.py's _get.
 */
async function metaGet(
  url: string,
  bearer: string,
  secrets: string[],
  fetchImpl: typeof fetch
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const why = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
    throw new MetaError(`The request to Meta ${why}. Check your connection and try again.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MetaError(
      `Meta returned ${response.status} with a non-JSON body. Try again in a moment.`
    );
  }

  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const error = record.error as Record<string, unknown> | undefined;
  if (error) {
    const message = typeof error.message === "string" ? error.message : "(no message)";
    throw new MetaError(`Meta rejected the request: ${scrub(message, secrets)} (code ${error.code})`);
  }
  return record;
}

/**
 * Short-lived USER token -> long-lived (~60 day) USER token.
 *
 * Safe to call on a token that is already long-lived, which is what makes the two-request
 * design above cheap: Meta simply returns a long-lived token again.
 */
export async function extendUserToken(
  shortLived: string,
  config: MetaAppConfig,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: shortLived,
  });
  // The app secret has to travel as a query parameter here — oauth/access_token takes no
  // other form of it. This is server-to-Meta over HTTPS and the URL is never logged or
  // returned; it is the one place in this module a secret is in a URL, and it is Meta's
  // API shape that requires it, not a choice.
  const data = await metaGet(
    `https://graph.facebook.com/${config.graphVersion}/oauth/access_token?${params}`,
    shortLived,
    [shortLived, config.appSecret],
    fetchImpl
  );
  const token = data.access_token;
  if (typeof token !== "string" || !token) {
    throw new MetaError("Meta returned no access_token for the extended user token.");
  }
  return token;
}

type RawPage = { id?: unknown; name?: unknown; access_token?: unknown; tasks?: unknown };

/**
 * Every Page this user administers.
 *
 * The Page tokens in this response inherit the lifetime of the user token used here —
 * which is exactly why callers must pass the EXTENDED token. Passing the short-lived one
 * yields Page tokens that look permanent and are not.
 */
async function fetchPages(
  extendedUserToken: string,
  config: MetaAppConfig,
  fetchImpl: typeof fetch
): Promise<RawPage[]> {
  const data = await metaGet(
    `https://graph.facebook.com/${config.graphVersion}/me/accounts` +
      `?fields=id,name,access_token,tasks&limit=100`,
    extendedUserToken,
    [extendedUserToken, config.appSecret],
    fetchImpl
  );
  return Array.isArray(data.data) ? (data.data as RawPage[]) : [];
}

/** Roles needed to publish that this account does not hold on the Page. */
export function missingTasks(tasks: unknown): string[] {
  const held = new Set(Array.isArray(tasks) ? tasks.map(String) : []);
  return REQUIRED_TASKS.filter((t) => !held.has(t));
}

function summarise(page: RawPage): PageSummary | null {
  if (typeof page.id !== "string" && typeof page.id !== "number") return null;
  return {
    id: String(page.id),
    name: typeof page.name === "string" ? page.name : "Unnamed Page",
    missingTasks: missingTasks(page.tasks),
  };
}

/** Step one: which Pages could this become? Returns no tokens by design. */
export async function listPages(
  userToken: string,
  config: MetaAppConfig,
  fetchImpl: typeof fetch = fetch
): Promise<ListResult> {
  const configError = appConfigError(config);
  if (configError) return { ok: false, error: configError };

  try {
    const extended = await extendUserToken(userToken, config, fetchImpl);
    const pages = (await fetchPages(extended, config, fetchImpl))
      .map(summarise)
      .filter((p): p is PageSummary => p !== null);

    if (pages.length === 0) {
      return {
        ok: false,
        error:
          "That token administers no Pages — either this account manages none, or the " +
          "token was generated without the pages_show_list permission. Check both in the " +
          "Graph API Explorer and generate a new token.",
      };
    }
    return { ok: true, pages };
  } catch (err) {
    return { ok: false, error: asMessage(err) };
  }
}

export type TokenInfo = {
  type?: unknown;
  scopes?: unknown;
  expires_at?: unknown;
  profile_id?: unknown;
};

/**
 * The four token checks, ported verbatim in spirit from exchange_token.py's
 * verify_page_token. Each maps to a failure seen in practice, and each message says what
 * to do rather than what went wrong. Pure, so every branch is testable without a network.
 *
 * Returns the problem, or null if the token is safe to store.
 */
export function verifyPageToken(info: TokenInfo, pageId: string): string | null {
  if (info.type !== "PAGE") {
    return (
      `That is a ${String(info.type ?? "unknown")} token, not a Page token. Page channels ` +
      `need a token derived from a Page — a user token reads fine here and then never ` +
      `publishes.`
    );
  }

  const scopes = Array.isArray(info.scopes) ? info.scopes.map(String) : [];
  if (!scopes.includes("pages_manage_posts")) {
    return (
      "The token is missing pages_manage_posts, so publishing would fail with " +
      "'(#200) Permissions error'. Add that permission to the app's 'Manage everything " +
      "on your Page' use case, then generate a NEW token — an existing token never gains " +
      "a permission retroactively."
    );
  }

  if (info.expires_at !== NEVER) {
    return (
      "This Page token still expires, which means it came from a user token that had not " +
      "been extended. That is the failure this whole step exists to prevent — paste the " +
      "USER token from the Graph API Explorer, not a Page token and not one you have " +
      "already exchanged."
    );
  }

  if (String(info.profile_id ?? "") !== String(pageId)) {
    return `This token belongs to Page ${String(info.profile_id ?? "unknown")}, not ${pageId}.`;
  }

  return null;
}

/**
 * Ask Meta what a token actually is.
 *
 * Needs an APP token (`{app-id}|{app-secret}`), so it only answers for tokens issued by
 * THIS install's app — which is also why it is the call that can prove a token permanent.
 */
export async function debugToken(
  token: string,
  config: MetaAppConfig,
  fetchImpl: typeof fetch = fetch
): Promise<TokenInfo> {
  const params = new URLSearchParams({ input_token: token });
  const data = await metaGet(
    `https://graph.facebook.com/${config.graphVersion}/debug_token?${params}`,
    `${config.appId}|${config.appSecret}`,
    [token, config.appSecret],
    fetchImpl
  );
  return (data.data ?? {}) as TokenInfo;
}

/** Step two: verify the chosen Page end to end and hand back its permanent token. */
export async function selectPage(
  userToken: string,
  pageId: string,
  config: MetaAppConfig,
  fetchImpl: typeof fetch = fetch
): Promise<SelectResult> {
  const configError = appConfigError(config);
  if (configError) return { ok: false, error: configError };

  try {
    const extended = await extendUserToken(userToken, config, fetchImpl);
    const raw = (await fetchPages(extended, config, fetchImpl)).find(
      (p) => String(p.id) === String(pageId)
    );
    if (!raw) {
      return {
        ok: false,
        error: `That token no longer administers Page ${pageId}. Start the lookup again.`,
      };
    }

    const summary = summarise(raw)!;
    if (summary.missingTasks.length > 0) {
      return {
        ok: false,
        error:
          `You lack ${summary.missingTasks.join(" and ")} on '${summary.name}'. Publishing ` +
          `needs both — ask a Page admin to grant full access, then generate a new token.`,
      };
    }

    const pageToken = typeof raw.access_token === "string" ? raw.access_token : "";
    if (!pageToken) {
      return {
        ok: false,
        error:
          `Meta returned no Page token for '${summary.name}'. That usually means the user ` +
          `token was generated without pages_show_list.`,
      };
    }

    const info = await debugToken(pageToken, config, fetchImpl);
    const problem = verifyPageToken(info, summary.id);
    if (problem) return { ok: false, error: problem };

    return { ok: true, pageId: summary.id, name: summary.name, pageToken };
  } catch (err) {
    return { ok: false, error: asMessage(err) };
  }
}

/** Missing app credentials produce a confusing Meta error, so say it plainly first. */
function appConfigError(config: MetaAppConfig): string | null {
  if (!config.appId || !config.appSecret) {
    return (
      "META_APP_ID and META_APP_SECRET are not set in .env, and both are required to " +
      "extend a token. Add them from your Meta app's Settings → Basic, then restart the " +
      "dashboard."
    );
  }
  return null;
}

function asMessage(err: unknown): string {
  if (!(err instanceof MetaError)) {
    return "Something went wrong talking to Meta. Try again.";
  }

  // Pasting the PAGE token here is the single likeliest mistake, because it is the token
  // this flow produces and the one the channel stores — so anybody reconnecting reaches
  // for it first. Meta answers "(#100) Tried accessing nonexisting field (accounts)",
  // which explains nothing. Verified live 2026-08-24, including that the real message
  // omits the "on node type (Page)" suffix that Meta's docs show.
  if (/nonexisting field \(accounts\)/i.test(err.message)) {
    return (
      "That looks like a Page token. This step needs the USER token from the Graph API " +
      "Explorer — a Page token only knows about itself, so it cannot list your Pages. " +
      "(The Page token is what gets stored at the end; it is not what starts this off.)"
    );
  }

  // A token from a DIFFERENT Meta app cannot be extended by this app's secret, and the
  // resulting message names neither app. Worth catching because it is what happens when
  // somebody is handed a token by another person rather than generating their own.
  if (/cannot parse access token|malformed/i.test(err.message)) {
    return (
      "Meta could not read that token. Either it was copied incompletely, or it was " +
      "issued by a different Meta app than the one in this install's .env — a token can " +
      "only be extended by the app that created it."
    );
  }

  return err.message;
}
