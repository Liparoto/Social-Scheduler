# Discord + Telegram Adapters — Design

**Date:** 2026-07-25
**Phase:** 6 — sub-project 4 (after Facebook Pages, platform foundation, Threads).
**Goal:** Publish **text**, **single image** and **album** posts to a **Discord channel** (via
webhook) and a **Telegram channel** (via bot), as first-class platforms alongside Instagram,
Facebook and Threads.

## Why this one is different

Every platform so far has been a Meta Graph API: one `GraphClient`, a versioned base URL, an
`access_token` query parameter, and media delivered by giving Meta a **public URL to fetch**.
Neither of these is any of that. This is the first real test of whether the per-platform
registries generalise beyond Meta — and mostly they do, with three seams that need widening.

| | Discord | Telegram |
|---|---|---|
| Endpoint | `POST` to the webhook URL itself | `https://api.telegram.org/bot{token}/{method}` |
| Credential | **the webhook URL is the whole secret** | bot token **+** `chat_id` |
| Text | `content`, ≤2000 chars | `sendMessage`, ≤4096 chars |
| Image | multipart `files[0]` + `payload_json` | `sendPhoto`, ≤**1024**-char caption |
| Album | up to 10 attachments in one message | `sendMediaGroup`, 2–10 items |
| Metrics | none | none via the Bot API |
| Publish quota | none to read | none to read |

## Decisions

### Decision 1 — Upload bytes directly; these platforms never need the tunnel

Meta fetches images from a public URL, which is why publishing opens a short-lived cloudflared
tunnel. **Discord and Telegram accept the file in the request**, so we send the bytes and skip
that entirely — no tunnel, no public URL, no dependency on `cloudflared` being installed.

This is not just a simplification, it removes the most fragile part of publishing for these two.
It does mean `run_once`'s `_pub_needs_tunnel` must become **platform-aware**: today it asks only
"does this asset lack a public URL?", so a Discord image post would spin up a tunnel for nothing.
A new capability — `uploads_media_bytes` — says a platform sends bytes itself, and such
publications never count toward needing a tunnel.

The publisher gains a local-path resolver mirroring `_resolve_url`'s precedence
(`publish_path` if present, else `storage_path`, under `ASSET_STORAGE_DIR`).

### Decision 2 — Per-platform client factories (the eighth registry)

`ClientRegistry` hardcodes `GraphClient(version, base_url)`. The publisher, preflight and metrics
already call clients purely by method name, so the seam is duck-typed and only the *construction*
is Meta-specific. Add `clients._CLIENT_FACTORIES`, keyed by platform and asserted against
`SUPPORTED_PLATFORMS`, so each platform supplies its own class:

