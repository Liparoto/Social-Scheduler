"use client";

import { useState } from "react";
import { accountIdLabel, platformLabel } from "@/lib/platforms";

type FoundAccount = { id: string; name: string | null; isHandle: boolean };

/** "@liparoto" for a handle, "LFK Events" for a Page's display name — never "@LFK Events". */
function displayName(account: FoundAccount): string {
  if (!account.name) return "Account";
  return account.isHandle ? `@${account.name}` : account.name;
}

/**
 * What the displayed result belongs to.
 *
 * Every non-idle state carries this, and the render discards any result whose context no
 * longer matches the current props. Without it the result outlives the question that
 * produced it: look up an Instagram id, switch the Platform selector to Threads, and the
 * component (same position, same type, so React keeps the instance and its state) keeps
 * showing "found" while relabelling itself "Threads user id filled in" — over an id field
 * still holding the Instagram id. Saving that is the mispairing docs/meta-setup.md:304
 * exists to warn about, arrived at through the very feature meant to prevent it.
 *
 * Comparing context beats a `key` prop: a key remounts on every keystroke in the token
 * field, discarding an in-flight lookup and leaving its fetch to resolve into a dead
 * component. This keeps the instance and just refuses to show a stale answer.
 */
type Context = { platform: string; token: string };

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; for: Context }
  | { status: "choose"; accounts: FoundAccount[]; for: Context }
  // filledName is captured when the account is chosen, NOT read from the hasName prop at
  // render time. Choosing fills the parent's name field, which flips hasName to true
  // before this ever renders — reading the prop here would describe the state after the
  // fill and could never report that a fill happened.
  | { status: "done"; account: FoundAccount; filledName: boolean; for: Context };

/**
 * "Look it up" for the account id field.
 *
 * The id is the one value in this form nobody can produce from memory: a bare 17-digit
 * number that is not shown next to the token you just generated. Worse, the ids for a
 * linked Instagram and Threads account are different numbers for the same person
 * (docs/meta-setup.md:304), and using the wrong one fails at publish time with an error
 * that reads like a broken token.
 *
 * The token already identifies the account, so this asks the platform rather than asking
 * the owner. It deliberately reuses the Access token field already on the form instead of
 * adding a second token box — one credential, typed once.
 *
 * Nothing here talks to Meta directly. It posts to /api/channels/lookup, which makes the
 * call server-side; lib/account-lookup.ts is marked `server-only` so this cannot regress
 * into a token-bearing request from the browser.
 */
export function AccountIdLookup({
  platform,
  token,
  hasName,
  onPick,
}: {
  platform: string;
  token: string;
  /** Whether the Account name field is already filled — an empty one gets auto-filled. */
  hasName: boolean;
  onPick: (account: FoundAccount) => void;
}) {
  const [state, setState] = useState<State>({ status: "idle" });

  // The question currently on screen. A result is only shown while it still matches.
  const context: Context = { platform, token };
  const matchesContext =
    state.status === "idle" ||
    state.status === "loading" ||
    (state.for.platform === platform && state.for.token === token);
  // A result from a different platform or a since-edited token is not wrong so much as
  // no longer an answer to anything — fall back to the untouched starting state.
  const shown: State = matchesContext ? state : { status: "idle" };

  async function lookup() {
    if (!token.trim()) {
      setState({
        status: "error",
        for: context,
        message: "Paste your access token in the field below first — that is what identifies the account.",
      });
      return;
    }
    setState({ status: "loading" });

    let body: { ok?: boolean; accounts?: FoundAccount[]; error?: string };
    try {
      const res = await fetch("/api/channels/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform, token }),
      });
      body = await res.json();
    } catch {
      setState({
        status: "error",
        for: context,
        message: "Could not reach the dashboard's own server. Is it still running?",
      });
      return;
    }

    if (!body.ok || !body.accounts?.length) {
      setState({ status: "error", for: context, message: body.error ?? "The lookup failed." });
      return;
    }

    // One account is the common case (Instagram, Threads) — take it. A Facebook user
    // token can administer several Pages, and picking one for somebody would be picking
    // which account they publish to, which is not a guess worth making.
    if (body.accounts.length === 1) {
      choose(body.accounts[0]);
      return;
    }
    setState({ status: "choose", accounts: body.accounts, for: context });
  }

  function choose(account: FoundAccount) {
    // Read hasName BEFORE onPick, which is what changes it.
    const filledName = !hasName && Boolean(account.name);
    onPick(account);
    setState({ status: "done", account, filledName, for: context });
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={lookup}
        disabled={shown.status === "loading"}
        className="text-xs font-medium text-brand hover:text-brand-ink disabled:text-muted"
      >
        {shown.status === "loading"
          ? `Asking ${platformLabel(platform)}…`
          : `Don't know it? Look it up from your access token`}
      </button>

      {shown.status === "error" ? (
        <p className="mt-2 rounded-lg border border-status-failed bg-surface-muted p-2.5 text-xs text-status-failed">
          {shown.message}
        </p>
      ) : null}

      {shown.status === "choose" ? (
        <div className="mt-2 rounded-lg border border-border bg-surface-muted p-2.5">
          <p className="mb-2 text-xs text-ink-soft">
            That token administers {shown.accounts.length} Pages. Which one is this channel?
          </p>
          <div className="flex flex-col gap-1">
            {shown.accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => choose(a)}
                className="rounded border border-border bg-surface px-2.5 py-1.5 text-left text-xs text-ink hover:border-brand"
              >
                <span className="font-medium">{a.name ?? "Unnamed Page"}</span>
                <span className="ml-2 text-muted">{a.id}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {shown.status === "done" ? (
        <p className="mt-2 rounded-lg border border-border bg-surface-muted p-2.5 text-xs text-ink-soft">
          <span className="font-medium text-ink">{displayName(shown.account)} found.</span>{" "}
          {accountIdLabel(platform)} filled in{shown.filledName ? ", along with the account name" : ""}. Check
          the name matches the account you meant to connect — that is what confirms the
          token and the id in one go.
        </p>
      ) : null}
    </div>
  );
}
