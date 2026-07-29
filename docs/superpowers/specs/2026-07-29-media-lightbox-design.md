# Media Lightbox — Design

**Date:** 2026-07-29
**Goal:** Let the owner actually *look at* their media from the Library — watch a Reel with
controls and sound, or see a photo at full size — without leaving the page.

## Why

The Library shows a 64px thumbnail and nothing more. For a video that is barely a hint: after the
Reels work shipped, the owner's first reaction was *"it is also needed to allow it to play in the
library page so you can see the full video."* A scheduling tool whose whole purpose is making the
process legible should let you see what you are about to publish.

## The constraint that shapes the design

The Library card already carries **two** click behaviours:

- The **card** (`role="button"`) toggles bulk-selection — `library-view.tsx:285`.
- The **thumbnail and title** are a nested `<Link>` to the post editor, with `stopPropagation`
  so it does not also toggle selection — `library-view.tsx:301-304`. There is a matching
  `closest("a")` guard in the card's `onKeyDown` for keyboard activation.

Playback is a **third** behaviour on a 64px tile. Any design that overloads an existing target
breaks one of the two that already work.

## Decisions

### Decision 1 — An explicit play/expand badge, not an overloaded thumbnail

A small badge overlays the thumbnail. Clicking it `stopPropagation`s and opens the lightbox.
Bulk-selection and the editor link are untouched.

Rejected alternatives:
- **Controls on the 64px tile** — unusable at that size, and precisely the default-template look
  CLAUDE.md says to flag rather than ship.
- **Click the thumbnail to play** — steals the existing route into the post editor.
- **Hover-to-autoplay** — cannot scrub or hear it, and fires constantly while merely reading the
  list.

The badge is also the **only** signal on the card that distinguishes a video tile from an image
tile at a glance, which the Library does not currently convey.

### Decision 2 — One lightbox for both video and images

The owner asked for images too: *"click a photo, see it full size."* Retrofitting a second
component later would be worse than building one now.

The component takes an asset and renders a `<video controls>` or an `<img>` based on
`media_kind`. Everything else — overlay, focus handling, dismissal, sizing — is shared.

### Decision 3 — The lightbox uses `/api/media/[id]`, and inherits its rules

**No variant is requested.** That route already resolves the right file per media kind:

- **Video → the derivative** (`publish_path`). This is not a preference, it is a requirement: an
  iPhone original is routinely HEVC, which Chrome cannot decode at all. Serving the original
  would give a black player, the exact bug fixed in `2a356e4`.
- **Image → the original.** What the owner uploaded, at full size, which is what "see it full
  size" means. The Instagram-conformed derivative is already viewable through `ConformControl`.

One rule, already implemented and already tested. The lightbox adds no new resolution logic.

### Decision 4 — Video opens at the chosen cover frame and does not autoplay

The lightbox seeks to `cover_frame_ms` where one is set (via the existing `#t=` media fragment
helper, which is also what makes Safari paint a frame at all), so the first thing shown is the
frame the owner picked as the cover.

**It does not autoplay.** An overlay that starts making noise the moment it opens is hostile, and
the owner may be opening it simply to look at the cover.

### Decision 5 — Accessible by default, because it is a modal

A modal is the easiest thing to build inaccessibly. Required, not optional:

- `role="dialog"` with `aria-modal="true"` and a label naming the post.
- **Escape closes it**; clicking the backdrop closes it; the close control is a real `<button>`.
- **Focus moves into the dialog on open and returns to the badge on close.** Focus is trapped
  while open.
- The badge itself is a `<button>` with an accessible name, reachable by keyboard — not a `<div>`
  with an `onClick`.

Rendered via a portal so it escapes the card's `overflow-hidden` and stacking context.

### Decision 6 — Library only in v1

The same badge would suit the publication queue, the composer and `schedule-from-library`. But
each has its own layout and click semantics, and shipping one surface well beats four surfaces
half-checked. The component is built to be reusable; adding a surface later should be importing
it and passing an asset.

## Components

**`dashboard/components/media-lightbox.tsx`** *(new)* — the overlay. Props: the asset (id,
`media_kind`, `cover_frame_ms`, dimensions for sizing), a label for the dialog, and `onClose`.
Owns focus management, Escape/backdrop dismissal, and the portal.

**`dashboard/components/media-badge.tsx`** *(new, or colocated if small)* — the thumbnail overlay
button. Shows a play glyph for video and an expand glyph for an image.

**`dashboard/components/library-view.tsx`** *(modify)* — render the badge over the thumbnail; hold
the open-lightbox state. The existing card `onClick`, `onKeyDown`, `closest("a")` guard and the
nested `<Link>` must be **behaviourally unchanged** — the badge sits on top and stops propagation.

No API changes. No schema changes. No worker changes.

## Data flow

1. Library renders a card. If it has an asset, the badge is overlaid on the thumbnail.
2. Clicking the badge stops propagation (so selection does not toggle) and opens the lightbox for
   that asset.
3. The lightbox requests `/api/media/<id>`, appending `#t=<cover>` for video.
4. Escape, the backdrop, or the close button dismisses it; focus returns to the badge.

## Error handling

- **An asset whose file is missing** — the route 404s. The lightbox shows a plain message rather
  than an empty black box, so a missing file is legible instead of looking broken.
- **A codec the browser cannot decode** — should not happen for video, since the derivative is
  H.264 by construction, but an in-spec video uploaded before automatic conversion existed may
  have no derivative. Handle `<video>`'s `error` event with the same visible message.

## Testing

- **Behavioural, in the browser:** the badge opens the lightbox; video plays with controls and
  opens at the cover frame; an image shows at full size; Escape, backdrop and the close button all
  dismiss; **bulk-selection and the editor link still work exactly as before** (the regression that
  matters most).
- **Keyboard:** the badge is tabbable and activates on Enter/Space; focus enters the dialog and
  returns to the badge on close; focus does not escape the dialog while open.
- **Theme:** the overlay renders correctly in light and dark. Every utility class must exist in
  `dashboard/app/globals.css` — this codebase has 7 theme families × light/dark and an invented
  class renders invisible in some of them.

## Out of scope

- The badge on other surfaces (queue, composer, `schedule-from-library`) — Decision 6.
- Gallery navigation between assets (next/previous) — the Library is one asset per card today.
- Editing, trimming, or re-framing from the lightbox. It is for looking, not changing.
- Downloading the original.
