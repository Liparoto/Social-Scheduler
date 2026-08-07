"use client";

import { useEffect, useRef, useState } from "react";
import { searchEmoji, type Emoji } from "@/lib/emoji-search";

/**
 * A self-contained emoji picker.
 *
 * Knows nothing about captions or posts — it reports the chosen emoji and the caller decides
 * where it goes. That is what lets the same component serve the composer, the post editor,
 * and the per-platform variants editor without any of them special-casing it.
 *
 * Why this exists when both operating systems already ship a picker (macOS Ctrl+Cmd+Space,
 * Windows Win+.): a non-developer has to know the shortcut exists, and on Windows an emoji
 * newer than the installed Segoe UI Emoji renders as an empty box. The bundled emoji font
 * (see globals.css) fixes the second problem; this fixes the first.
 *
 * It does NOT change how emoji look to the audience, and no wording here should suggest it
 * does. A published emoji is a Unicode codepoint drawn by the VIEWER's device — an iPhone
 * follower sees Apple's artwork no matter which machine composed the post.
 */

const RECENTS_KEY = "ss.emoji.recents";
const RECENTS_MAX = 24;
// The grid is capped so the DOM never holds ~1,900 buttons at once, which makes both the
// first open and every keystroke visibly slow.
const GRID_CAP = 300;

function readRecents(): string[] {
  // A browser with storage disabled (or a private window that throws on access) must
  // degrade to "no recents", never take the composer down with it.
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeRecents(list: string[]): void {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch {
    // Storage full or unavailable — recents are a convenience, never a failure.
  }
}

const triggerCls =
  "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs " +
  "font-medium text-ink-soft hover:bg-surface-sunken focus:border-brand focus:outline-none";

/**
 * An inline SVG face, not the 🙂 character.
 *
 * The first version used the emoji itself, which made the control invisible on the very
 * machines this feature exists for: if the emoji font has not loaded (or lacks the glyph)
 * the button renders as an empty rounded box with nothing in it, and nobody can tell it is
 * a button. An SVG draws from the same stylesheet as everything else and cannot fail that
 * way. The word "Emoji" beside it removes the remaining guesswork.
 */
function SmileyIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7.25" />
      <circle cx="7.5" cy="8.25" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8.25" r="0.9" fill="currentColor" stroke="none" />
      <path d="M6.75 12.25a4 4 0 0 0 6.5 0" strokeLinecap="round" />
    </svg>
  );
}

const chipCls =
  "rounded-md px-2 py-1 text-xs whitespace-nowrap border border-border text-ink-soft " +
  "hover:bg-surface-sunken";

export function EmojiPicker({ onInsert }: { onInsert: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [data, setData] = useState<{ emoji: Emoji[]; groups: string[] } | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // The dataset is ~180 KB. Loading it on first OPEN rather than at import time keeps it out
  // of the compose page's initial bundle entirely — most sessions never open the picker.
  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    import("@/lib/emoji-data").then((m) => {
      if (!cancelled) setData({ emoji: m.EMOJI, groups: m.EMOJI_GROUPS });
    });
    return () => {
      cancelled = true;
    };
  }, [open, data]);

  /**
   * Open/close from the trigger.
   *
   * Reading recents and moving focus happen HERE rather than in an effect on `open`. An
   * effect that calls setState synchronously triggers a cascading render (and the lint rule
   * that catches it), and opening is a user event — there is no reason to route it through
   * the render cycle. Reading storage on each open also picks up emoji chosen by another
   * picker instance on the same page.
   */
  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setRecents(readRecents());
      // Focus the search box so typing works immediately, which is the point of opening it.
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }

  // Escape closes and hands focus back to the trigger, so keyboard users are not stranded.
  // Capture phase matches the existing modal convention in quick-edit-modal.tsx.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function choose(char: string) {
    onInsert(char);
    const next = [char, ...recents.filter((c) => c !== char)].slice(0, RECENTS_MAX);
    setRecents(next);
    writeRecents(next);
    // Deliberately stays open: people usually add more than one emoji at a time, and
    // reopening for each is worse than one extra Escape.
  }

  const all = data?.emoji ?? [];
  const scoped = group ? all.filter((e) => e.group === group) : all;
  const results = searchEmoji(scoped, query);
  const shown = results.slice(0, GRID_CAP);

  return (
    <div className="relative inline-block" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={triggerCls}
        aria-label="Insert emoji"
        aria-expanded={open}
        onClick={toggle}
      >
        <SmileyIcon />
        Emoji
      </button>

      {open ? (
        <div
          className="absolute right-0 z-30 mt-1 w-80 rounded-card border border-border bg-surface p-3 shadow-lg"
          role="dialog"
          aria-label="Emoji picker"
        >
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji…"
            className="mb-2 w-full rounded-md border border-border bg-canvas px-2 py-1 text-sm text-ink placeholder:text-faint focus:border-brand focus:outline-none"
          />

          {data === null ? (
            <p className="py-6 text-center text-xs text-muted">Loading emoji…</p>
          ) : (
            <>
              <div className="mb-2 flex gap-1 overflow-x-auto pb-1">
                <button
                  type="button"
                  className={`${chipCls} ${group === null ? "bg-surface-sunken" : ""}`}
                  onClick={() => setGroup(null)}
                >
                  All
                </button>
                {data.groups.map((g) => (
                  <button
                    key={g}
                    type="button"
                    className={`${chipCls} ${group === g ? "bg-surface-sunken" : ""}`}
                    onClick={() => setGroup(g)}
                  >
                    {g}
                  </button>
                ))}
              </div>

              {query.trim() === "" && recents.length > 0 ? (
                <div className="mb-2 border-b border-border pb-2">
                  <p className="mb-1 text-xs text-faint">Recent</p>
                  <div className="font-emoji flex flex-wrap gap-1">
                    {recents.map((c) => (
                      <button
                        key={`recent-${c}`}
                        type="button"
                        className="rounded p-1 text-lg leading-none hover:bg-surface-sunken"
                        onClick={() => choose(c)}
                        aria-label={`Insert ${c}`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="font-emoji grid max-h-56 grid-cols-8 gap-1 overflow-y-auto">
                {shown.map((e) => (
                  <button
                    key={e.char}
                    type="button"
                    title={e.name}
                    aria-label={`Insert ${e.name}`}
                    className="rounded p-1 text-lg leading-none hover:bg-surface-sunken"
                    onClick={() => choose(e.char)}
                  >
                    {e.char}
                  </button>
                ))}
              </div>

              {results.length === 0 ? (
                <p className="pt-2 text-center text-xs text-muted">
                  No emoji match “{query.trim()}”.
                </p>
              ) : null}
              {results.length > GRID_CAP ? (
                <p className="pt-2 text-center text-xs text-faint">
                  Showing {GRID_CAP} of {results.length} — keep typing to narrow it down.
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
