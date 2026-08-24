# Media-vs-destination validation — design spec

**Date:** 2026-08-24
**Status:** approved, pending implementation plan
**Scope:** every platform and surface this repo supports. Media limits only — caption
length, asset counts and text-only rules already live in `PlatformCaps` and are unchanged.

---

## Why

The owner hit this while testing Facebook video: *"letting incorrect media go to places that
can't publish it."* The Facebook Reels gating shipped on `feat/facebook-video` is the ONLY
per-surface media check in the app. Everything else is absent, or enforced in the wrong place.

Three concrete failures today:

**1. Instagram Stories have no duration check at all.** Meta's Story video format is roughly
60 seconds. Nothing in the dashboard or the worker checks it. A 10-minute clip targeted at an
IG Story schedules cleanly and fails at Meta with an error that says nothing about duration.

**2. The one duration gate that exists is hardcoded to Instagram.**
`dashboard/app/api/assets/upload/route.ts` runs `classifyReelErrors` against `video-spec.ts`'s
`REEL_SPEC` — Instagram's spec, 15-minute cap — against EVERY upload regardless of
destination. It is both too strict and too loose:

- *Too strict:* an 18-minute video is refused at upload, though a Facebook Page feed video
  accepts up to 20 minutes. The app now rejects media it is capable of publishing.
- *Too loose:* it guards only the upload path. Anything already in the library is never
  re-checked against the destination actually chosen.

**3. Media limits live in three places, in two languages, none shared.**
`video-spec.ts` (Instagram, upload-time), `facebook-reel-spec.ts` (Facebook Reels,
composer-time), and an inline block in `publisher.py` (Facebook Reels again, worker-time).

## Principle

**Only refuse what we can verify. Everything else stays permissive, with a good failure
message.**

This is the rule the project already applies to Meta's publishing rate limit — recorded in
`reference.md` as documented-but-not-enforced, because Pages expose no endpoint to read it and
a hardcoded number would be wrong. Media limits deserve the same treatment: a guessed limit
that refuses a valid upload is worse than no limit at all, because the platform itself is
always the backstop.

Research on 2026-08-24 confirmed this is not hypothetical. Limits come in three kinds:

- **Stable and documented** — Instagram Reels, Facebook feed video and Reels.
- **Varies by account** — Discord's upload cap depends on Nitro tier and server boost, and the
  default moved 25 MiB → 10 MiB in January 2025, reported as 20 MB by August 2026.
- **Varies by method** — Telegram allows 10 MB for a photo uploaded directly but 5 MB by URL;
  50 MB for other files directly, 20 MB by URL.

A single hardcoded number cannot express any of the last two honestly.

---

## The shared file

**`media-limits.json` at the repo root**, beside `/migrations`. Same reasoning the project
already applies to the schema: *"Neither language 'owns' it."* A platform's media limits are a
fact about the platform, not a property of the worker or the dashboard.

### Why a shared file rather than a hand-maintained mirror

`worker/clients.py`'s `PLATFORM_CAPS` and `dashboard/lib/platforms.ts` already mirror each
other by hand, with **no assert guarding them** — the TS file says so itself. That has held for
a handful of booleans. This adds roughly **100 numbers** (6 platforms × up to 3 surfaces × ~6
fields). A hand mirror does not survive that, and a drifted number is silent in the worst way:
the composer says a send is fine, the worker refuses it, and nobody learns why until a post
fails.

One file read by both makes the drift bug **structurally impossible** rather than merely
discouraged.

The cost is real and accepted: JSON carries no comments, so the rationale this codebase
normally writes inline moves into a `note` field on each entry.

### Shape

```json
{
  "schema_version": 1,
  "platforms": {
    "facebook": {
      "reel": {
        "video": {
          "min_duration_ms": 3000,
          "max_duration_ms": 90000,
          "min_width": 540,
          "min_height": 960,
          "min_aspect": [9, 16],
          "max_aspect": [16, 9],
          "note": "Meta Reels publishing docs, read 2026-08-23. Aspect range is INCLUSIVE at both ends — 16:9 landscape is permitted. Not yet confirmed by a live publish."
        }
      }
    }
  }
}
```

Keyed `platform → surface → media_kind`. Surfaces are the values migration `0027` allows:
`feed`, `story`, `reel`. Media kinds are `video` and `image`.

**Every numeric field is optional. Absent means not enforced.** That is how "we do not know"
is expressed — by omission, never by a guess.

Recognised fields, all optional:

