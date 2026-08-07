# Emoji Picker + Caption Counting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can insert any emoji from inside the composer, it looks the same on macOS and Windows, and both the dashboard and the worker count caption length the way the target platform actually counts it.

**Architecture:** Two independent strands that ship together because the first makes the second likely. (a) A shared caption-length function on each side, both counting UTF-16 code units, replacing Python's `len()` which counts code points. (b) A dependency-free emoji picker: a dataset generated from Unicode's `emoji-test.txt`, lazy-loaded, rendered by a self-contained client component, with Noto Color Emoji bundled so Windows stops drawing tofu.

**Tech Stack:** TypeScript + React 19 client components + `node:test` (dashboard), Python stdlib + pytest (worker), Tailwind theme tokens, `next/font` for Noto Color Emoji.

**Spec:** [`docs/superpowers/specs/2026-08-07-emoji-picker-design.md`](../specs/2026-08-07-emoji-picker-design.md)

## Global Constraints

- **No new runtime dependencies.** The dashboard ships six; keep it that way. The picker and
  the dataset are written here, not installed.
- **Caption length is counted in UTF-16 code units on BOTH sides.** TS `s.length` is already
  this; Python must become `len(s.encode("utf-16-le")) // 2`.
- **The Threads unit is a safe default, not a verified fact.** Never write a comment or a doc
  line claiming Meta confirmed it. Telegram and Discord ARE verified — cite them.
- **Never claim the picker changes how emoji appear to the audience.** It does not. Published
  emoji are codepoints rendered by the viewer's device.
- **Apple Color Emoji must never be bundled, referenced by file, or suggested.** Proprietary.
- Dashboard tests: from `dashboard/`: `npm test`, `npm run lint` (must stay 0 errors)
- Worker tests: `.venv/bin/python -m pytest worker/tests -q`
- Theme tokens only — no hardcoded hex. Must work in light and dark across all 7 themes.

---

### Task 1: One caption-length rule, on both sides

Ships alone and is the correctness fix. The dashboard is already right; the worker is not.

**Files:**
- Create: `dashboard/lib/caption-length.ts`
- Create: `dashboard/lib/caption-length.test.ts`
- Create: `worker/caption_length.py`
- Create: `worker/tests/test_caption_length.py`
- Modify: `dashboard/lib/caption-limits.ts:70`
- Modify: `dashboard/components/composer.tsx:127,149,155,157,261-262`
- Modify: `worker/publisher.py:261,263`
- Modify: `worker/autofill.py:249`
- Modify: `worker/graph_api.py:260,263`

**Interfaces:**
- Produces: `captionLength(s: string): number` (TS), `caption_length(s: str) -> int` (Python)

**The shared expectation table — both suites assert exactly these, so the two languages are
pinned to one answer:**

| string | expected |
|---|---|
| `""` | 0 |
| `"hello"` | 5 |
| `"😀"` | 2 |
| `"👋🏽"` | 4 |
| `"👨‍👩‍👧"` | 8 |
| `"Great day! 😀🎉🔺"` | 17 |
| `"café"` | 4 |

- [ ] **Step 1: Write the failing Python test**

Create `worker/tests/test_caption_length.py`:

```python
"""Caption length must be counted the same way the target platform counts it.

The table here is duplicated verbatim in dashboard/lib/caption-length.test.ts. That
duplication is the point: the bug this guards against was the two languages disagreeing,
so both suites pin the same strings to the same numbers.
"""

from __future__ import annotations

import pytest

from worker.caption_length import caption_length


# (string, expected UTF-16 code units)
CASES = [
    ("", 0),
    ("hello", 5),
    ("\U0001F600", 2),                                  # grinning face
    ("\U0001F44B\U0001F3FD", 4),                        # waving hand + skin tone
    ("\U0001F468‍\U0001F469‍\U0001F467", 8),  # family, ZWJ-joined
    ("Great day! \U0001F600\U0001F389\U0001F53A", 17),
    ("café", 4),                                   # BMP accent still counts 1
]


@pytest.mark.parametrize("text,expected", CASES)
def test_counts_utf16_code_units(text, expected):
    assert caption_length(text) == expected


def test_differs_from_len_for_astral_characters():
    """The actual bug: Python's len() counts code points, so it under-counts emoji."""
    text = "\U0001F600"
    assert len(text) == 1
    assert caption_length(text) == 2
```

