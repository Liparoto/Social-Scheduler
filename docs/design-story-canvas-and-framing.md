# Design — The 9:16 story canvas, and framing you can see and change

**Status:** approved 2026-08-04, ready for implementation planning
**Depends on:** image conformance (migration `0006`, `dashboard/lib/conform.ts`), the story
surface (migration `0014`), the media route's `variant` dispatch, and `sharp` — all shipped.
**Feeds:** confidence — you can see what each framing choice does before committing to it, and
change your mind afterwards.

---

## 1. Purpose

Two problems, one root cause.

**A landscape or square photo sent to a Story is badly served today.** Stories are 9:16
(0.5625). Conformance targets the *feed's* 4:5–1.91:1 range, so the conformed derivative is
the wrong shape for a Story — which is why the story publish path deliberately sends the
untouched original instead (`docs/design-instagram-stories.md` §4). That is right for a source
that is already 9:16, and wrong for one that isn't: Instagram then applies its own fit, and the
owner has no say in it.

**The framing control is unusable, in two specific ways** — both verified, not assumed:

1. **The preview cannot show what it exists to show.** `conform-control.tsx:85` renders it at
   `h-10 w-10` (40×40px) with `object-cover`. `object-cover` *crops* — so Crop and Pad render
   **identically**. The single control meant to distinguish two options is incapable of it.
2. **The choice is one-way.** `conform-control.tsx:51`:
   ```tsx
   if (reviewed) {
     return <p>Framing set{mode !== "none" ? ` — ${mode}` : ""}</p>;
   }
   ```
   Once chosen, the buttons are replaced by static text. The API endpoint still works; the UI
   simply stops offering it. There is no way to change your mind.

The root cause both share: **one derivative per asset, chosen once, never shown.** A Story and
a feed post want differently-shaped images, so a single `publish_path` cannot serve both — and
a 40px thumbnail cannot justify either.

### Decisions taken (owner, 2026-08-04)

| Question | Decision |
|---|---|
| Scope | **One project.** The canvas would otherwise ship into the broken picker. |
| Canvas options | **Blurred fill (default) + crop-to-fill.** No solid bars for Stories. |
| Where framing lives | **A per-image Framing dialog**, always re-openable. |

Solid/white bars were dropped for Stories specifically: on a full-bleed surface they read as a
photo that didn't fit rather than a deliberate choice. `pad` remains available for the *feed*,
where it is a reasonable look and already shipped.

---

## 2. Schema — migration `0015_story_framing.sql`

```sql
ALTER TABLE assets ADD COLUMN story_path TEXT;          -- 9:16 derivative; NULL = send the original
ALTER TABLE assets ADD COLUMN story_mode TEXT NOT NULL DEFAULT 'blurred'
                                         CHECK (story_mode IN ('blurred', 'crop'));
```

Additive; no rebuild. Mirrors the existing `publish_path` / `conform_mode` pair rather than
introducing a general `asset_derivatives` table — a table would generalise to a future Facebook
Page Story, but that adapter does not exist and the pair-of-columns shape is what this codebase
already uses for exactly this job. Revisit if a third surface ever lands.

Feed framing (`publish_path`, `conform_mode`, `needs_review`) is **unchanged**. The point of the
second pair is that the two surfaces stop competing for one derivative.

### `story_path` is NULL when the source is already 9:16

A source within **±2% of 0.5625** needs no canvas — the original is already the right shape, and
sending it untouched is what the story path already does correctly. Asset 173 (1320×2346,
ratio 0.5627) is inside that band, so the first real Story's behaviour does not change.

A canvas is generated **only** when the source genuinely does not fit. This keeps the common
"shot vertically for Stories" case on the zero-processing path.

---

## 3. The Framing dialog

Opens from the framing badge on any image — **always**, including after a choice has been made.
Deleting the `if (reviewed) return <p>…</p>` early return is the literal fix for problem 2.

Two columns side by side, each with a preview large enough to judge:

| **Feed** (4:5 – 1.91:1) | **Story** (9:16) |
|---|---|
| Crop · Pad | Blurred fill · Crop to fill |

Each option states its cost in concrete terms computed from the real dimensions, not a generic
caution. For a 4032×3024 source: blurred fill *"keeps the whole photo"*; crop to fill *"loses
58% of the width"*. The source dimensions are shown, so "why is this being reframed at all" is
answerable from the dialog.

The Story column appears for every image, not only ones currently targeted at a Story — the
dialog is opt-in (you clicked it), and pre-deciding is useful.

### What changing framing affects, stated plainly

