# Editable channel timezone with a US-first picker

**Date:** 2026-07-30
**Status:** approved, ready to build

## Problem

A channel's `timezone` can be set when the channel is created — as a raw IANA
free-text box — and then **never changed again**. The Channels page renders it as
plain text; there is no edit affordance anywhere. The `PATCH /api/channels/[id]`
handler already accepts a `timezone` field, so the gap is purely UI.

Two smaller problems ride along:

1. **A typo is a crash, not a validation error.** `PATCH` accepts any string. Saving
   `"Amrica/New_York"` succeeds, and the next render of the Channels or Queue page
   calls `formatInTz` → `new Intl.DateTimeFormat({ timeZone })` → uncaught
   `RangeError`. `tzAbbrev` happens to catch; `formatInTz` does not.
2. **`splitInTz` is copy-pasted** into `components/publication-actions.tsx` and
   `components/post-sends-panel.tsx`. The rebase below needs the same logic.

## Decisions

| Question | Decision |
|---|---|
| Which zones in the dropdown | All four continental US: Eastern, Central, Mountain, Pacific |
| Install-wide `DEFAULT_TIMEZONE` editable in the UI? | **No** — stays in `.env`, consistent with `DRY_RUN` / `KILL_SWITCH` |
| Pending sends when the zone changes | **Keep the same wall clock** — a 9:00 AM send stays 9:00 AM in the new zone; its UTC instant is rewritten |
| Composer's timezone field | Also swapped to the shared picker |

## Design

### `lib/timezones.ts` (new)

```ts
export const US_TIMEZONES = [
  { value: "America/New_York",    label: "Eastern"  },
  { value: "America/Chicago",     label: "Central"  },
  { value: "America/Denver",      label: "Mountain" },
  { value: "America/Los_Angeles", label: "Pacific"  },
];
export function isValidTimezone(tz: string): boolean;
```

`isValidTimezone` round-trips the name through `Intl.DateTimeFormat`, which throws
`RangeError` on an unknown IANA zone. No new dependency. Importable from both
client components and server routes (no `server-only`).

### `lib/time.ts` (extended)

- `splitInTz(iso, tz) → { date, time }` — lifted from the two components verbatim.
- `rebaseWallClock(iso, fromTz, toTz) → iso` — **pure**, the whole rebase math:
  read the wall clock in `fromTz`, reinterpret those same digits in `toTz`, return
  the new UTC instant. Pure so `npm test` can cover it directly.

### `<TimezonePicker>` (new client component)

A `<select>` of the four US zones plus `Custom…`. Custom reveals a text input.
A value not in the list (e.g. today's `UTC`) opens in Custom mode, pre-filled.

Below the control, a live sanity line — `EDT · 3:42 PM` — so the choice is
verifiable without knowing IANA names. Invalid custom text replaces it with an
inline error and reports invalidity to the parent so Save can be disabled.

Call sites: `channel-form.tsx` (new channel), `channel-timezone.tsx` (below),
`composer.tsx` (per-post entry zone).

### `<ChannelTimezone>` (new client component)

On each channel card, following the existing `<ChannelColor>` /
`<ChannelCredentials>` collapsed-until-clicked pattern.

Flow: pick a zone → the component calls the preview endpoint → it renders exactly
which pending sends move and to when → **Save & move N sends**. With no pending
sends it is a plain Save.

### `POST /api/channels/[id]/timezone` (new route)

Deliberately **not** the generic `PATCH`, which the Active / Approval toggles use
and which must not grow a side effect that rewrites queued rows.

- `{ timezone, confirm: false }` → `{ ok, from, to, sends: [{ id, post_id, before, after }] }`
- `{ timezone, confirm: true }` → applies the timezone write **and** the rebase
  inside one `db.transaction()`, so a crash can never leave the channel on the new
  zone with sends still on the old wall clock.

Both forms 400 on an invalid IANA name. `POST /api/channels` gains the same
validation.

`timezone` is **removed** from the generic `PATCH` handler, leaving exactly one
code path that can change it — one that cannot forget the rebase. Nothing in the
app sends `timezone` to that handler today.

### The rebase

Every publication on the channel with `status IN ('scheduled','pending_approval')`,
**including held ones** (`is_held = 1` is a pause, not a cancellation — those are
still pending).

Never touched: `posted`, `failed`, `canceled` (history stays honest) and
`publishing` (the worker has it in flight; do not move it underneath).

### No migration

`channels.timezone` already exists and already holds exactly this value.

## Verification

- `npm test` — unit tests for `rebaseWallClock`, including:
  - a plain offset change (UTC → America/Chicago),
  - a **DST boundary**, where one wall clock maps to different UTC offsets on
    either side of the transition,
  - a no-op (same zone in and out).
- Playwright against the running dashboard on a channel with real pending sends:
  queue times before → change zone → queue times after.
  **Playwright, not the in-app browser** — the in-app browser auto-accepts
  `confirm()` dialogs and has previously destroyed real data.

## Out of scope

- Editing `DEFAULT_TIMEZONE` from the UI.
- A full IANA zone list / searchable combobox. Custom text covers the long tail.
- Any change to how the Python worker reads `scheduled_at` (it reads UTC; nothing
  about that changes).