- [ ] **Step 2: Run it to verify it fails**

```bash
.venv/bin/python -m pytest worker/tests/test_caption_length.py -q
```
Expected: FAIL — `No module named 'worker.caption_length'`.

- [ ] **Step 3: Implement the Python side**

Create `worker/caption_length.py`:

```python
"""How long is a caption, in the units the target platform actually counts?

Python's built-in len() counts CODE POINTS. Every platform this app enforces a limit for
counts UTF-16 CODE UNITS, in which any character outside the Basic Multilingual Plane —
every emoji — counts 2, and a ZWJ sequence counts the sum of its parts plus its joiners.

That gap was a real bug: the dashboard (JavaScript, natively UTF-16) and this worker
disagreed by 3 on a caption as ordinary as "Great day! [3 emoji]". The worker is the
authoritative gate, so it was the side letting an over-length caption through to fail
terminally at send time.

Per-platform units, researched not assumed:
  - Telegram  UTF-16 code units. VERIFIED — its entities spec is explicit that BMP counts
              1 and everything else counts 2.
  - Discord   UTF-16 code units. VERIFIED — emoji cost 2, a ZWJ family costs 7+.
  - Threads   UNKNOWN. Meta documents "500 characters" without defining the unit, and
              third-party trackers contradict each other. UTF-16 is chosen because it is
              the STRICTER candidate: counting high can only warn early, while counting
              low lets a caption through that dies terminally on publish. This is a safe
              default, NOT something Meta confirmed. If it is ever confirmed, update the
              table in docs/superpowers/specs/2026-08-07-emoji-picker-design.md.
  - Instagram / Facebook  no limit is enforced by this app (captionChars is empty).
"""

from __future__ import annotations


def caption_length(text: str) -> int:
    """The caption's length in UTF-16 code units — what the platforms count."""
    # Encoding to UTF-16 and halving the byte count is the direct definition. 'utf-16-le'
    # (not 'utf-16') on purpose: the plain codec prepends a 2-byte BOM, which would add a
    # phantom character to every caption.
    return len(text.encode("utf-16-le")) // 2
```

- [ ] **Step 4: Run the Python test — expect PASS**

```bash
.venv/bin/python -m pytest worker/tests/test_caption_length.py -q
```

- [ ] **Step 5: Swap the Python call sites**

Replace `len(caption)` with `caption_length(caption)` at `worker/publisher.py:261` and `:263`,
`len(caption)` at `worker/autofill.py:249`, and `len(message)` at `worker/graph_api.py:260`
and `:263`. Add the import to each file. Do not change any limit value.

- [ ] **Step 6: Write and run the TypeScript test**

Create `dashboard/lib/caption-length.test.ts` with the SAME table (see above), asserting
`captionLength()` returns each expected number, plus one case documenting that
`[...s].length` (code points) would give a different answer and is wrong here.

- [ ] **Step 7: Implement the TS side and swap its call sites**

Create `dashboard/lib/caption-length.ts` exporting `captionLength(s: string): number` that
returns `s.length`, carrying a condensed version of the Python docstring — most importantly
the warning that "fixing" this to `[...s].length` would silently break Telegram and Discord.
Then route `caption-limits.ts:70` and the composer's counters through it.

- [ ] **Step 8: Run both suites**

```bash
.venv/bin/python -m pytest worker/tests -q
cd dashboard && npm test && npm run lint
```

- [ ] **Step 9: Commit**

```bash
git add worker/caption_length.py worker/tests/test_caption_length.py worker/publisher.py worker/autofill.py worker/graph_api.py dashboard/lib/caption-length.ts dashboard/lib/caption-length.test.ts dashboard/lib/caption-limits.ts dashboard/components/composer.tsx
git commit -m "fix(captions): count UTF-16 code units on both sides, not code points in the worker"
```

---

### Task 2: The emoji dataset, generated from Unicode

**Files:**
- Create: `dashboard/scripts/build-emoji-data.mjs`
- Create: `dashboard/lib/emoji-data.ts` (generated — committed)
- Create: `dashboard/lib/emoji-search.ts`
- Create: `dashboard/lib/emoji-search.test.ts`

