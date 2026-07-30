"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TimezonePicker } from "@/components/timezone-picker";
import { formatInTz, tzAbbrev } from "@/lib/format";

type PreviewSend = {
  id: number;
  post_id: number;
  is_held: boolean;
  before: string;
  after: string;
};

/**
 * Edit a channel's timezone after creation — which, before this, was impossible
 * from the UI at all.
 *
 * Unlike ChannelColor, this does NOT save on pick. Changing the zone rewrites the
 * scheduled_at of every pending send, so it goes through an explicit preview: the
 * owner sees each send's before/after time and confirms. Getting this wrong means
 * real posts fire at the wrong hour, so it should cost one deliberate click.
 */
export function ChannelTimezone({
  channelId,
  timezone,
}: {
  channelId: number;
  timezone: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(timezone);
  const [valid, setValid] = useState(true);
  const [preview, setPreview] = useState<PreviewSend[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable identity so TimezonePicker's effect doesn't re-fire every render.
  const handleValidity = useCallback((v: boolean) => setValid(v), []);

  const dirty = value !== timezone;

  function change(next: string) {
    setValue(next);
    setPreview(null); // any pending preview is now stale
    setError(null);
  }

  async function post(body: object) {
    const res = await fetch(`/api/channels/${channelId}/timezone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? "Could not change the timezone.");
    return json;
  }

  async function review() {
    setBusy(true);
    setError(null);
    try {
      const json = await post({ timezone: value, confirm: false });
      setPreview(json.sends as PreviewSend[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      await post({ timezone: value, confirm: true });
      setPreview(null);
      setOpen(false);
      startTransition(() => router.refresh());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const moving = preview?.filter((s) => s.before !== s.after) ?? [];

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-sunken/40 p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-medium text-ink-soft">Timezone</span>
        <span className="text-xs text-muted">{open ? "Hide" : "Edit"}</span>
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          <TimezonePicker value={value} onChange={change} onValidityChange={handleValidity} />

          {preview ? (
            <div className="rounded-lg border border-border bg-surface p-3">
              {moving.length === 0 ? (
                <p className="text-xs text-muted">
                  No pending sends on this channel — nothing to move.
                </p>
              ) : (
                <>
                  <p className="text-xs text-ink-soft">
                    {moving.length} pending {moving.length === 1 ? "send" : "sends"} will keep
                    the same clock time, so {moving.length === 1 ? "its" : "their"} actual
                    posting moment moves:
                  </p>
                  <ul className="mt-2 space-y-1">
                    {moving.map((s) => (
                      <li key={s.id} className="data flex flex-wrap gap-x-2 text-[11px]">
                        <span className="text-faint">#{s.post_id}</span>
                        <span className="text-muted line-through">
                          {formatInTz(s.before, timezone)} {tzAbbrev(timezone)}
                        </span>
                        <span className="text-faint">→</span>
                        <span className="text-ink-soft">
                          {formatInTz(s.after, value)} {tzAbbrev(value)}
                        </span>
                        {s.is_held ? <span className="text-faint">(held)</span> : null}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            {preview ? (
              <button
                onClick={apply}
                disabled={busy}
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
              >
                {busy
                  ? "Saving…"
                  : moving.length > 0
                    ? `Save & move ${moving.length} ${moving.length === 1 ? "send" : "sends"}`
                    : "Save"}
              </button>
            ) : (
              <button
                onClick={review}
                disabled={busy || !valid || !dirty}
                className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
              >
                {busy ? "Checking…" : dirty ? "Review change" : "No change"}
              </button>
            )}
            {dirty ? (
              <button
                onClick={() => {
                  change(timezone);
                }}
                className="text-xs text-muted hover:text-ink"
              >
                Reset
              </button>
            ) : null}
          </div>

          {pending ? <p className="text-[11px] text-muted">Refreshing…</p> : null}
          {error ? <p className="text-[11px] text-status-failed">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