| Field | Applies to | Meaning |
|---|---|---|
| `min_duration_ms` / `max_duration_ms` | video | inclusive bounds |
| `min_width` / `min_height` | both | inclusive minimums |
| `max_width` / `max_height` | both | inclusive maximums |
| `min_aspect` / `max_aspect` | both | `[w, h]` pairs, compared as exact fractions, inclusive |
| `max_bytes` | both | inclusive maximum |
| `formats` | both | allowed container/mime list |
| `note` | both | **required** — where the number came from, and when |
| `varies` | both | a string explaining why a limit cannot be pinned; makes violations WARN rather than REFUSE |

`min_aspect`/`max_aspect` are `[w, h]` pairs rather than decimals so the comparison can be
done as exact fractions. The Facebook work already learned this: a float comparison can
exclude the 16:9 boundary by rounding, and 16:9 is a value Meta explicitly permits.

### Inclusivity

**All bounds are inclusive**, everywhere, with no exceptions. The Facebook implementation
already works this way (3000 ms and 90000 ms both pass; exactly 16:9 passes). A mixed
convention is the kind of detail that silently diverges between two languages.

---

## Two loaders, one file

**`worker/media_limits.py`** and **`dashboard/lib/media-limits.ts`**, exposing the same two
operations under matching names:

- `limits_for(platform, surface, media_kind)` → the entry, or `None` when nothing is recorded.
- `check(platform, surface, asset)` → a list of violations, each carrying a machine-readable
  `kind` (`too_long`, `too_short`, `too_small`, `wrong_aspect`, `too_large`, `wrong_format`),
  a human sentence, and a `severity` of `refuse` or `warn`.

A violation whose entry carries `varies` is always `warn`.

**A malformed or unreadable file fails LOUDLY at startup** — the worker refuses to start, the
dashboard fails to build. A broken config is a bug, not a platform fact, and must never
degrade into "allow everything". This is the one place the permissive principle does not
apply.

Both loaders read the file once and cache it. Neither writes it.

---

## Three checkpoints

Each answers a different question, and that is why all three exist.

### 1. Upload — *could anything publish this?*

`dashboard/app/api/assets/upload/route.ts` stops checking against Instagram's spec. It refuses
only media that **no platform and surface combination could accept** — the union of every
entry in the file.

This directly fixes failure (2): an 18-minute video uploads, because Facebook's feed can take
it. A 30-minute video still refuses, because nothing can.

`classifyReelErrors`'s split between `fatal` (too short/long — trimming is an editorial call
this app must never make) and `convertible` (too wide/large/wrong container — a re-encode
genuinely fixes these) is **kept**. Only the numbers move; that reasoning is still correct.

### 2. Composer — *can THIS destination take it?*

`facebookReelDisabledReason()` generalizes to `destinationDisabledReason(platform, surface,
asset)`, driven by the file rather than one hardcoded platform. The UI is unchanged: the chip
disables and states its reason inline, exactly as the Facebook Reel chip does now.

A `warn`-severity violation does NOT disable the chip. It shows the note beneath it, so a
Discord send whose size cannot be pinned is still possible, with the risk stated.

**Stale targets must be pruned, not merely hidden.** This bug has already occurred twice on
this codebase: a chip hides while its target survives in state, and the wrong media publishes.
`effectiveLibraryTargets()` and `computeSendTargets()` already establish the pattern; every
newly-gated surface follows it.

### 3. Worker — *last line of defence*

`publisher._validate`'s Facebook-Reels block becomes a generic check driven by the same file.
Terminal `_NonRetryable`, as now. This is what catches `post_targets` rows the UI cannot reach
— rows scheduled before a limit was known, or written by another path.

`warn`-severity violations never fail a send here; they are logged.

---

## The conform pipeline

Today every uploaded video is transcoded toward Instagram's spec. Once an 18-minute video can
upload, conforming it is both **pointless** — it can never be an Instagram Reel — and
**expensive**, since it is a multi-minute transcode of a long file.

**Rule: build the conformed derivative only when some destination that needs conformed media
could actually accept this asset.**

An 18-minute clip fails every Reels-shaped surface, so no derivative is built. It reaches
Facebook's feed as the untouched original, which is already what `_resolve_rel` does for feed
video on a platform whose feed is unconstrained (`feed_video_is_constrained=False`).

This changes `upload/route.ts`'s decision about whether to transcode. It does NOT change
`_resolve_rel`, `_needs_conformed`, or any publish-time resolution — an asset with no
derivative already falls back to the original.

---

## What gets retired

