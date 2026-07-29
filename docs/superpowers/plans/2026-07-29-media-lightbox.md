# Media Lightbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click a badge on a Library thumbnail to watch the video with controls, or see the photo at full size, without leaving the page.

**Architecture:** One portal-rendered modal shared by both media kinds, opened by an explicit overlay button so the card's two existing click behaviours (bulk-select, link to the post editor) are untouched. It requests `/api/media/[id]`, which already resolves video → H.264 derivative and image → original.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, Tailwind v4 with CSS-variable themes. **No new dependencies** — the modal is hand-rolled, not a library.

Design spec: `docs/superpowers/specs/2026-07-29-media-lightbox-design.md`

## Global Constraints

- **No new dependencies** (npm or pip). No schema change, no API change, **no worker change**.
- **Theme tokens:** 7 theme families × light/dark = **14 palettes**. Every utility class must already exist in `dashboard/app/globals.css` — an invented class renders unstyled or invisible in some themes. Verify against neighbouring components; a previous sub-project shipped a fictional `text-danger` this way.
- **Never modify the live `data/socialscheduler.db`.** It contains a real published Reel, and there is **no delete-asset API** to undo a stray write. This feature is read-only — it should not need to write anything.
- **Never change `DRY_RUN` or `KILL_SWITCH`** in `.env` (currently `1` / `0`).
- **The worker daemon is running** in dry-run. Do not stop it and do not create publications.
- A dev server is already running on port **3939** — reuse it, do not start another.
- Existing test assets: **asset 8** is a converted video (`cover_frame_ms` 2600, has a derivative); **asset 1** is an image. Post **2** is the Reel, post **1** is the image post.
- Checks at the end of every task: `cd dashboard && npx tsc --noEmit`, and the `dashboard/scripts/smoke-*.mjs` scripts (note `smoke-content-model.mjs` has a **pre-existing unrelated failure** — confirm it is identical rather than assuming it is yours).

---

### Task 1: The lightbox and its trigger badge

**Files:**
- Create: `dashboard/components/media-lightbox.tsx`
- Test: browser-verified in Task 2 (there is no React test runner in this repo — do not add one)

**Interfaces:**
- Produces two exports from `media-lightbox.tsx`:
  - `MediaLightbox({ asset, label, onClose })` — the modal. `asset` needs at least `{ id, media_kind, cover_frame_ms, width, height }`.
  - `MediaBadge({ mediaKind, onOpen, label })` — the overlay button placed on a thumbnail.

Colocating both in one file is deliberate: the badge exists only to open the lightbox, and splitting them would spread one behaviour across two files.

- [ ] **Step 1: Read the surrounding conventions first**

Before writing anything, read:
- `dashboard/components/conform-control.tsx` — the closest existing "control overlaid on media" and the reference for this codebase's class vocabulary.
- `dashboard/components/cover-frame-picker.tsx` — how a `<video>` is set up here (`preload`, `muted`, `playsInline`) and how the `#t=` media fragment is applied.
- The shared video-preview URL helper added for the Safari fix — find it (grep for `#t=`) and **reuse it**; do not re-derive the fragment logic.
- `dashboard/app/globals.css` — the actual token names. Note `text-status-failed` is the error token; there is no `text-danger`.

- [ ] **Step 2: Build `MediaBadge`**

A real `<button type="button">`, absolutely positioned over the thumbnail. A play glyph for `video`, an expand glyph for `image`. Inline SVG — **do not add an icon dependency**; check whether the codebase already has inline SVGs to match in style.

It must:
- Call `e.stopPropagation()` in its `onClick` before invoking `onOpen`, so the Library card's selection toggle does not also fire.
- Carry an accessible name (e.g. "Play video" / "View image", including the post title if available).
- Be visible against both a bright and a dark thumbnail — a semi-transparent scrim behind the glyph, not a bare glyph.

- [ ] **Step 3: Build `MediaLightbox`**

Rendered through `createPortal` into `document.body` so it escapes the card's `overflow-hidden` and stacking context.

Requirements, all of which the spec calls out as non-optional:
- `role="dialog"`, `aria-modal="true"`, and an accessible label naming the post.
- **Escape** closes; **clicking the backdrop** closes (but clicking the media itself must not); a real close `<button>` closes.
- **Focus moves into the dialog on open and returns to the trigger on close.** Focus is trapped while open — Tab from the last focusable element wraps to the first.
- Body scroll is locked while open and restored on close (including if the component unmounts while open).