**Interfaces:**
- Produces:
  - `interface Emoji { char: string; name: string; group: string; keywords: string[] }` —
    declared in **`emoji-search.ts`**, which is the module with no dependencies. `emoji-data.ts`
    imports and re-exports it. Declaring it in both files would let the generated copy drift
    from the one the search and the component compile against.
  - `EMOJI: Emoji[]` and `EMOJI_GROUPS: string[]` from `emoji-data.ts`
  - `searchEmoji(all: Emoji[], query: string): Emoji[]` from `emoji-search.ts`

Search lives in its own module so it is testable without importing the ~1,900-entry dataset.

- [ ] **Step 1: Write the failing search test**

Create `dashboard/lib/emoji-search.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { searchEmoji, type Emoji } from "./emoji-search.ts";

const FIXTURE: Emoji[] = [
  { char: "😀", name: "grinning face", group: "Smileys & Emotion", keywords: ["smile", "happy"] },
  { char: "🎉", name: "party popper", group: "Activities", keywords: ["celebration", "tada"] },
  { char: "🔺", name: "red triangle pointed up", group: "Symbols", keywords: ["triangle"] },
];

test("an empty query returns everything, unfiltered", () => {
  assert.equal(searchEmoji(FIXTURE, "").length, 3);
  assert.equal(searchEmoji(FIXTURE, "   ").length, 3);
});

test("matches on name", () => {
  assert.deepEqual(searchEmoji(FIXTURE, "party").map((e) => e.char), ["🎉"]);
});

test("matches on keyword, not just name", () => {
  // "tada" appears nowhere in the name — keyword matching is the whole point.
  assert.deepEqual(searchEmoji(FIXTURE, "tada").map((e) => e.char), ["🎉"]);
});

test("is case- and whitespace-insensitive", () => {
  assert.deepEqual(searchEmoji(FIXTURE, "  PARTY ").map((e) => e.char), ["🎉"]);
});

test("a query matching nothing returns empty, not everything", () => {
  assert.deepEqual(searchEmoji(FIXTURE, "zzzz"), []);
});

test("prefers a name match over a keyword match", () => {
  const results = searchEmoji(FIXTURE, "triangle");
  assert.equal(results[0].char, "🔺", "the name match should rank first");
});
```

- [ ] **Step 2: Run it to verify it fails**

From `dashboard/`: `npm test` — FAIL, module not found.

- [ ] **Step 3: Implement `emoji-search.ts`**

```ts
/**
 * The emoji list and the search over it. Kept free of the generated dataset so it can be
 * tested against a three-item fixture instead of ~1,900 real entries, and so the picker can
 * lazy-load the data without dragging the search logic in twice.
 */
export interface Emoji {
  char: string;
  name: string;
  group: string;
  keywords: string[];
}

/**
 * Emoji matching `query`, name matches first.
 *
 * Two-band ranking rather than a single filter: someone typing "triangle" means the emoji
 * CALLED triangle, not every emoji that merely lists it as a keyword. An empty query returns
 * the input untouched so the caller can render the full grid without a special case.
 */
export function searchEmoji(all: Emoji[], query: string): Emoji[] {
  const q = query.trim().toLowerCase();
  if (q === "") return all;

  const nameHits: Emoji[] = [];
  const keywordHits: Emoji[] = [];
  for (const e of all) {
    if (e.name.toLowerCase().includes(q)) nameHits.push(e);
    else if (e.keywords.some((k) => k.toLowerCase().includes(q))) keywordHits.push(e);
  }
  return [...nameHits, ...keywordHits];
}
```

- [ ] **Step 4: Write the generator**

Create `dashboard/scripts/build-emoji-data.mjs`. It reads Unicode's `emoji-test.txt` (pass a
local path or a URL; default `https://unicode.org/Public/emoji/latest/emoji-test.txt`, ~669 KB)
and writes `dashboard/lib/emoji-data.ts`.

Rules, each of which matters:
- Keep only lines whose status is `fully-qualified`. `minimally-qualified` and `unqualified`
  render inconsistently and would produce near-duplicate grid entries.
- Group comes from the `# group:` comment lines.
- **Collapse skin-tone variants into their base emoji.** A line whose name contains a skin
  tone (`light skin tone`, `medium-light skin tone`, …) is dropped. Without this the grid is
  flooded with five near-identical entries per gesture.
