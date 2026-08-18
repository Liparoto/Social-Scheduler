# Download an asset to your computer

**Date:** 2026-08-17
**Status:** approved

## Problem

Every image and video in the dashboard is viewable but not *gettable*. The files live in
`/data/assets` under content-hash names, so "just go find it in Finder" means hunting an
opaque filename. The owner wants a copy of any asset on their computer, from wherever they
happen to be looking at it.

## Why not a save-file dialog

The request asked for an OS save-file window, on the reasoning that it is more portable
across operating systems and other users. It is the opposite.

`showSaveFilePicker()` (the File System Access API) is **Chromium-only**. It does not exist
in Safari — the browser this install's owner uses — and not in Firefox. Building on it would
mean the feature silently does nothing for the primary user, plus a fallback path anyway.

`Content-Disposition: attachment` is universal. Where the file lands is then the *browser's*
decision, which is the correct place for it:

- Safari → Settings → General → "File download location: Ask for every download"
- Chrome/Edge → Settings → Downloads → "Ask where to save each file"

Ticking that box once gives the save dialog on every OS. Leaving it unticked gives
straight-to-Downloads. One implementation serves both preferences and every browser.

## Decisions

| Decision | Choice |
|---|---|
| Coverage | Lightbox button + hover icon on Media Manager and Library thumbnails |
| Which file | The original as uploaded — not the conformed publish derivative |
| Media types | Images and videos both |

### Video downloads the original, not the preview

The preview path deliberately serves the H.264 *derivative* for video, because Chrome cannot
decode iPhone HEVC (see the comment in `app/api/media/[id]/route.ts`). Download serves the
**original**. It is the higher-quality file and plays fine on a Mac.

This is a knowing divergence: for an HEVC upload, the bytes you download are not the bytes
you were just watching. Accepted — "original as uploaded" was the explicit choice, and the
original is what a person asking for "a copy of my video" means.

## Design

### 1. Server: `?download=1`

`GET /api/media/[id]?download=1` reuses the existing `serveFile` helper, which already
handles Range and MIME. The flag adds one response header and forces the variant to the
original `storage_path`, bypassing `thumb` / `story` / `publish` and the video-derivative
rule.

```
Content-Disposition: attachment; filename="beach-day.jpg"; filename*=UTF-8''beach-day.jpg
```

The header is set on both the 200 and the 206 responses, so a resumed download keeps its
filename.

### 2. Filename derivation — `lib/download-filename.ts`

A pure function, colocated test, matching the repo's `lib/<name>.ts` + `lib/<name>.test.ts`
convention.

`downloadFilename(originalFilename, assetId, storagePath)` returns a safe name.

Rules:
- Use `assets.original_filename` when present; otherwise `asset-<id><ext>` with the
  extension taken from `storage_path`.
- Strip directory components — a stored name of `../../etc/passwd` must reduce to `passwd`.
- Strip ASCII control characters, `"`, `\`, and newlines. **This is a correctness
  requirement, not hygiene:** a quote or CR/LF in a header value corrupts the response, and
  a newline is response-splitting.
- Preserve the extension so the OS opens the file with the right app.
- Fall back to `asset-<id>` if sanitizing leaves nothing.

Non-ASCII (emoji, accents) is handled by emitting **both** header forms: an ASCII-folded
`filename=` for old parsers and a percent-encoded RFC 5987 `filename*=` that modern browsers
prefer. This project has already been bitten by naive string handling of emoji
(`caption-slice-breaks-hydration`), so the encoding is explicit rather than assumed.

### 3. Client: `<DownloadMediaButton>`

A plain anchor. No fetch, no blob, no clipboard API:

```tsx
<a href={`/api/media/${assetId}?download=1`} download>
```

One shared component in `components/download-media-button.tsx`, with a `variant` prop.
Three variants rather than two, because measuring the real grids in the browser showed the
two thumbnail surfaces are nothing like the same size:

- `"lightbox"` — icon button in the full-size viewer, top-left. Close owns the top-right and
  the carousel chevrons own the vertical midpoints; that corner is the only free one.
- `"overlay"` — always visible, 24px, beside `MediaBadge`. For Media Manager, whose tiles
  measure **230×230**.
- `"overlay-compact"` — 20px, opposite corner from `MediaBadge`, hidden until the card is
  hovered or the link is focused. For Library card chips, which measure **64×64** — a
  second always-visible 24px control there covers most of the picture the chip exists to
  show. Keyboard access is preserved via `focus-visible`, and touch users reach the
  always-visible lightbox button, which is where tapping the chip leads anyway.

The component stops click propagation. Both thumbnail grids sit inside click-to-open cards,
so without it a download click would also pop the lightbox open behind the save.

### 4. Call sites

| File | Placement |
|---|---|
| `components/media-lightbox.tsx` | `lightbox` variant, in the control cluster |
| `components/media-manager.tsx` | `overlay` on each 230px tile |
| `components/library-view.tsx` | `overlay-compact` on each 64px card chip |

The lightbox is reached from Library, Post editor, Queue and Media Manager, so one button
there covers four surfaces. Small chips (calendar, slide reorder, bulk import) are
deliberately excluded — they are already crowded, and all of them lead to a surface that
has the button.

Not in scope: channel avatars (not the user's content) and Insights thumbnails (cached
Instagram renders served by a different route, not local assets).

## Out of scope

- Bulk / zip download of a whole carousel or the entire library
- Downloading the conformed publish derivative
- Any schema, migration, or worker change — there are none

## Verification

- `lib/download-filename.test.ts` — traversal, control characters, quotes, emoji, missing
  name, missing extension
- `test/media-download-route.test.ts` — header present and correct on `?download=1`, absent
  without it, original served rather than thumb/derivative
- `npm run lint` stays at 0 errors
- A real browser pass, since a rendered-markup test cannot prove a download happened and
  the compact overlay needs a real pointer.

### What the browser pass actually showed (2026-08-17)

- 111 download links render across the Library grid; the compact ones correctly stay
  `opacity-0` until hover, and appear on hover.
- Live headers against real assets:
  `attachment; filename="YELLOWSTONE 2.jpg"; filename*=UTF-8''YELLOWSTONE%202.jpg` — the
  space is literal inside the quoted form and percent-encoded in the RFC 5987 form, as it
  should be.
- `?download=1` returned 9,905,067 bytes where `?variant=thumb` returned 39,643 — proof the
  original is served rather than the thumbnail.
- The in-app browser sandbox blocks downloads, so the save itself was proven with
  `curl -OJ` (which obeys Content-Disposition): files landed as `IMG_4007-2.jpg` and
  `YELLOWSTONE 2.jpg`, full resolution, EXIF intact.

### One harness fix this required

`test/ui-hook.mjs` resolved extensionless relative imports as `.ts` only, so any component
importing a sibling **`.tsx`** failed to load and took its parent's UI test down with an
error naming the import rather than the cause. The `@/` branch beside it had always handled
both; the relative branch now does too.