- `DiscordClient` — the webhook URL arrives per call (it's the credential), so its base URL is
  nominal; it exists only to keep the registry uniform and the client cache keyed sensibly.
- `TelegramClient` — base `https://api.telegram.org`, method path built as `/bot{token}/{method}`.

Both are small, `requests`-based, and mirror `GraphClient`'s conventions: raise on a non-OK
response, never interpolate a token into an error, no retry logic of their own (the publisher owns
retries).

### Decision 3 — Caption limits become post-type-aware

`PlatformCaps.max_caption_chars` is a single number today. Telegram's limit **changes with the
post**: 4096 for text, 1024 once a photo is attached. A single conservative 1024 would wrongly
reject a perfectly valid long text post — the exact "UI/worker rejects something that would have
worked" failure this project keeps fixing.

`max_caption_chars` becomes a small mapping from post type to limit, read through a
`caption_limit(post_type)` accessor. Existing platforms keep their current behaviour (Instagram
and Facebook: no limit; Threads: 500 for every type). The dashboard mirrors it the same way it
already mirrors the other capabilities, with the worker remaining authoritative.

### Decision 4 — "No metrics" is declared, not accidental

`_FETCHERS` must contain an entry for every supported platform. Discord and Telegram genuinely
have none, so their entry is an explicit `None`, meaning *"this platform has no metrics"* — as
opposed to a missing key, which means *"someone forgot"*. `run_metrics` skips a `None` quietly
(these aren't errors and shouldn't log a warning every cycle), and
`publications_needing_metrics` excludes those platforms so they don't get reselected forever.

Consequence, stated plainly: Discord and Telegram posts will show no metrics in the queue and will
rank as 0 in auto-fill's performance tier — the same known limitation Facebook and Threads already
have, and the same one the planned best-performing-post work addresses.

### Decision 5 — Credential shape per platform

The `channels` table gives each channel `remote_account_id` + `access_token`. Mapping:

- **Telegram** — `access_token` = the bot token; `remote_account_id` = the `chat_id`
  (`@channelname` or a numeric id). Fits the existing shape exactly.
- **Discord** — the webhook URL is *both* the address and the secret. It goes in `access_token`
  (secret-handling: gitignored DB, never logged), and `remote_account_id` is **not used**. A new
  `uses_account_id: bool` capability lets the channel form hide that field and label the token
  field "Webhook URL" instead of "Access token", so the form asks for exactly one thing.

**Preflight** (read-only, publishes nothing) for each:
- Discord — `GET` the webhook URL, which returns the webhook object; report its `name` and
  channel. Proves the URL is valid and live.
- Telegram — `getMe` to prove the bot token, then `getChat(chat_id)` to prove the bot can actually
  see the target channel. The second is the one that catches "bot isn't an admin of the channel",
  which is the mistake people actually make.

Neither reports a publish quota, so both are `_QUOTA_GATED: False` with a comment saying the
platform genuinely exposes no quota endpoint — never "we didn't get round to it".

## Global constraints (from CLAUDE.md)

- LOCAL-ONLY, no paid services. Both APIs are free with no approval process.
- **No migration should be needed** — but `channels.platform`'s CHECK currently allows only
  `instagram, facebook, threads`. Adding two values requires the same guarded table rebuild
  `0008` performed (`PRAGMA foreign_keys=OFF` outside an explicit transaction; a regression test
  proving child rows survive). Reuse that migration verbatim as the template.
- Never log tokens, PII, or full API responses. **The Discord webhook URL is a credential** and
  must be treated exactly like a token — never printed, never in an error message.
- Failures visible and per-publication; one failing never affects another.
- No new dependencies (`requests` covers multipart).
- Python worker in the repo `.venv`; tests alongside `worker/tests/`.

## Change surface

**Schema** — one migration widening `channels.platform` to add `discord` and `telegram`, using
`0008`'s proven procedure plus its regression test.

**Worker**
- `clients.py` — `discord`/`telegram` in `SUPPORTED_PLATFORMS`, `_BASE_URLS`, `_API_VERSIONS`,
  `PLATFORM_CAPS` (now with post-type-aware caption limits, `uploads_media_bytes`,
  `uses_account_id`), plus the new `_CLIENT_FACTORIES`.
- `discord_api.py`, `telegram_api.py` (new) — the two clients.
- `publisher.py` — `_publish_discord`, `_publish_telegram`; a local-path resolver for byte
  uploads; `caption_limit(post_type)` in validation.
- `run.py` — `_pub_needs_tunnel` skips platforms that upload bytes.
- `preflight.py` — `_check_discord`, `_check_telegram`.
- `metrics.py` — explicit `None` entries and the skip.

**Dashboard** — two `platforms.ts` entries with the new capability fields; the channel form
honouring `usesAccountId` and the webhook-URL labelling; queue rows showing no metrics strip for
these platforms (rather than an empty one).

**Docs** — a setup guide for each (creating a Discord webhook; creating a Telegram bot via
@BotFather and adding it to a channel as an admin), and `reference.md` entries.

## Out of scope

Discord embeds/rich formatting · Telegram parse modes (Markdown/HTML), buttons, or paid
broadcasts · video for either · reading engagement back from either platform · X, Pinterest ·
the auto-fill ranking gap (BPP work).

## Verification

- Full worker suite green, plus new tests for both adapters and the migration.
- A text, image and album post for each platform, dry-run end-to-end.
- Proof that an image post on these platforms opens **no tunnel**.
- A real post to each is **owner-gated** — Discord needs a webhook URL from a server you admin;
  Telegram needs a bot token and the bot added to a channel as an admin.