- Keywords: split the emoji's CLDR-style name on spaces and colons, drop stopwords
  (`with`, `and`, `face`, `the`), and keep the rest.
- Emit a header comment marking the file GENERATED, naming the script and the Unicode
  version parsed, so nobody hand-edits it.

- [ ] **Step 5: Generate the data and sanity-check it**

```bash
cd dashboard && node scripts/build-emoji-data.mjs && node --experimental-strip-types -e "
import('./lib/emoji-data.ts').then((m) => {
  console.log('count:', m.EMOJI.length);
  console.log('groups:', m.EMOJI_GROUPS.length);
  console.log('has grinning:', m.EMOJI.some((e) => e.char === '😀'));
  console.log('skin tones collapsed:', !m.EMOJI.some((e) => e.name.includes('skin tone')));
});"
```
Expected: roughly 1,500–2,000 emoji, ~9 groups, grinning present, no skin-tone entries. If
skin tones survive, fix the generator — do not hand-edit the output.

- [ ] **Step 6: Run tests and commit**

```bash
cd dashboard && npm test && npm run lint
git add dashboard/scripts/build-emoji-data.mjs dashboard/lib/emoji-data.ts dashboard/lib/emoji-search.ts dashboard/lib/emoji-search.test.ts
git commit -m "feat(compose): generate an emoji dataset from Unicode, with search"
```

---

### Task 3: The picker component

**Files:**
- Create: `dashboard/components/emoji-picker.tsx`
- Create: `dashboard/lib/insert-at-caret.ts`
- Create: `dashboard/lib/insert-at-caret.test.ts`

**Interfaces:**
- Consumes: `searchEmoji`, `Emoji` (Task 2)
- Produces:
  - `insertAtCaret(text, insert, start, end): { text: string; caret: number }`
  - `<EmojiPicker onInsert={(emoji: string) => void} />`

The caret maths lives in its own pure module because it is the part most likely to be wrong
and the part least convenient to test through a DOM.

- [ ] **Step 1: Write the failing caret test**

Create `dashboard/lib/insert-at-caret.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { insertAtCaret } from "./insert-at-caret.ts";

test("inserts at the caret rather than appending", () => {
  // The bug being prevented: appending to the end for someone editing mid-caption.
  const r = insertAtCaret("Hello world", "😀", 5, 5);
  assert.equal(r.text, "Hello😀 world");
});

test("the caret lands after the inserted emoji, not before it", () => {
  const r = insertAtCaret("Hello world", "😀", 5, 5);
  // '😀' is 2 UTF-16 code units, so the caret moves by 2, not 1.
  assert.equal(r.caret, 7);
  assert.equal(r.text.slice(0, r.caret), "Hello😀");
});

test("replaces a selection", () => {
  const r = insertAtCaret("Hello world", "😀", 0, 5);
  assert.equal(r.text, "😀 world");
  assert.equal(r.caret, 2);
});

test("appends when the caret is at the end", () => {
  const r = insertAtCaret("Hi", "🎉", 2, 2);
  assert.equal(r.text, "Hi🎉");
  assert.equal(r.caret, 4);
});

test("handles an empty field", () => {
  const r = insertAtCaret("", "🔺", 0, 0);
  assert.equal(r.text, "🔺");
  assert.equal(r.caret, 2);
});
```

- [ ] **Step 2: Run it to verify it fails**, then implement `insert-at-caret.ts`:

```ts
/**
 * Splice `insert` into `text` at the caret (or over the selection), and report where the
 * caret should land afterwards.
 *
 * Pure and separate from the component because this is the part that goes wrong: appending
 * to the end is the obvious implementation and is incorrect for anyone editing the middle of
 * a caption. The returned caret is in UTF-16 code units, which is what
 * HTMLTextAreaElement.setSelectionRange expects — an emoji moves it by 2, not 1.
 */
export function insertAtCaret(
  text: string,
  insert: string,
  start: number,
  end: number
): { text: string; caret: number } {
  const next = text.slice(0, start) + insert + text.slice(end);
  return { text: next, caret: start + insert.length };
}
```

- [ ] **Step 3: Build the component**

Create `dashboard/components/emoji-picker.tsx`, `"use client"`. Follow
`components/tag-manager.tsx` for class-constant style and `components/quick-edit-modal.tsx`
for the `Escape` handler pattern (`document.addEventListener("keydown", handler, true)` inside
a `useEffect`, removed on cleanup).

