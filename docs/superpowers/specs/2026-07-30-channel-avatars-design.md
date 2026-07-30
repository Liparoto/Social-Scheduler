# Channel profile photos (avatars)

**Date:** 2026-07-30
**Status:** Approved, not yet implemented

## Problem

Every channel in the dashboard is identified by an accent colour derived from `color_hue`
(or from the channel id when that is NULL). That distinguishes channels from each other,
but it carries no information about *which account* a channel actually is — you cannot
glance at a composer target and confirm you are about to post to the business account
rather than the personal one.

The platforms already publish the answer: each account has a profile photo. Pulling it in
makes every channel chip self-evidently on-brand for its account.

## Scope

- Fetch each channel's profile photo from the platform it belongs to.
- Show it on the Channels page (40px) and in place of the coloured dot in every channel
  chip across the dashboard (14px).
- Channels with no photo — unsupported platforms, missing credentials, failed fetches —
  show a circle in the channel's accent colour containing the first letter of the account
  name, at the same size as a real avatar.

Out of scope: Discord and Telegram avatars (see "Platform coverage"), letting the owner
upload a custom photo, and any change to how `color_hue` itself is chosen.

## Platform coverage

| Platform | Source field | Supported in v1 |
|---|---|---|
| Instagram | `GET /{ig-user-id}?fields=profile_picture_url` | Yes |
| Facebook Page | `GET /{page-id}?fields=id,name,picture{url}` | Yes |
| Threads | `GET /{threads-user-id}?fields=threads_profile_picture_url` | Yes |
| Discord | no per-target avatar exists for a webhook/channel target | No |
| Telegram | `getChat` → `getFile` → download, a different two-step flow | No |

Discord and Telegram channels keep `avatar_path` NULL and render the initial circle. This
is the expected state for them, not a failure: no `avatar_error` is recorded and nothing
is retried on a cadence for those platforms.

The Facebook fetch extends the fields on the existing `get_page_info`, which preflight
already calls — no new Page request is introduced.

## Storage

**Store the downloaded bytes, not the URL.** Meta's `profile_picture_url` and the Page
`picture{url}` are short-lived signed CDN links. Storing the URL would mean every avatar
silently becomes a broken image once the signature expires, and every dashboard page load
would issue a request to Meta from the owner's Mac.

Bytes are written to `data/assets/avatars/<channel_id>.jpg`, under the existing
`config.assetStorageDir`. That directory is already gitignored and per-install, so this
introduces no new storage concept.

**Avatars are deliberately not added to the export/backup bundle.** The export walks rows
in the `assets` table (`worker/export/collect.py`), and an avatar is not an asset row — it
is not post content, it is a cache of something the platform will hand back on request.
Adding avatars to the bundle would mean inventing a second, parallel notion of "file worth
exporting" to back up data that is free to re-fetch.

The consequence has to be handled explicitly, though: after a restore, the DB's
`avatar_fetched_at` comes back looking recent while the file on disk is gone, so the
cadence alone would leave the avatar broken for up to 7 days. The selection rule below
therefore treats a missing file as needing a refresh.

### Migration `0012_channel_avatar.sql`

Purely additive — four nullable columns, no table rebuild, following `0010_channel_colour.sql`
rather than the `0008`/`0009` rebuild pattern (no CHECK constraint is involved, so
`ALTER TABLE ... ADD COLUMN` is sufficient and carries no cascade-delete risk).

| Column | Type | Meaning |
|---|---|---|
| `avatar_path` | TEXT | Path relative to the asset store, e.g. `avatars/3.jpg`. NULL = no photo. |
| `avatar_fetched_at` | TEXT | ISO timestamp of the last *successful* fetch. Drives the cadence. |
| `avatar_refresh_requested` | INTEGER NOT NULL DEFAULT 0 | Set to 1 by the dashboard's "Refresh photo" button. |
| `avatar_error` | TEXT | Redacted message from the last failed fetch. NULL when the last fetch succeeded. |

Every existing row defaults to "no photo yet", which the cadence picks up on the worker's
next cycle.

## Worker: `worker/avatars.py`

A new module exposing `run_avatars(conn, config, client, now, *, logger, client_for)`,
called from `run_once` immediately after `run_metrics` and following the same
throttled-per-row shape.

**Selection.** A channel is refreshed when it is active, its platform is supported, it has
a `remote_account_id` and an `access_token`, and either:

- `avatar_refresh_requested = 1`, or
- `avatar_fetched_at` is NULL or older than 7 days, or
- `avatar_path` is set but the file is missing on disk (the restored-backup case above,
  and equally a file deleted by hand).

**Fetch and write.**

1. Ask the platform client for the current photo URL.
2. Download to a temp file in the same directory as the target.
3. Reject the response unless the bytes actually decode as an image — a Graph error page
   or an HTML redirect must never be written as `avatars/3.jpg`.
