"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PLATFORMS, accountIdLabel, usesAccountId, usesLinkedPage, platformLabel } from "@/lib/platforms";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";

const field =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand";
const label = "block text-xs font-medium text-ink-soft mb-1";

export function ChannelForm({
  defaultTimezone,
  nextChannelId,
}: {
  defaultTimezone: string;
  /**
   * The id this channel will actually get (highest existing channel id + 1 — SQLite
   * reuses the max rowid+1 for a plain INTEGER PRIMARY KEY absent AUTOINCREMENT, so
   * this matches in the common case). Without this the Automatic preview always showed
   * hue 200, which is only ever right by coincidence.
   */
  nextChannelId: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    // `as string`: PLATFORMS[0].value is a non-fresh literal ("instagram"), which TS
    // would NOT widen during useState's generic inference (unlike a literal written
    // inline here) — leaving form.platform typed as that one literal and breaking the
    // plain-string onChange handler below.
    platform: PLATFORMS[0].value as string,
    account_name: "",
    business_label: "",
    timezone: defaultTimezone,
    remote_account_id: "",
    linked_page_id: "",
    access_token: "",
    requires_approval: false,
    color_hue: null as number | null,
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
      color_hue: null,
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
        {usesAccountId(form.platform) ? (
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
        ) : null}
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
          <label className={label}>
            {usesAccountId(form.platform) ? "Access token" : "Webhook URL"}
          </label>
          <input
            className={field}
            type="password"
            placeholder={
              usesAccountId(form.platform)
                ? "Long-lived token — stored locally, never logged"
                : "The full Discord webhook URL — this is the whole credential, stored locally, never logged"
            }
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
        <div className="sm:col-span-2">
          <label className={label}>Accent colour (optional)</label>
          <ColorSwatchPicker
            value={form.color_hue}
            onChange={(hue) => set("color_hue", hue)}
            previewChannelId={nextChannelId}
            previewName={form.account_name || "New channel"}
            previewPlatformLabel={platformLabel(form.platform)}
          />
        </div>
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
