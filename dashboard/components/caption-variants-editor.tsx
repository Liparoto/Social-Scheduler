"use client";

import { PLATFORMS, maxCaptionChars, platformLabel } from "@/lib/platforms";

export interface CaptionVariantDraft {
  platform: string;
  body: string;
}

/** Variants whose own selected platform has a caption limit they're over. Callers (the
 * composer, the library editor) use this to block a save/submit — a per-row counter
 * alone doesn't stop the click. */
export function overLimitCaptionVariants(
  variants: CaptionVariantDraft[]
): { platform: string; length: number; limit: number }[] {
  const out: { platform: string; length: number; limit: number }[] = [];
  for (const v of variants) {
    if (!v.platform || !v.body.trim()) continue;
    const limit = maxCaptionChars(v.platform);
    if (limit !== null && v.body.length > limit) {
      out.push({ platform: v.platform, length: v.body.length, limit });
    }
  }
  return out;
}

const fieldCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand";

export function CaptionVariantsEditor({
  value,
  onChange,
}: {
  value: CaptionVariantDraft[];
  onChange: (v: CaptionVariantDraft[]) => void;
}) {
  function update(i: number, patch: Partial<CaptionVariantDraft>) {
    onChange(value.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));
  }
  function remove(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...value, { platform: "", body: "" }]);
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="block text-xs font-medium text-ink-soft">Caption</label>
      </div>
      <p className="mb-2 text-xs text-muted">
        One is fine. Generic captions rotate for variety; platform-specific ones are used
        for that platform.
      </p>
      <div className="space-y-3">
        {value.map((v, i) => {
          const limit = v.platform ? maxCaptionChars(v.platform) : null;
          const over = limit !== null && v.body.length > limit;
          return (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-2">
                <select
                  className={`${fieldCls} w-40 shrink-0`}
                  value={v.platform}
                  onChange={(e) => update(i, { platform: e.target.value })}
                >
                  <option value="">Any</option>
                  {PLATFORMS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {value.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    className="text-xs font-medium text-muted hover:text-status-failed"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
              <textarea
                className={`${fieldCls} min-h-24 resize-y`}
                placeholder="Write the caption…"
                value={v.body}
                onChange={(e) => update(i, { body: e.target.value })}
              />
              {limit !== null ? (
                <p className={`text-xs ${over ? "font-medium text-accent-strong" : "text-muted"}`}>
                  {v.body.length} / {limit} characters
                  {over ? ` — over ${platformLabel(v.platform)}'s limit.` : ""}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 text-xs font-medium text-brand-strong hover:underline"
      >
        + Add caption variant
      </button>
    </div>
  );
}
