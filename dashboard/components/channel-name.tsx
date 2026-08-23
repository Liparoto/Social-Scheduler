"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Rename a channel.
 *
 * Every other per-channel setting had an edit control and the NAME did not, which only
 * became obvious once a platform started naming channels for you: TikTok's is whatever
 * the account's display name happened to be at connect time, and it is the label used
 * everywhere in the queue, the calendar and Insights.
 *
 * Unlike ChannelColor this does not save on change — a name is typed, not picked, and
 * saving each keystroke would write a row per character and briefly persist "L", "Li",
 * "Lip"… as the channel's real name.
 */
export function ChannelName({
  channelId,
  accountName,
}: {
  channelId: number;
  accountName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(accountName);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  // An empty name passes the schema's NOT NULL and then renders as a blank chip that
  // cannot be clicked back into — so it is refused here as well as server-side.
  const invalid = trimmed.length === 0;

  async function save() {
    setError(null);
    const res = await fetch(`/api/channels/${channelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_name: trimmed }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not save the name.");
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-sunken/40 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-medium text-ink-soft">Name</span>
        <span className="text-xs text-muted">{open ? "Hide" : "Edit"}</span>
      </button>

      {open ? (
        <div className="mt-3 space-y-2">
          <input
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand"
            value={value}
            maxLength={80}
            placeholder="Account name"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !invalid) save();
              if (e.key === "Escape") {
                setValue(accountName);
                setOpen(false);
              }
            }}
          />
          <p className="text-[11px] text-muted">
            Only what this install calls the account — it is never sent to the platform.
          </p>
          {error ? <p className="text-[11px] text-status-failed">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setValue(accountName);
                setOpen(false);
              }}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-ink-soft hover:bg-surface"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={invalid || pending || trimmed === accountName}
              className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