- `dashboard/lib/facebook-reel-spec.ts` — its numbers move into the shared file; its helper
  becomes the generic `destinationDisabledReason`.
- `dashboard/lib/video-spec.ts`'s `REEL_SPEC` — the NUMBERS move into the shared file as
  Instagram's entry. `classifyReelErrors`, `validateReel`, `humanDuration` and `humanBytes`
  stay: they encode behaviour, not platform facts.

  ⚠️ There are **two** `humanBytes` in this codebase — `dashboard/lib/format.ts:85` and
  `dashboard/lib/video-spec.ts:153` — with different signatures (`number | null` vs `number`).
  That duplication predates this work and is NOT in scope to resolve, but an implementer
  reaching for "the" `humanBytes` will pick the wrong one about half the time. The media-limit
  messages should use `video-spec.ts`'s, matching what `facebook-reel-spec.ts` already does.
- The Facebook-Reels block in `worker/publisher.py`'s `_validate` — replaced by the generic
  check.

---

## Verification

**Every number in the file is read from live platform documentation during implementation, and
its `note` records the source and the date.** No number is carried over from memory, and no
number is carried over from this spec without re-reading its source — including the ones below.

Known at spec time, to be re-confirmed:

| Platform | Surface | What is believed | Confidence |
|---|---|---|---|
| Instagram | feed (video) | 3 s – 15 min, ≤300 MB, ≤1920 px wide | Verified 2026-07-28 in `video-spec.ts` |
| Instagram | story (video) | ~60 s | **Unverified — this is the owner's reported bug** |
| Instagram | feed (image) | JPEG only | Partially verified 2026-08-24 |
| Facebook | feed (video) | ≤20 min, ≤1 GB, any aspect | Read 2026-08-23 |
| Facebook | reel (video) | 3–90 s, 9:16–16:9, ≥540×960, 24–60 fps | Read 2026-08-23 |
| Threads | feed | images and text only in this worker | Video unimplemented — record nothing |
| Discord | feed | **varies** — Nitro tier and boost; 25 MiB → 10 MiB in Jan 2025, ~20 MB by Aug 2026 | `varies`, warn only |
| Telegram | feed | 10 MB photo / 50 MB other, uploaded directly; 5/20 MB by URL | Read 2026-08-24, re-confirm |
| TikTok | feed (video) | unresearched | **Must research** |

Where a limit cannot be confirmed, the field is omitted and nothing is enforced. Shipping "we
do not check Discord's size" honestly is better than shipping a guess that refuses valid
uploads.

---

## Testing

**The cross-language agreement test is the point of this design.** A shared matrix of assets ×
platforms × surfaces runs through BOTH `worker/media_limits.py` and
`dashboard/lib/media-limits.ts`, asserting identical verdicts. Today the composer and the
worker can disagree and nobody finds out until a send fails; here, disagreement is a failing
test.

Also required:

- **Schema validation** of `media-limits.json` in both languages: every entry has a `note`,
  every field is recognised, every aspect pair is `[w, h]` integers.
- **Boundary tests** at every inclusive edge, per platform. The Facebook work found a test
  that passed regardless of the implementation; boundaries are where that happens.
- **Malformed-file tests**: a broken file must fail loudly in both languages, never silently
  permit.
- **Stale-target pruning** for every newly-gated surface.
- **The upload union**: an 18-minute video uploads (Facebook feed can take it); a 30-minute
  video does not (nothing can).

---

## Build order

Four phases, each verified before the next:

1. **The file and the loaders** — format, both loaders, schema validation, the cross-language
   agreement test. No behaviour change yet; nothing consumes them.
2. **Instagram** — research and record its limits, wire the composer and the worker. This
   closes the owner's actual bug (Stories with no duration check).
3. **The remaining platforms** — Facebook (moving the existing numbers into the file), TikTok,
   Telegram, Discord, Threads.
4. **The upload gate and the conform rule** — switch from Instagram's spec to the union, and
   make conforming conditional. Deliberately last: it changes what can enter the library, so it
   should land only once the per-destination gating it relies on is proven.

## Out of scope

- Caption length, asset counts, text-only rules — already handled by `PlatformCaps`, unchanged.
- Facebook Stories — still unimplemented as a surface; it gets an entry when the adapter lands.
- Threads video — unimplemented in this worker.
- Trimming, cropping or otherwise altering media to fit a limit. This app refuses or warns; it
  never makes an editorial decision about someone's content. That rule already exists in
  `upload/route.ts` and survives unchanged.