Requirements:
- Trigger: a small button showing 🙂 with `aria-label="Insert emoji"` and
  `aria-expanded`.
- **The dataset is lazy-loaded**: `await import("@/lib/emoji-data")` on first open only, held
  in state. Until it resolves show "Loading emoji…". This keeps ~1,900 entries out of the
  compose page's initial bundle.
- Panel: search input (autofocused), a row of group filter buttons, and a scrolling grid of
  buttons. Cap the rendered grid at 300 results and show a "keep typing to narrow" note
  beyond that, so the DOM never holds two thousand buttons.
- Recents: last 24 used, newest first, in `localStorage` under `ss.emoji.recents`, shown above
  the grid when the search box is empty. Wrap reads/writes in try/catch — a browser with
  storage disabled must degrade to no recents, never crash the composer.
- `Escape` closes and returns focus to the trigger. A click outside the panel closes it.
- Theme tokens only (`border-border`, `bg-surface`, `text-ink`, `text-muted`, `bg-canvas`,
  `hover:bg-surface-sunken`). No hex.
- Apply the emoji font class (Task 4) to the grid so it matches across machines.

- [ ] **Step 4: Run tests, lint, commit**

```bash
cd dashboard && npm test && npm run lint
git add dashboard/components/emoji-picker.tsx dashboard/lib/insert-at-caret.ts dashboard/lib/insert-at-caret.test.ts
git commit -m "feat(compose): add a self-contained emoji picker"
```

---

### Task 4: Wire it in — fields, font, and the OS hint

**Files:**
- Create: `dashboard/lib/emoji-shortcut.ts`
- Create: `dashboard/lib/emoji-shortcut.test.ts`
- Create: `dashboard/components/emoji-hint.tsx`
- Modify: `dashboard/app/layout.tsx` (load Noto Color Emoji)
- Modify: `dashboard/app/globals.css` (an `--font-emoji` token + a utility class)
- Modify: `dashboard/components/composer.tsx` (caption + first comment)
- Modify: `dashboard/components/post-editor.tsx` (caption + first comment)
- Modify: `dashboard/components/caption-variants-editor.tsx`

**Interfaces:**
- Consumes: `<EmojiPicker>` (Task 3), `insertAtCaret` (Task 3)
- Produces: `emojiShortcutHint(platform: string): string | null`, `<EmojiHint />`

- [ ] **Step 1: Write the failing shortcut test**

Create `dashboard/lib/emoji-shortcut.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { emojiShortcutHint } from "./emoji-shortcut.ts";

test("Windows gets the Windows shortcut", () => {
  assert.match(emojiShortcutHint("win32") ?? "", /Win/);
});

test("macOS gets the macOS shortcut", () => {
  assert.match(emojiShortcutHint("darwin") ?? "", /Ctrl.*Cmd.*Space/);
});

test("an unknown platform gets nothing rather than a wrong guess", () => {
  assert.equal(emojiShortcutHint("freebsd"), null);
});
```

- [ ] **Step 2: Implement `emoji-shortcut.ts` and `emoji-hint.tsx`**

`emojiShortcutHint` takes the platform as an argument (same reason as `converterAdvice` — so
every branch is testable from one machine) and returns `null` for anything unrecognised.

`<EmojiHint />` is `"use client"`, detects the OS from `navigator`, and renders one muted line.
**It must render nothing until after mount** — the server cannot know the client's OS, so
rendering platform text during SSR produces a hydration mismatch. Use a `mounted` state set in
`useEffect`.

- [ ] **Step 3: Load Noto Color Emoji**

In `app/layout.tsx`, add `Noto_Color_Emoji` from `next/font/google` beside the existing
`Space_Grotesk` / `Inter` / `JetBrains_Mono`, with `weight: "400"` and a CSS variable
`--font-emoji`. In `globals.css`, add an `.font-emoji` utility that sets
`font-family: var(--font-emoji), "Apple Color Emoji", "Segoe UI Emoji", sans-serif`.

The fallback chain matters: if the webfont fails to load, the OS font still draws something
rather than leaving blanks.

