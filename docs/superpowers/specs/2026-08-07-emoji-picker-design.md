# An emoji picker in the composer, and caption counting that matches each platform

**Date:** 2026-08-07
**Status:** designed

## The problem

Two problems, found together, that both come down to "emoji are not one character."

**1. There is no way to enter an emoji in this app.** Both operating systems ship a picker
(macOS `Ctrl+Cmd+Space`, Windows `Win+.`) and both work in the caption fields today, but a
non-developer has to know the shortcut exists. The second install's owner did not.

Worse on Windows specifically: emoji are drawn in Segoe UI Emoji, and an older Windows build
renders any emoji newer than its font as an empty box. The composer preview then disagrees
with what the audience will actually see.

**Worth stating plainly, because it drove the original request:** a picker cannot make emoji
look like an iPhone's, and does not need to. Emoji are Unicode codepoints; what gets
published is the codepoint, and it is drawn by the *viewer's* device. An iPhone viewer
already sees Apple's artwork regardless of which machine composed the post. The problem being
solved is the author's own view and their ability to find an emoji at all — not the
audience's.

**2. The dashboard and the worker count caption length differently, and the worker is wrong.**

```
'Great day! 😀🎉🔺'   worker  (Python len)     = 14   <- code points
                       dashboard (JS .length)   = 17   <- UTF-16 code units
```

`platforms.ts:7` states the worker "is authoritative and re-validates every publish." It is
the authoritative side that under-counts, at `publisher.py:261`. A caption near a platform's
limit can pass the worker's check and then be refused by the platform's API — a post that
reads "scheduled" and dies terminally at send time. `CLAUDE.md` requires failed publishes to
be visibly failed; this makes them fail *late* rather than never happening.

Adding a picker makes emoji far easier to insert, which turns a latent bug into a likely one.
That is why these ship together.

## What each platform actually counts

Researched rather than assumed. This table is the reason for the chosen unit and should be
updated only with a citation.

| Platform | Limit | Unit | Confidence |
|---|---|---|---|
| Telegram | 4096 text / 1024 media | **UTF-16 code units** | **Verified.** Telegram's entities spec is explicit: BMP counts 1, everything else counts 2. |
| Discord | 2000 | **UTF-16 code units** | **Verified.** Emoji cost 2; a ZWJ family costs 7+. Consistent with its JS origins. |
| Threads | 500 | **Unknown** | Meta's docs say "500 characters" without defining the unit. Third-party trackers actively contradict each other (1 vs 2 per emoji). |
| Instagram | — | n/a | `captionChars: {}` — no limit enforced by this app. |
| Facebook | — | n/a | `captionChars: {}` — no limit enforced by this app. |

## Decisions

**Count UTF-16 code units everywhere, and fix the worker rather than the dashboard.**
Telegram and Discord verifiably require it and Python is currently wrong for both. Threads is
genuinely unknown, and UTF-16 is the *stricter* of the two candidates:

- If Threads counts code points and we count UTF-16, we warn slightly early on an
  emoji-dense caption. Cosmetic.
- If Threads counts UTF-16 and we count code points, we let a too-long caption through and
  the publish dies terminally. Not cosmetic.

