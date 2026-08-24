"use client";

import { useState } from "react";

type PageSummary = { id: string; name: string; missingTasks: string[] };

type State =
  | { status: "idle" }
  | { status: "listing" }
  | { status: "choosing"; pages: PageSummary[] }
  | { status: "verifying"; name: string }
  | { status: "done"; name: string; pageId: string }
  | { status: "error"; message: string };

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand";

/**
 * Connect a Facebook Page without opening a terminal.
 *
 * Replaces both the account-id lookup AND the `python -m worker.exchange_token` step for
 * Facebook, because they were always one job split in two: the Page id and the Page token
 * come from the same call and are useless apart.
 *
 * The token box here is deliberately NOT the form's Access token field. What gets pasted
 * is a short-lived USER token — a different credential from the permanent PAGE token the
 * channel stores. Reusing one box for both is what made the earlier docs wording
 * dangerous: it invited saving the user token as the channel credential, which works for
 * about an hour and then fails in a way that does not explain itself.
 */
export function FacebookConnect({
  onConnected,
}: {
  onConnected: (result: { pageId: string; name: string; pageToken: string }) => void;
}) {
  const [userToken, setUserToken] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function call(body: Record<string, string>) {
    const res = await fetch("/api/channels/facebook/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function list() {
    if (!userToken.trim()) {
      setState({ status: "error", message: "Paste the user token from the Graph API Explorer first." });
      return;
    }
    setState({ status: "listing" });
    try {
      const body = await call({ action: "list", token: userToken });
      if (!body.ok) {
        setState({ status: "error", message: body.error ?? "Could not list your Pages." });
        return;
      }
      // One Page is the common case — going straight through saves a pointless click on a
      // list of one, and the verify step still reports which Page was chosen.
      if (body.pages.length === 1) {
        await select(body.pages[0]);
        return;
      }
      setState({ status: "choosing", pages: body.pages });
    } catch {
      setState({ status: "error", message: "Could not reach the dashboard's own server." });
    }
  }

  async function select(page: PageSummary) {
    setState({ status: "verifying", name: page.name });
    try {
      const body = await call({ action: "select", token: userToken, pageId: page.id });
      if (!body.ok) {
        setState({ status: "error", message: body.error ?? "Could not verify that Page." });
        return;
      }
      onConnected({ pageId: body.pageId, name: body.name, pageToken: body.pageToken });
      setState({ status: "done", name: body.name, pageId: body.pageId });
      // The short-lived token has done its job and is worth dropping rather than leaving
      // in a form field where it might get saved by mistake.
      setUserToken("");
    } catch {
      setState({ status: "error", message: "Could not reach the dashboard's own server." });
    }
  }

  const busy = state.status === "listing" || state.status === "verifying";

  if (state.status === "done") {
    return (
      <div className="sm:col-span-2 rounded-lg border border-border bg-surface-muted p-4">
        <p className="text-sm text-ink">
          <span className="font-medium">Connected {state.name}.</span> Page id and a
          permanent Page token have been filled in below.
        </p>
        <p className="mt-2 text-xs text-muted">
          Verified as a Page token that never expires, for this Page, with
          pages_manage_posts. Press <span className="font-medium">Save channel</span> to
          store it.
        </p>
      </div>
    );
  }

  return (
    <div className="sm:col-span-2 rounded-lg border border-border bg-surface-muted p-4">
      <p className="mb-1 text-sm text-ink-soft">
        Paste the <span className="font-medium text-ink">user token</span> from the{" "}
        <a
          href="https://developers.facebook.com/tools/explorer"
          target="_blank"
          rel="noreferrer"
          className="text-brand hover:text-brand-ink"
        >
          Graph API Explorer
        </a>
        , generated with <code>pages_show_list</code>, <code>pages_read_engagement</code> and{" "}
        <code>pages_manage_posts</code>.
      </p>
      <p className="mb-3 text-xs text-muted">
        Not a Page token, and not one you have already exchanged — this makes the permanent
        one for you.
      </p>

      <div className="flex gap-2">
        <input
          className={field}
          type="password"
          placeholder="Short-lived user token — used once, never stored"
          value={userToken}
          onChange={(e) => {
            setUserToken(e.target.value);
            if (state.status === "error") setState({ status: "idle" });
          }}
        />
        <button
          type="button"
          onClick={list}
          disabled={busy}
          className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
        >
          {state.status === "listing"
            ? "Extending…"
            : state.status === "verifying"
              ? "Verifying…"
              : "Connect"}
        </button>
      </div>

      {state.status === "error" ? (
        <p className="mt-3 whitespace-pre-line rounded-lg border border-status-failed bg-surface p-2.5 text-xs text-status-failed">
          {state.message}
        </p>
      ) : null}

      {state.status === "choosing" ? (
        <div className="mt-3">
          <p className="mb-2 text-xs text-ink-soft">
            You administer {state.pages.length} Pages. Which one is this channel?
          </p>
          <div className="flex flex-col gap-1">
            {state.pages.map((p) => {
              const blocked = p.missingTasks.length > 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => select(p)}
                  disabled={blocked}
                  className="rounded border border-border bg-surface px-2.5 py-1.5 text-left text-xs text-ink hover:border-brand disabled:opacity-50 disabled:hover:border-border"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-2 text-muted">{p.id}</span>
                  {/* Shown rather than hidden: a Page missing from the list reads as a
                      token problem and sends someone to regenerate one. Greyed out with
                      the reason attached is the difference between "broken" and "ask an
                      admin for access". */}
                  {blocked ? (
                    <span className="ml-2 text-status-failed">
                      needs {p.missingTasks.join(" + ")}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
