"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { accountIdLabel } from "@/lib/platforms";

/**
 * Update a channel's credentials (IG user id + access token). Tokens expire / get
 * regenerated, so editing them is a routine need. The token is write-only here — we
 * never render the stored value back.
 */
export function ChannelCredentials({
  channelId,
  platform,
  remoteAccountId,
}: {
  channelId: number;
  platform: string;
  remoteAccountId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState(remoteAccountId ?? "");
  const [token, setToken] = useState("");
  const [pending, startT] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setMsg(null);
    const body: Record<string, string> = { remote_account_id: accountId.trim() };
    // Only send the token if they typed a new one (leave it untouched otherwise).
    if (token.trim()) body.access_token = token.trim();
    const res = await fetch(`/api/channels/${channelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setMsg("Could not save.");
      return;
    }
    setToken("");
    setMsg("Saved — run the preflight check to verify.");
    startT(() => router.refresh());
  }

  const field =
    "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-ink focus:border-brand";

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-sunken/40 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-medium text-ink-soft">Credentials</span>
        <span className="text-xs text-muted">{open ? "Hide" : "Update token"}</span>
      </button>

      {open ? (
        <div className="mt-3 space-y-2.5">
          <label className="block text-xs text-ink-soft">
            <span className="mb-1 block">
              {accountIdLabel(platform)}
            </span>
            <input
              className={field}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="1784140000..."
            />
          </label>
          <label className="block text-xs text-ink-soft">
            <span className="mb-1 block">
              New access token{" "}
              <span className="text-faint">(long, starts with IGAA… — leave blank to keep current)</span>
            </span>
            <input
              className={field}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste the freshly generated token"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={pending}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save credentials"}
            </button>
            {msg ? <span className="text-xs text-status-posted">{msg}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
