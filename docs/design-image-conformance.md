# Design — Image conformance (make uploads publish-safe)

**Status:** approved 2026-07-23, ready for implementation planning
**Depends on:** the existing upload pipeline (`/api/assets/upload`, `sharp`), the local asset
store, and the publish-delivery tunnel (all shipped).
**Feeds:** reliable publishing — every image the worker sends to Meta already meets Instagram's
feed-image requirements, so a publish never fails (or gets silently degraded) because of the
source file.

---

## 1. Purpose

Today the dashboard stores each uploaded image **exactly as-is** and the worker serves that
original to Meta at publish time ([upload/route.ts](../dashboard/app/api/assets/upload/route.ts),
[publisher.py `_resolve_url`](../worker/publisher.py)). Meta downloads the raw bytes and enforces
its own feed-image rules. A non-conforming file (too big, too wide, wrong color space, or an
aspect ratio outside the allowed band) is **rejected or hard-cropped by Meta** — a failure that
surfaces late, at publish, on an automated post nobody is watching. This was flagged during the
first live post (`tasks.md`, Phase 5.5).

Image conformance closes that gap: **conform on upload**, so the stored, publish-ready derivative
always satisfies the spec, and the framing decision is made **once** and **remembered** — which
also lets evergreen auto-fill reuse an image with no re-prompting.

Guiding principle (project rules): simple, local, transparent. No new external dependency (`sharp`
is already installed). Never silently change a user's framing without surfacing it.

---

## 2. Target spec — Instagram feed image

Working values (⚠ **verify against live Meta docs at implementation** — these drift; see
`reference.md` open-items pattern):

| Property | Rule | Fix if violated |
|---|---|---|
| Format | JPEG | re-encode to JPEG |
| Color | sRGB | convert to sRGB |
| File size | ≤ 8 MB | re-encode (lower quality until under) |
| Width | ≤ 1440 px (and ≥ 320 px) | downscale to 1440; too-small → flag as low-res |
| Aspect ratio | between **4:5** (0.8, portrait) and **1.91:1** (landscape); 1:1 fine | **framing decision** — crop or pad |

**Scope:** IG **feed images only** (single + carousel children). Reels/Stories (9:16) and video
specs are Phase 6. Facebook Pages (looser specs) is Phase 6. Carousel same-aspect harmonization is
noted but **not** enforced here (§8).

The two kinds of transform, and why they're treated differently:
- **Safe fixes** (format, color, size, downscale-to-1440): do **not** change what's in the frame.
  Applied **automatically and silently** to every image.
- **Framing fix** (aspect ratio out of range): **does** change the picture (crop loses content,
  pad adds bars). Never silent — auto-decided with a safe default, then **flagged for review**.

---

## 3. The mechanism — conform once, remember the decision

On upload (single upload, bulk import — same `/api/assets/upload` path):

1. Measure the original (dimensions, ratio, size, format/color via `sharp`).
2. Produce a **conformed publish derivative** (a JPEG in the same local store):
   - apply all safe fixes;
   - if the ratio is out of range, apply the current **framing mode** (default **crop**);
   - if in range, `conform_mode = none` (safe fixes only).
3. Record on the asset: `publish_path`, `conform_mode`, and `needs_review`.
   - Out-of-range → `conform_mode = crop`, `needs_review = 1` (auto-cropped, publishable now,
     but the user should confirm or switch to pad).
   - In range → `conform_mode = none`, `needs_review = 0`.
4. The **original file is kept untouched** (`storage_path`), so the framing mode can be changed
   later (crop ⇄ pad) and re-derived losslessly at any time.

The decision lives on the **asset**, not the post. Every post that reuses the image — manual or
**evergreen auto-fill** — inherits the same conformed `publish_path`. Automation therefore always
has a valid, pre-decided image and never blocks on a framing question.

**Bulk import note:** many images upload at once, so conformance must be **non-interactive** —
auto-crop default + flag. The user reviews flagged images afterward from the Library / editor, not
in a modal mid-upload.

---

## 4. Data model — migration `0006_image_conformance.sql` (additive)

Add to `assets`:

| Column | Type | Meaning |
|---|---|---|
| `publish_path` | TEXT | Relative path (in the asset store) of the conformed JPEG the worker serves to Meta. NULL → fall back to `storage_path` (pre-existing rows; back-compat). |
| `conform_mode` | TEXT | `'none'` \| `'crop'` \| `'pad'`. Default `'none'`. How framing was resolved. |
| `needs_review` | INTEGER | `0`/`1`. `1` = framing was auto-decided and awaits the user's confirm/override. Drives the UI flag badge. Default `0`. |

