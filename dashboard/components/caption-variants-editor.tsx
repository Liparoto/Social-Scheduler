"use client";

import { useLayoutEffect, useRef } from "react";
import { PLATFORMS, captionLimit, platformLabel } from "@/lib/platforms";
import { captionLength } from "@/lib/caption-length";
import { insertAtCaret } from "@/lib/insert-at-caret";
import { EmojiPicker } from "@/components/emoji-picker";
import { EmojiHint } from "@/components/emoji-hint";

export interface CaptionVariantDraft {
  platform: string;
  body: string;
}

/** Variants whose own selected platform has a caption limit they're over. Callers (the
 * composer, the library editor) use this to block a save/submit — a per-row counter
 * alone doesn't stop the click. `postType` matters because Telegram's limit depends on
 * whether media is attached (4096 chars text-only, 1024 once a photo/carousel is attached). */
export function overLimitCaptionVariants(
  variants: CaptionVariantDraft[],
  postType: string
): { platform: string; length: number; limit: number }[] {
  const out: { platform: string; length: number; limit: number }[] = [];
  for (const v of variants) {
    if (!v.platform || !v.body.trim()) continue;
    const limit = captionLimit(v.platform, postType);
    if (limit !== null && captionLength(v.body) > limit) {
      out.push({ platform: v.platform, length: captionLength(v.body), limit });
    }
  }
  return out;
}

const fieldCls =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand";

export function CaptionVariantsEditor({
  value,
  onChange,
  postType,
}: {
  value: CaptionVariantDraft[];
  onChange: (v: CaptionVariantDraft[]) => void;
  postType: string;
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

  // One textarea ref per variant row, keyed by index, so the picker knows WHICH field to
  // splice into. A Map rather than an array because rows are added and removed.
  const textareas = useRef(new Map<number, HTMLTextAreaElement>());

  // Where the caret should go once the new caption value has actually reached the DOM.
  // A ref, not state, so setting it cannot itself trigger a render.
  const pendingCaret = useRef<{ i: number; caret: number } | null>(null);

  /**
   * Put the caret back after an emoji insert.
   *
   * useLayoutEffect keyed on `value`, NOT requestAnimationFrame. rAF was the first attempt
   * and it is genuinely wrong: it can fire before React commits the new caption, so
   * setSelectionRange lands on the OLD string and the subsequent re-render throws the caret
   * to the end. Verified in a browser — inserting into "Hello|world" left the caret at 13
   * instead of 7. A layout effect runs after the DOM is updated and before paint, so the
   * caret is already correct the first time anyone sees it.
   */
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending) return;
    pendingCaret.current = null;
    const el = textareas.current.get(pending.i);
    if (!el) return;
    el.focus();
    el.setSelectionRange(pending.caret, pending.caret);
  }, [value]);

  function insertEmoji(i: number, emoji: string) {
    const el = textareas.current.get(i);
    const body = value[i]?.body ?? "";
    // With no live element (or no selection info) fall back to appending — better than
    // dropping the emoji the person just clicked.
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = insertAtCaret(body, emoji, start, end);
    pendingCaret.current = { i, caret: next.caret };
    update(i, { body: next.text });
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
          const limit = v.platform ? captionLimit(v.platform, postType) : null;
          const over = limit !== null && captionLength(v.body) > limit;
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
                <div className="ml-auto">
                  <EmojiPicker onInsert={(emoji) => insertEmoji(i, emoji)} />
                </div>
              </div>
              <textarea
                ref={(el) => {
                  if (el) textareas.current.set(i, el);
                  else textareas.current.delete(i);
                }}
                className={`${fieldCls} font-emoji min-h-24 resize-y`}
                placeholder="Write the caption…"
                value={v.body}
                onChange={(e) => update(i, { body: e.target.value })}
              />
              {limit !== null ? (
                <p className={`text-xs ${over ? "font-medium text-accent-strong" : "text-muted"}`}>
                  {captionLength(v.body)} / {limit} characters
                  {over ? ` — over ${platformLabel(v.platform)}'s limit.` : ""}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <EmojiHint />
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