**If `next/font/google` cannot serve this font** (it is unusually large and may be rejected or
time out), fall back to committing the COLRv1 woff2 under `dashboard/public/fonts/` with its
OFL license file alongside, loaded via an `@font-face` rule in `globals.css`. Note in the
report which route was taken and why — do NOT add an npm dependency for this.

- [ ] **Step 4: Wire the picker into each caption field**

For each of composer's caption + first comment, post-editor's caption + first comment, and
caption-variants-editor's textarea:
- add a `useRef<HTMLTextAreaElement>` on the textarea
- render `<EmojiPicker onInsert={...} />` beside that field's label
- in `onInsert`, read `selectionStart`/`selectionEnd` off the ref, call `insertAtCaret`, push
  the new value through the field's existing `set…` state setter, then restore focus and call
  `setSelectionRange(caret, caret)` inside a `requestAnimationFrame` so it runs after React
  has re-rendered the new value
- add `className="font-emoji"` to the textarea so typed emoji match the picker

Render `<EmojiHint />` once under the composer's main caption field only — one tip, not five.

Do NOT touch `bulk-import.tsx`.

- [ ] **Step 5: Run tests and lint, then commit**

```bash
cd dashboard && npm test && npm run lint
git add -A dashboard
git commit -m "feat(compose): emoji picker on every caption field, with a consistent emoji font"
```

---

### Task 5: Verify it in a real browser

The dashboard's test harness renders to static markup, so it cannot catch a handler that
never fires or a panel positioned off-screen. This must be checked in a browser.

**Verification runs against an ISOLATED copy — never the live install.** See the setup at the
end of this task.

- [ ] **Step 1: Stand up an isolated dashboard**

The owner's dashboard runs on port 3939 and **Next 16 refuses a second dev server from the
same directory**, so a plain second `next dev` will exit immediately. Clone the app instead:

```bash
SP=<scratchpad>
cp -Rc "<repo>/dashboard" "$SP/dash-verify/dashboard"   # APFS copy-on-write, ~1s for 500MB
rm -rf "$SP/dash-verify/dashboard/.next"
ln -sf "<repo>/.env" "$SP/dash-verify/.env"
sqlite3 "<repo>/data/socialscheduler.db" ".backup '$SP/verify.db'"
```
Run it on port 3941 with `DATABASE_PATH` and `ASSET_STORAGE_DIR` pointed at the scratch copies
(env vars beat `.env`). Add a `.claude/launch.json` entry for it and **revert that file when
done** — it is tracked.

- [ ] **Step 2: Confirm the picker opens and inserts at the caret**

Open `/compose`, type `Hello world`, place the caret after `Hello`, open the picker, insert an
emoji. Confirm the text reads `Hello😀 world` — **not** `Hello world😀`. Appending is the
failure this step exists to catch.

- [ ] **Step 3: Confirm search, recents, and Escape**

Search `tada` → 🎉 appears (a keyword-only match). Insert two emoji, close and reopen the
picker → both appear in recents, newest first. Press `Escape` → the panel closes and focus
returns to the trigger.

- [ ] **Step 4: Confirm the character counter moves by 2 per emoji**

With a Threads channel selected, watch the counter while inserting one emoji. It must increase
by 2, matching what the worker will now compute.

- [ ] **Step 5: Confirm both themes**

Switch to a dark theme and reopen the picker. Confirm the panel, search box, and grid are all
legible — no invisible text, no white-on-white. Screenshot both.

- [ ] **Step 6: Confirm an inserted emoji survives a round trip**

Save the post, reload the page, reopen it, and confirm the emoji is still there and still
renders. This proves it survived SQLite and the JSON round trip.

- [ ] **Step 7: Run every suite, record results, commit**

```bash
.venv/bin/python -m pytest worker/tests -q
cd dashboard && npm test && npm run lint
```

Append a section to `docs/tasks.md` in the established style with the real numbers, and state
plainly what was NOT verified: Windows rendering (no machine available) and the Threads
counting unit (a safe default, not confirmed by Meta).

Tear down the scratch copy and revert `.claude/launch.json`.

---

## Still open after this plan

**Windows rendering is unverified.** Bundling Noto is what should make the picker identical on
both machines, but no Windows machine is available here. It closes when the second install
runs it.

**The Threads counting unit is still a guess.** Chosen as the stricter of two candidates so
that being wrong warns early rather than failing a publish. If Meta ever documents it, the
table in the spec is where the citation belongs.