Backfill: existing rows keep `publish_path = NULL`, `conform_mode = 'none'`, `needs_review = 0`
→ worker falls back to the original, exactly as today. No behavior change for old assets until
they're re-conformed (optional, out of scope for this migration).

Note: `publish_path` is not content-hashed (it's a 1:1 derivative of the asset, regenerated when
`conform_mode` changes). Dedup stays keyed on the **original** `content_hash`, unchanged.

---

## 5. Conformance engine — `dashboard/lib/conform.ts`

Pure, unit-testable module wrapping `sharp`. No DB, no HTTP.

```ts
export const IG_MAX_BYTES = 8 * 1024 * 1024;
export const IG_MAX_WIDTH = 1440;
export const IG_MIN_WIDTH = 320;
export const IG_MIN_RATIO = 4 / 5;    // 0.8  portrait bound
export const IG_MAX_RATIO = 1.91;     // landscape bound

export type ConformMode = "none" | "crop" | "pad";

export interface ConformResult {
  buffer: Buffer;          // conformed JPEG bytes to write to publish_path
  mode: ConformMode;       // 'none' if in range, else the framing mode applied
  needsReview: boolean;    // true when framing was auto-decided (out of range)
  width: number;
  height: number;
  lowRes: boolean;         // original narrower than IG_MIN_WIDTH after conforming
}

// mode: the desired framing when out of range. Upload passes 'crop' (default);
// a later re-conform passes the user's choice ('crop' | 'pad').
export async function conformImage(input: Buffer, mode: ConformMode = "crop"): Promise<ConformResult>;
```

Behavior:
- Always: `.rotate()` (honor EXIF orientation) → convert to sRGB → cap width at 1440 →
  encode JPEG, stepping quality down until ≤ 8 MB.
- In-range ratio → `mode: 'none'`, `needsReview: false`.
- Out-of-range ratio:
  - **crop**: center-crop to the nearest in-range ratio (portrait target 4:5, landscape 1.91:1).
  - **pad**: letterbox to the nearest in-range ratio with a solid background (white; a later
    refinement could offer blurred-fill).
  - `needsReview: true` (auto-decided framing the user hasn't confirmed).
- `lowRes: true` if the source is narrower than 320 px — publishable, but surfaced as a soft
  warning (Meta may reject very small images).

---

## 6. Worker change — serve the conformed file

[`publisher.py _resolve_url`](../worker/publisher.py) prefers `publish_path`:

Precedence becomes: external `public_url` (paste escape hatch) → `publish_path` → `storage_path`.
One added branch; the tunnel/asset-server serve any relative path under `data/assets`, so
`publish_path` needs **no** server change. `_pub_needs_tunnel` (checks `public_url`) is unaffected.

Migration `0006` runs on the worker's DB via the normal `migrate.py`/launcher path.

---

## 7. Dashboard UX

- **Upload response** (`/api/assets/upload`) returns the new conform fields so the uploader can
  react immediately.
- **Flag badge:** anywhere an asset thumbnail is shown with editing affordances (composer,
  `/import` grid, post editor), a `needs_review` image shows a small **"Auto-cropped — review
  framing"** badge with a **Crop ⇄ Pad** toggle and a live preview of each.
- **Set-mode route:** `POST /api/assets/[id]/conform` `{ mode: 'crop' | 'pad' }` → re-runs
  `conformImage(original, mode)`, rewrites `publish_path`, sets `conform_mode`, clears
  `needs_review` (the user has now decided). Idempotent.
- **Low-res** images show a non-blocking "low resolution" note.
- In-range images show nothing — the common case stays invisible.

Copy is plain and honest: the badge states what already happened (auto-crop) and offers the
alternative, rather than blocking.

---

## 8. Out of scope / deferred (clean seams)

- **Reels / Stories / video** conformance (9:16, duration, codecs) — Phase 6.
- **Facebook Pages** image specs (looser) — Phase 6; the engine can grow a `platform` arg.
- **Carousel aspect harmonization** — IG applies the first child's ratio to the set; we don't yet
  force all children to match. Noted; revisit if it bites.
- **Blurred-fill pad** and **manual crop framing** (drag the crop box) — future polish; v1 pad is
  a solid background and crop is center.
- **Re-conforming existing/legacy assets** in bulk — not needed; old rows fall back to the
  original and can be re-conformed on demand later.

---

## 9. What good looks like

- Upload any oversized / wide / non-sRGB / oddly-proportioned image → the stored publish
  derivative meets the IG feed spec; the original is preserved.
- An out-of-range image is immediately publishable (auto-crop) **and** visibly flagged; switching
  to pad re-derives the file; the choice sticks and is reused by every post including evergreen
  auto-fill.
- The worker sends the conformed file; a previously-failing image now publishes cleanly.
- Existing assets behave exactly as before (fall back to original).