This is the same reasoning `platforms.ts` already applies elsewhere ("under-promises rather
than letting an unknown platform look infinitely permissive"). **The Threads choice is a safe
default, not a verified fact, and must be documented as such** — if it is ever confirmed, the
table above is where the citation goes.

**Bundle Noto Color Emoji.** It is [SIL OFL 1.1](https://github.com/googlefonts/noto-emoji/blob/main/fonts/LICENSE)
licensed, so redistribution is permitted with attribution, and COLRv1+woff2 is about 1.85 MB.
This makes the picker and the caption fields render identically on macOS and Windows and
removes the tofu problem entirely. Apple Color Emoji is proprietary and is not an option; no
amount of wanting it changes that.

Scope the font to the picker and the caption/preview surfaces rather than the whole app, so
it never overrides the existing display/body/mono fonts.

**Generate the emoji dataset from Unicode's own `emoji-test.txt`, commit the result, and add
no runtime dependency.** The dashboard runs on six runtime dependencies and that restraint is
worth keeping (`CLAUDE.md`: no new dependencies without clear value over built-ins). A picker
library like `emoji-mart` would bring a large tree for something that is, in the end, a
filtered list and a grid.

The generator script is committed alongside the data so the set can be regenerated when
Unicode publishes a new version — the data file is a build artifact with a recorded
provenance, not hand-maintained.

**Lazy-load the dataset.** It is only needed once someone opens the picker, so it must not
sit in the composer's initial bundle. A dynamic import keeps the compose page's cost at zero
until the button is clicked.

**Store "recently used" in `localStorage`, not the database.** It is per-person UI
preference, not publishable content. Putting it in SQLite would mean a migration, a schema
change, and a sync concern between two processes, to remember which emoji someone likes.

## How it works

### `dashboard/lib/caption-length.ts` (new) and `worker/caption_length.py` (new)

One named function per side, each documenting the unit and pointing at the table above:

- TS: `captionLength(s: string): number` returns `s.length` — already correct, but naming it
  stops a future reader from "fixing" `.length` into `[...s].length` and silently breaking
  Telegram and Discord.
- Python: `caption_length(s: str) -> int` returns `len(s.encode("utf-16-le")) // 2`.

Every existing call site switches to these. Behaviour changes on the Python side only.

### `dashboard/lib/emoji-data.ts` (generated) + `dashboard/scripts/build-emoji-data.mjs`

The generator parses `emoji-test.txt`, keeps only `fully-qualified` entries, and emits
`{ char, name, keywords, group }`. Skin-tone variants collapse under their base emoji rather
than appearing as separate grid entries, which otherwise floods the grid with near-duplicates.

### `dashboard/components/emoji-picker.tsx` (new)

A self-contained client component. Props: `onInsert(emoji: string)`. It owns its open state,
search, category filter, and recents; it knows nothing about captions or posts.

- Trigger button sits beside the field's label.
- Panel: search input, category tabs, grid, recents row.
- `Escape` closes and returns focus to the field. Click-outside closes.
- Insertion happens **at the cursor**, not appended — the caller owns the textarea ref and
  splices at `selectionStart`/`selectionEnd`, then restores the caret after the inserted
  emoji. Appending to the end would be wrong for anyone editing mid-caption.

### Where it appears

`composer.tsx` (caption and first comment), `post-editor.tsx`, and
`caption-variants-editor.tsx` — the three places a caption is genuinely authored. Deliberately
not `bulk-import.tsx`, which is a paste-many-at-once flow where a per-field picker is noise.

### The OS-shortcut hint

Kept from the earlier smaller design and still worth shipping: `emojiShortcutHint(platform)`
returns the OS shortcut, rendered as one muted line under the caption box. The picker does not
make it redundant — the OS picker works in every other app on their computer, and the hint is
how they find out.

Platform detection cannot run during server rendering (the server does not know the client's
OS), so the component renders nothing until after mount. Otherwise React reports a hydration
mismatch.

## Testing

- `caption-length` unit tests on both sides, asserting the same strings produce the same
  numbers in TypeScript and Python — the disagreement is the bug, so a test that pins both
  sides to one table of expected values is the regression guard.
- `emojiShortcutHint` for win32 / darwin / other.
- Emoji-data generator: parses a fixture, drops non-fully-qualified rows, collapses skin tones.
- Picker: search matches by name and keyword; insertion splices at the caret rather than
  appending; `Escape` restores focus.
- Browser verification against an isolated dashboard copy (never the live install), on both a
  light and a dark theme, confirming the grid renders and an inserted emoji survives a save.

## Risks

**Windows rendering is unverifiable here.** Bundling Noto is precisely what should make this
platform-independent, but "should" is doing work — no Windows machine is available. Same
caveat as the ffmpeg work.

**The Threads unit remains a guess.** Documented as such. The failure mode of being wrong is
an early warning, not a failed publish, which is the direction chosen deliberately.

**Dataset size.** Roughly 1,900 emoji with keywords. If the generated file proves large enough
to hurt the compose page even lazily, the fallback is to drop keywords for rarely-used groups
rather than to add a dependency.
