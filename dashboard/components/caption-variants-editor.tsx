"use client";

export interface CaptionVariantDraft {
  platform: string;
  body: string;
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
        {value.map((v, i) => (
          <div key={i} className="space-y-2">
            <div className="flex items-center gap-2">
              <select
                className={`${fieldCls} w-40 shrink-0`}
                value={v.platform}
                onChange={(e) => update(i, { platform: e.target.value })}
              >
                <option value="">Any</option>
                <option value="instagram">Instagram</option>
                <option value="facebook">Facebook</option>
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
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="mt-2 text-xs font-medium text-brand-ink hover:underline"
      >
        + Add caption variant
      </button>
    </div>
  );
}