Framing is editable forever, so the dialog has to be honest about the blast radius:

- **Already posted:** unchanged. Instagram has what it has; we cannot and do not rewrite it.
- **Scheduled but not yet sent:** *"2 scheduled sends will use the new framing"* — shown when
  such publications exist, because that is a real consequence of the click.
- **Evergreen recycling:** future sends use the new framing. This is the desirable case and
  needs no warning.

`needs_review` survives as a nudge — *"we chose for you, you haven't looked"* — but it no longer
gates access to the controls. Its only job now is drawing attention, not permission.

---

## 4. Generating the canvas

**Feed derivative: on upload, unchanged.**

**Story derivative: lazily.** Most images are never storied, so generating a canvas for every
upload is wasted CPU and disk.

It is generated when the Framing dialog first opens — both options, so they can be compared —
and served through the media route's existing dispatch as
`/api/media/[id]?variant=story&mode=blurred|crop`, cached on disk under `story/`, the same shape
as today's `pub/`. Choosing one records it in `story_path` and `story_mode`.

Because both variants are cached after first render, switching between them is instant and
free. That is what makes "change your mind" cheap enough to be true in practice rather than
just permitted.

### The two treatments

Both output exactly **1080×1920**.

- **Blurred fill** — the photo is scaled to fit inside the canvas (`fit: inside`), and an
  enlarged, blurred, slightly darkened copy of the *same photo* fills the space behind it.
  Nothing is lost. A 4032×3024 source becomes a 1080×810 band on a filled canvas.
- **Crop to fill** — scaled to cover the canvas and cropped (`fit: cover`), using sharp's
  `attention` strategy to choose the region. Edge-to-edge, at the cost of everything outside
  the crop.

**Conformance must not run on these.** The feed pipeline's job is to force an image into
4:5–1.91:1; a story canvas is deliberately 0.5625 and must reach Instagram unmodified.

---

## 5. What publishing changes

One candidate added to the precedence built for Stories:

```
story surface:  public_url → story_path → original → conformed
feed surface:   public_url → conformed → original                 (unchanged)
```

`story_path` is NULL for already-9:16 sources, so they continue sending the untouched original.

**The worker needs no query change** — `db.get_ordered_assets` selects `a.*`, so `story_path`
arrives automatically. Only `_resolve_url` and `_resolve_local_path` gain the extra candidate.

If `story_path` is set but the file is missing, the existing `_validate_media_available` fails
the publication loudly before anything is sent. No new failure path is introduced.

The composer's Story chip gains a note when the source is not 9:16 — *"will be reframed to
9:16"* — so reframing is stated before scheduling rather than discovered afterwards, matching
how the *"4 slides → 4 Stories"* note already works.

---

## 6. Verification

1. **Canvas generator tests** (Node, `sharp`): both modes output exactly 1080×1920; blurred fill
   places a band whose dimensions match `fit: inside`; crop fills without letterboxing; a
   ±2%-of-9:16 source produces **no** canvas at all.
2. **Migration test**: both columns exist, `story_mode` defaults to `blurred`, the CHECK rejects
   anything else, existing rows are untouched.
3. **Dialog tests**: both columns and all four options render; the cost text reflects real
   dimensions; and — the actual bug — **the controls are still present after a choice is made**.
4. **Browser**: open the dialog, switch modes, close and reopen, confirm the choice persisted
   and is still changeable.
5. **One real Story from a landscape photo**, then look at it on a phone. Whether blurred fill
   actually looks good is not a thing tests can answer.

---

## 7. Out of scope

- **Manual crop framing** (dragging to choose the region). `attention` picks the crop; letting
  the owner nudge it is a substantially bigger interaction. Worth building only if the automatic
  choice proves wrong often — decide after real use, not before.
- **Solid/coloured bars for Stories** — see §1.
- **Video story canvases.** Reframing video needs a transcode, not a `sharp` composite. Video
  stories currently send the original, which is unchanged by this work.
- **An `asset_derivatives` table** — see §2.
- **Retroactively reframing already-published media.** Not possible via the API, and not
  desirable.

---

## 8. What good looks like

- Clicking the framing badge on a landscape photo shows, side by side and large enough to
  judge, what it will look like in the feed and as a Story.
- Choosing "crop to fill", looking at it, and going back to "blurred fill" takes two clicks and
  loses nothing.
- A photo shot vertically for Stories is untouched — no canvas, no processing, no decision to
  make.
- A landscape photo storied for real arrives on Instagram as a deliberate 9:16 frame rather
  than whatever Instagram decided to do with it.
