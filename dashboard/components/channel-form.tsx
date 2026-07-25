"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PLATFORMS, accountIdLabel, usesLinkedPage } from "@/lib/platforms";

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand";
const label = "block text-xs font-medium text-ink-soft mb-1";

export function ChannelForm({ defaultTimezone }: { defaultTimezone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    platform: "instagram",
    account_name: "",
    business_label: "",
    timezone: defaultTimezone,
    remote_account_id: "",
    linked_page_id: "",
    access_token: "",
    requires_approval: false,
  });

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit() {
    setError(null);
    const res = await fetch("/api/channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not add the channel.");
      return;
    }
    setForm((f) => ({
      ...f,
      account_name: "",
      business_label: "",
      remote_account_id: "",
      linked_page_id: "",
      access_token: "",
    }));
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-ink"
      >
        Add channel
      </button>
    );
  }

  return (
    <div className="rounded-card border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-base font-semibold text-ink">New channel</h3>
        <button onClick={() => setOpen(false)} className="text-sm text-muted hover:text-ink">
          Cancel
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={label}>Platform</label>
          <select
            className={field}
            value={form.platform}
            onChange={(e) => set("platform", e.target.value)}
          >
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label}>Account name</label>
          <input
            className={field}
            placeholder="Advantage Physical Therapy"
            value={form.account_name}
            onChange={(e) => set("account_name", e.target.value)}
          />
        </div>
        <div>
          <label className={label}>Business label (optional)</label>
          <input
            className={field}
            placeholder="APT"
            value={form.business_label}
            onChange={(e) => set("business_label", e.target.value)}
          />
        </div>
        <div>
          <label className={label}>Timezone (IANA)</label>
          <input
            className={field}
            placeholder="America/New_York"
            value={form.timezone}
            onChange={(e) => set("timezone", e.target.value)}
          />
        </div>
        <div>
          <label className={label}>
            {accountIdLabel(form.platform)}
          </label>
          <input
            className={field}
            placeholder="17841400000000000"
            value={form.remote_account_id}
            onChange={(e) => set("remote_account_id", e.target.value)}
          />
        </div>
        {usesLinkedPage(form.platform) ? (
          <div>
            <label className={label}>Linked Facebook Page id (optional)</label>
            <input
              className={field}
              placeholder="For IG-via-Page publishing"
              value={form.linked_page_id}
              onChange={(e) => set("linked_page_id", e.target.value)}
            />
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <label className={label}>Access token</label>
          <input
            className={field}
            type="password"
            placeholder="Long-lived token — stored locally, never logged"
            value={form.access_token}
            onChange={(e) => set("access_token", e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-soft sm:col-span-2">
          <input
            type="checkbox"
            checked={form.requires_approval}
            onChange={(e) => set("requires_approval", e.target.checked)}
          />
          Require approval before anything publishes to this channel
        </label>
      </div>

      {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}

      <div className="mt-4 flex justify-end">
        <button
          onClick={submit}
          disabled={pending}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save channel"}
        </button>
      </div>
    </div>
  );
}