Media rendering:
- **Video:** `<video controls playsInline>` with `src` from the shared preview-URL helper so it opens at `cover_frame_ms`. **`autoPlay` must be off** — an overlay that starts making noise on open is hostile.
- **Image:** `<img>` at natural size, capped to the viewport (`max-h`/`max-w`) so a large photo does not overflow.
- Both: handle the element's `error` event and render a short visible message instead of a black box, since an asset file can be missing or (for a pre-conversion video) undecodable.

- [ ] **Step 4: Typecheck and commit**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit
```

```bash
git add dashboard/components/media-lightbox.tsx && git commit -m "feat(dashboard): media lightbox and its trigger badge"
```

---

### Task 2: Wire it into the Library and verify

**Files:**
- Modify: `dashboard/components/library-view.tsx`

**Interfaces:**
- Consumes `MediaLightbox` / `MediaBadge` from Task 1.

**The regression that matters most:** the Library card already has two click behaviours, and this adds a third. They must all still work:
- The card `onClick` (`library-view.tsx:285`) toggles **bulk-selection**.
- A nested `<Link>` (`:301-304`) opens the **post editor**, with `stopPropagation` so it does not also toggle selection.
- The card's `onKeyDown` has a `closest("a")` guard so keyboard activation of that link does not toggle selection.

The badge sits on top of the thumbnail and stops propagation. **Do not restructure any of the existing handlers** — if it looks like you need to, stop and report rather than working around it.

- [ ] **Step 1: Add the badge and lightbox state**

Hold which asset is open in component state (`null` when closed). Render the badge inside the existing thumbnail container (`:299`), which is already `relative`, so absolute positioning needs no layout change.

Render the badge for **both** media kinds — the spec is explicit that images get it too.

- [ ] **Step 2: Verify in the browser**

Dev server on port **3939** — reuse it. Use post 2 (the video, asset 8) and post 1 (the image, asset 1).

Confirm each of these, and report them individually rather than as "verified":
- Badge opens the lightbox for **video**; it plays with controls and sound; it opens paused at the 2.6s cover frame.
- Badge opens the lightbox for the **image**; it shows at full size.
- **Escape** closes; **backdrop click** closes; **close button** closes; clicking the media itself does **not** close.
- **Bulk-selection still works** — clicking the card body toggles it, and clicking the badge does **not** toggle it.
- **The editor link still works** — clicking the thumbnail (not the badge) still navigates to `/library/2`.
- **Keyboard:** Tab reaches the badge; Enter/Space opens; focus lands inside the dialog; Tab cycles within it; Escape returns focus to the badge.
- **Theme:** check light **and** dark. Confirm every class you used exists in `globals.css`.
- Browser console is free of errors and React warnings.

Take screenshots of the video lightbox and the image lightbox and reference their paths in your report.

- [ ] **Step 3: Confirm nothing else regressed**

```bash
cd "/Users/kelanliparoto/Documents/Claude Projects/Apps/SocialScheduler/dashboard" && npx tsc --noEmit && for f in scripts/smoke-*.mjs; do echo "== $f"; node "$f" >/dev/null 2>&1 && echo PASS || echo FAIL; done
```

Expected: all PASS except `smoke-content-model.mjs`, which fails identically before this branch.

Confirm the live database was not written to: row counts for `posts`, `publications`, `assets`, `post_assets` unchanged, and `PRAGMA foreign_key_check` empty.

- [ ] **Step 4: Commit**

```bash
git add dashboard/components/library-view.tsx && git commit -m "feat(dashboard): open media from the Library in a lightbox"
```

---

## Self-review notes

**Spec coverage.** Decision 1 (explicit badge) → Task 1 Step 2 + Task 2 Step 1. Decision 2 (one component, both kinds) → Task 1 Step 3. Decision 3 (uses `/api/media/[id]` unchanged) → Task 1 Step 3, with no new resolution logic anywhere. Decision 4 (opens at the cover frame, no autoplay) → Task 1 Step 3. Decision 5 (accessibility) → Task 1 Step 3 and Task 2 Step 2's keyboard checks. Decision 6 (Library only) → Task 2 touches no other surface.

**The risk in this plan is Task 2, not Task 1.** Building a modal is routine; adding a third click target to a card that already has two overlapping ones is where a regression hides. That is why the verification list names bulk-selection and the editor link explicitly rather than leaving them under "check it still works".