4. Compare the content hash against the existing file; if unchanged, skip the write and
   only update `avatar_fetched_at`. (Consistent with the project's "dedup by content hash,
   never by filename" rule.)
5. Otherwise atomically rename the temp file into place.
6. Clear `avatar_refresh_requested` and `avatar_error`; set `avatar_fetched_at`.

**Failure handling.** Any failure records a redacted `avatar_error`, leaves the existing
photo in place, clears `avatar_refresh_requested` (so a click cannot wedge into a retry
loop), and does not raise. A failure on one channel must not affect any other channel, and
must never take the daemon down. The error is surfaced on the Channels page — a failed
fetch is visible, never silent.

**Dry run.** This is a read-only GET that publishes nothing, so it runs regardless of
`DRY_RUN` — the same way metrics fetching is gated on the publication being non-dry-run
rather than on the fetch itself being suppressed.

**Kill switch.** Respected exactly as elsewhere: when the kill switch is active, the
worker cycle stops and no avatar work is attempted.

## Dashboard

### Route: `app/api/channels/[id]/avatar/route.ts`

Serves the stored bytes for in-dashboard display only. Mirrors
`app/api/media/[id]/route.ts`, including resolving the path inside
`config.assetStorageDir` and rejecting any resolved path that escapes it. Returns 404 when
`avatar_path` is NULL or the file is missing on disk. Responds
`Cache-Control: private, max-age=3600`. No range support — images are never seeked.

### Route: `app/api/channels/[id]/avatar/refresh/route.ts`

POST sets `avatar_refresh_requested = 1` and returns. It performs no network work — the
dashboard never calls a platform API; the DB is the contract between the two processes.
The UI states that the worker picks the request up on its next cycle, matching how the
existing metrics refresh communicates the same dependency.

### `ChannelAvatar` component (`components/ui.tsx`)

Props: `id`, `name`, `colorHue`, `avatarPath`, `size`.

- When `avatarPath` is set: `<img src="/api/channels/{id}/avatar">`, circular, at `size`.
- Otherwise: a filled circle in `channelColor(id, colorHue).dot` containing the first
  character of `name`, uppercased.

Both branches render identical dimensions so chips never shift between the two states. The
element is decorative next to the channel name that always accompanies it, so it carries
`aria-hidden` and an empty `alt`.

### Call sites

`ChannelChip` swaps its 8px dot for `<ChannelAvatar size={14} />`. Seven other components
render their own dot from `channelColor()` rather than going through `ChannelChip`, and
each needs the same swap:

- `components/composer.tsx` (two call sites)
- `components/post-editor.tsx`
- `components/library-view.tsx`
- `components/schedule-from-library.tsx`
- `components/bulk-import.tsx`
- `components/post-sends-panel.tsx`
- `app/page.tsx`

The chip background stays the `color_hue`-derived tint in every case; only the dot is
replaced. `avatar_path` is added to the channel `SELECT` in `lib/queries.ts` and to the
`Channel` type in `lib/types.ts`, which is all the plumbing these call sites need.

### Channels page

Each account gains a 40px avatar, a "Refresh photo" button, and — when `avatar_error` is
non-NULL — the error text. Discord and Telegram channels show the initial circle with no
refresh button, since no fetch is possible for them.

## Testing

**Python (`worker/tests/test_avatars.py`)**

- Cadence: a channel fetched an hour ago is skipped; one fetched 8 days ago is selected;
  one with `avatar_refresh_requested = 1` is selected regardless of age.
- Unsupported platforms (Discord, Telegram) are never selected and never record an error.
- Per-platform URL extraction from a fake client response, for Instagram, Facebook and
  Threads.
- A non-image response is rejected and no file is written.
- A fetch failure records `avatar_error`, leaves the previous file intact, clears
  `avatar_refresh_requested`, and does not raise.
- An unchanged photo (same content hash) updates `avatar_fetched_at` without rewriting.
- A channel whose `avatar_path` is set but whose file is missing is selected even when
  `avatar_fetched_at` is recent (the restored-backup case).

**TypeScript**

- The avatar route rejects a path that escapes the asset store, mirroring the existing
  media-route containment test.
- `ChannelAvatar` renders the initial circle when `avatarPath` is NULL.

**Manual verification**

Run the worker against the live install and confirm both of the owner's accounts show
their real photos on the Channels page and in the composer chips, and that "Refresh photo"
picks up a photo changed on Instagram.

## Build order

Three reviewable phases, each verifiable before the next begins:

1. **Migration + worker + serving route.** Photos land on disk and are fetchable at
   `/api/channels/{id}/avatar`. Verified by the Python tests and by hitting the route.
2. **Channels page.** Avatar, refresh button, and error display.
3. **Chip swap.** `ChannelChip` plus the seven call sites above.
