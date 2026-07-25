# Discord + Telegram Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish text, single-image and album posts to a Discord channel (webhook) and a Telegram channel (bot), as first-class platforms.

**Architecture:** These are the first non-Meta platforms. Three seams widen — a **client-factory** registry (so `ClientRegistry` stops hardcoding `GraphClient`), **post-type-aware caption limits** (Telegram: 4096 text / 1024 with a photo), and a **`uploads_media_bytes`** capability (these send the file in the request, so they need no public URL and no cloudflared tunnel). Then both platforms register in every registry at once.

**Tech Stack:** Python 3.11 in the repo `.venv`, `requests` (multipart included), pytest; Next.js + TypeScript.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-discord-telegram-design.md`. Read it before Task 1.
- **The registry asserts run at import.** Adding a platform to `SUPPORTED_PLATFORMS` without every registry breaks `import worker.run`. Task 4 registers both platforms everywhere in **one commit** — do not split it.
- **The Discord webhook URL is a credential.** Treat it exactly like a token: never print, log, or interpolate into an error message.
- Never log tokens, PII, or full API responses. No new dependencies.
- Failures visible and per-publication; one failing must never crash the worker or affect another.
- Worker tests: `.venv/bin/python -m pytest worker/tests -q` — **239 passing today, ~110s; let it finish.**
- Dashboard: `cd dashboard && npx tsc --noEmit`.
- **Never modify `data/socialscheduler.db`** (the owner's real data: Instagram + Threads channels, both live). Use `/tmp` copies.
- Commit after each task.

---

### Task 1: Migration 0009 — allow `discord` and `telegram`

**Files:** Create `migrations/0009_discord_telegram.sql`, `worker/tests/test_migration_0009.py`

`channels.platform`'s CHECK currently allows only `instagram, facebook, threads`. SQLite can't ALTER a CHECK, so the table is rebuilt — and `DROP TABLE` with foreign keys on **fires `ON DELETE CASCADE`**, which would silently delete every dependent row.

**Use `migrations/0008_platform_foundation.sql` as your template — read it first.** It solved exactly this problem: `PRAGMA foreign_keys = OFF` *outside* an explicit `BEGIN`/`COMMIT` (the PRAGMA is a silent no-op inside a transaction, and the explicit transaction is what makes a mid-script failure roll back instead of leaving `channels` dropped). `worker/tests/test_migration_0008.py` is your test template — it seeds every cascading child table and proves the rows survive.

Only `channels` needs rebuilding this time; `posts.post_type` is unchanged. `channels` has 3 inbound cascading FKs (`publications`, `publish_limits`, `post_targets`) and no indexes, triggers or views.

- [ ] **Step 1: Write the failing tests** — adapt `test_migration_0008.py`: build a DB through `0008`, seed a channel plus rows in every table that cascades from it, apply `0009` the way `migrate.py` does, then assert row counts are unchanged, `PRAGMA foreign_key_check` is empty, foreign keys are back ON, `'discord'`/`'telegram'` now insert successfully, a bogus platform is still rejected, the column set is identical (compare **full** `PRAGMA table_info` rows, not just names), defaults still apply, and no `channels_new` remains. Include 0008's atomicity test: inject a failure after the `DROP` and assert `channels` still exists with its row.
- [ ] **Step 2: Run them; expect failure** because the migration doesn't exist.
- [ ] **Step 3: Write the migration**, reproducing `channels`' complete current definition verbatim (18 columns, from `sqlite_master`) with only the CHECK widened to `IN ('instagram','facebook','threads','discord','telegram')`.
- [ ] **Step 4: Run the tests; expect pass.** If child rows vanish, the PRAGMA isn't taking effect — do not "fix" it by deleting the assertion.
- [ ] **Step 5: Verify against a COPY of the real DB** — `cp data/socialscheduler.db /tmp/…`, apply, confirm all row counts identical and `foreign_key_check` empty, then delete the copy. **Never against the real file.**
- [ ] **Step 6:** apply for real via `.venv/bin/python migrate.py`, confirm re-running says "Nothing to do", run the full suite, commit.

---

### Task 2: Capability model — post-type captions, byte uploads, account-id opt-out

**Files:** Modify `worker/clients.py`, `worker/publisher.py`, `worker/run.py`; extend `worker/tests/test_platform_dispatch.py`, add cases to `worker/tests/test_text_posts.py`

**No new platforms in this task** — it only generalises the capability model, so every existing test must pass unmodified.

**Interfaces produced (Task 4 depends on these):**
- `PlatformCaps` gains `caption_chars: dict[str, int]` (replacing `max_caption_chars`), `uploads_media_bytes: bool = False`, `uses_account_id: bool = True`, and a method `caption_limit(post_type) -> int | None`.
- `publisher._resolve_local_path(asset, config) -> Path | None`.
- `_validate` gains a `config` parameter.

- [ ] **Step 1: Write the failing tests**

In `test_platform_dispatch.py`:
```python
def test_caption_limits_are_declared_per_post_type():
    from worker.clients import PLATFORM_CAPS

    # Threads' 500 applies to every type it supports; Meta declares no limit at all.
    assert PLATFORM_CAPS["threads"].caption_limit("text") == 500
    assert PLATFORM_CAPS["threads"].caption_limit("single") == 500
    assert PLATFORM_CAPS["instagram"].caption_limit("single") is None
    # An unknown post type must not invent a limit.
    assert PLATFORM_CAPS["threads"].caption_limit("reel") is None


def test_meta_platforms_do_not_upload_bytes_themselves():
    from worker.clients import PLATFORM_CAPS

    # Meta fetches media from a public URL, which is what the tunnel exists for.
    for platform in ("instagram", "facebook", "threads"):
        assert PLATFORM_CAPS[platform].uploads_media_bytes is False
        assert PLATFORM_CAPS[platform].uses_account_id is True
```

In `test_text_posts.py`, add a case proving the limit is looked up **by post type**: patch a platform's caps to `caption_chars={"text": 10, "single": 100}`, then confirm an 50-char text post is rejected while a 50-char single-image post is accepted. This is the whole point of the change — a single number would reject both.

Add a test that a publication on a `uploads_media_bytes` platform does **not** require a public URL (patch a platform's caps, give the asset no `public_url`, assert validation passes when the local file exists and fails with a clear error when it doesn't).

- [ ] **Step 2: Run; expect failure** (`caption_limit` doesn't exist).

- [ ] **Step 3: Widen `PlatformCaps`** in `worker/clients.py`:

```python
@dataclass(frozen=True)
class PlatformCaps:
    """What a platform can actually publish."""

    supports_text: bool
    max_carousel: int
    # Caption limits differ BY POST TYPE on some platforms — Telegram allows 4096 characters
    # for a text post but only 1024 once a photo is attached — so this is a mapping, not one
    # number. A post type absent from the mapping has no limit we enforce.
    caption_chars: dict[str, int]
    # True when the platform accepts the file bytes in the publish request. Meta fetches media
    # from a public URL (which is why publishing opens a tunnel); these platforms do not, so
    # they need neither a public URL nor cloudflared.
    uploads_media_bytes: bool = False
    # False when the credential alone identifies the destination, so there is no separate
    # account id to store or ask for (Discord's webhook URL is both address and secret).
    uses_account_id: bool = True

    def caption_limit(self, post_type: str) -> int | None:
        return self.caption_chars.get(post_type)
```

Update the three existing entries: Instagram and Facebook `caption_chars={}`; Threads
`caption_chars={"text": 500, "single": 500, "carousel": 500}`. Behaviour must be identical to today.

- [ ] **Step 4: Use it in the publisher.** In `worker/publisher.py`:

Replace the caption rule with a per-type lookup:
```python
    limit = caps.caption_limit(post_type)
    if limit is not None and caption is not None and len(caption) > limit:
        raise _NonRetryable(
            f"caption is {len(caption)} characters; {platform} allows {limit} "
            f"for a {post_type} post"
        )
```

Add the local-path resolver next to `_resolve_url`:
```python
def _resolve_local_path(asset, config) -> Path | None:
    """The on-disk file to upload, for platforms that send bytes rather than a URL.

    Same precedence as _resolve_url: the Meta-conformed derivative if one exists, else the
    original. Returns None when the file is missing, so validation can fail loudly instead of
    the publish blowing up mid-request.
    """
    rel = None
    if "publish_path" in asset.keys() and asset["publish_path"]:
        rel = asset["publish_path"]
    elif asset["storage_path"]:
        rel = asset["storage_path"]
    if not rel:
        return None
    path = Path(rel)
    if not path.is_absolute():
        path = config.asset_storage_dir / path
    return path if path.exists() else None
```
(add `from pathlib import Path` if absent)

Give `_validate` the config and branch the media check:
```python
def _validate(post, assets, dry_run: bool, asset_base_url: str | None, platform: str,
              caption: str | None = None, config=None) -> None:
```
and replace the public-URL check with:
```python
    if not dry_run:
        if caps.uploads_media_bytes:
            missing = [a["id"] for a in assets if _resolve_local_path(a, config) is None]
            if missing:
                raise _NonRetryable(f"asset files missing from the local store: {missing}")
        else:
            missing = [a["id"] for a in assets if not _resolve_url(a, asset_base_url)]
            if missing:
                raise _NonRetryable(
                    f"assets have no public URL (no tunnel and no stored public_url): {missing}"
                )
```
Update the single `_validate(...)` call site in `publish_one` to pass `config`.

In `_build_plan`, also carry local paths so the byte-upload publishers have them — add an
`asset_paths` key resolved with `_resolve_local_path` (a list, `None` entries allowed for
dry-run). `_build_plan` will need `config` too; thread it through from `publish_one`.

- [ ] **Step 5: Make the tunnel decision platform-aware** in `worker/run.py`:

```python
    def _pub_needs_tunnel(pub) -> bool:
        channel = db.get_channel(conn, pub["channel_id"])
        caps = PLATFORM_CAPS.get(channel["platform"]) if channel else None
        # Platforms that upload the file themselves never need a public URL — without this a
        # Discord image post would drag a cloudflared tunnel up for the whole batch.
        if caps is not None and caps.uploads_media_bytes:
            return False
        return any(
            not a["public_url"] for a in db.get_ordered_assets(conn, pub["post_id"])
        )
```
(import `PLATFORM_CAPS` from `.clients`)

- [ ] **Step 6:** Run the full suite — everything must pass **unmodified** except your additions. Commit.

---

### Task 3: The Discord and Telegram API clients

**Files:** Create `worker/discord_api.py`, `worker/telegram_api.py`, `worker/tests/test_discord_api.py`, `worker/tests/test_telegram_api.py`

No registry changes; nothing changes behaviour yet. **Read `worker/graph_api.py` and `worker/tests/test_graph_api_threads.py` first** and mirror their conventions: a `requests.Session`, raise a platform-specific error on a non-OK response, never interpolate the credential into a message, no internal retries.

**Interfaces produced (used by Task 4):**

`discord_api.py`
- `class DiscordAPIError(Exception)`
- `class DiscordClient:` `__init__(self, base_url: str = "https://discord.com/api/v10", session=None, timeout: int = 60)`
  - `send_message(self, webhook_url: str, *, content: str | None = None, files: list[tuple[str, bytes]] | None = None) -> dict`
  - `get_webhook(self, webhook_url: str) -> dict`

`telegram_api.py`
- `class TelegramAPIError(Exception)`
- `class TelegramClient:` `__init__(self, base_url: str = "https://api.telegram.org", session=None, timeout: int = 60)`
  - `send_message(self, token: str, chat_id: str, text: str) -> dict`
  - `send_photo(self, token: str, chat_id: str, photo: tuple[str, bytes], caption: str | None = None) -> dict`
  - `send_media_group(self, token: str, chat_id: str, photos: list[tuple[str, bytes]], caption: str | None = None) -> dict`

**Verified API facts to build against (2026-07-25):**
- **Discord:** POST to the webhook URL. Text is JSON `{"content": …}`. Files switch the body to `multipart/form-data` with a `payload_json` part plus `files[0]`, `files[1]`… A request must carry at least one of `content` or `files`. `GET` on the webhook URL returns the webhook object (`id`, `name`, `channel_id`) — that's the preflight. Empty-body 204s are possible, so parse defensively.
- **Telegram:** `POST {base}/bot{token}/{method}`. `sendMessage` takes `chat_id` + `text`. `sendPhoto` takes `chat_id` + a `photo` file part + optional `caption`. `sendMediaGroup` takes `chat_id` + a `media` JSON array describing each item (`{"type":"photo","media":"attach://file0"}`, caption on the **first** item only) plus the files as named parts matching those `attach://` names. Responses are `{"ok": true, "result": …}`; on failure `{"ok": false, "description": …}` — **check `ok`, don't rely on the HTTP status alone.**

- [ ] **Step 1: Write the failing tests.** Use the `FakeResponse`/`FakeSession` pattern from `test_graph_api_threads.py` (copy it in; keeping these files independent is worth the duplication). Assert on the exact URL, the exact form/JSON payload, and the returned value — not merely that a call happened. Cover per client:
  - **Discord:** text-only sends JSON with `content` and **no** files part; one image sends multipart with `payload_json` plus `files[0]`; three images send `files[0..2]`; `get_webhook` GETs the URL and returns the object; a non-OK response raises `DiscordAPIError`; **the webhook URL never appears in the raised message**.
  - **Telegram:** `send_message` posts to `…/bot<token>/sendMessage` with `chat_id`+`text`; `send_photo` posts multipart to `sendPhoto` with the caption; `send_media_group` builds the `media` JSON array with `attach://` names matching the file parts and puts the caption on the first item only; `{"ok": false, "description": …}` raises `TelegramAPIError` **even on HTTP 200**; **the bot token never appears in the raised message** (it's in the URL path, so scrub it).
- [ ] **Step 2: Run; expect ImportError.**
- [ ] **Step 3: Implement both clients.**
- [ ] **Step 4:** Run the new tests, then the full suite. Commit.

---

### Task 4: Register both platforms everywhere

**Files:** Modify `worker/clients.py`, `worker/publisher.py`, `worker/preflight.py`, `worker/metrics.py`, `worker/tests/conftest.py`; create `worker/tests/test_discord_telegram_publishing.py`

**One commit.** The import-time asserts mean a partial registration breaks the whole suite; that intermediate state is expected, not a bug to debug.

- [ ] **Step 1: Extend the fixtures.** In `conftest.py` add `FakeDiscordClient` and `FakeTelegramClient` mirroring the real method surfaces, recording call kinds (`discord_text`, `discord_files`, `discord_webhook`, `tg_message`, `tg_photo`, `tg_media_group`, `tg_getme`, `tg_getchat`) and honouring `fail_on`. Extend `make_publication` to accept `platform="discord"` / `"telegram"` with sensible defaults — Discord's `remote_account_id` is `None` (it has none) and its `access_token` is a fake webhook URL; Telegram's `remote_account_id` is `"@testchannel"`.

- [ ] **Step 2: Write the failing tests** in `test_discord_telegram_publishing.py`, covering for **each** platform:
  1. **Text post** publishes with the expected single call and stores a `remote_post_id`.
  2. **Single image** uploads bytes — assert the call carried file content, and that the local file was read from the asset store.
  3. **Album** of 3 sends one call containing all three files, in asset order.
  4. **No tunnel:** drive `run_once` with a local-only asset (no `public_url`) and a deliberately broken `cloudflared_path`; the publication must still **post**, proving no tunnel was attempted. (For Meta platforms that same setup fails — there's an existing test pinning that; this is the mirror image.)
  5. **Caption limits by type:** Telegram accepts a 4096-char text post but rejects the same caption on a single-image post at 1024 (terminal, no API call). Discord rejects >2000 on any type.
  6. **No quota call** is ever made for either platform.
  7. **Preflight** reports `✓` via the read-only check and makes no publish call; a failure reports `✗` without leaking the credential.
  8. **Metrics** are skipped for both: no `post_metrics` row is written and no client call is made, and the run still processes other publications.
  9. **Dry-run** makes zero calls for both.

- [ ] **Step 3: Run; expect failure** (unsupported platform).

- [ ] **Step 4: Register everything.**

`clients.py` — add `DISCORD_BASE = "https://discord.com/api/v10"`, `TELEGRAM_BASE = "https://api.telegram.org"`; add both to `SUPPORTED_PLATFORMS`, `_BASE_URLS`, `_API_VERSIONS` (Discord `"v10"` — pinned, its base already carries it; Telegram `""` — it has no versioning, and the empty string documents that rather than pretending), and `PLATFORM_CAPS`:
```python
    # Discord webhook: 2000-char message, up to 10 attachments, uploads bytes itself.
    # The webhook URL is both address and secret, so there is no separate account id.
    "discord": PlatformCaps(
        supports_text=True, max_carousel=10,
        caption_chars={"text": 2000, "single": 2000, "carousel": 2000},
        uploads_media_bytes=True, uses_account_id=False,
    ),
    # Telegram bot: 4096 for a text message but only 1024 once media is attached;
    # sendMediaGroup takes 2-10 items. Uploads bytes itself.
    "telegram": PlatformCaps(
        supports_text=True, max_carousel=10,
        caption_chars={"text": 4096, "single": 1024, "carousel": 1024},
        uploads_media_bytes=True, uses_account_id=True,
    ),
```

Add the client-factory registry and make `ClientRegistry` use it:
```python
# How to build a client per platform. ClientRegistry used to hardcode GraphClient; Discord and
# Telegram are not Graph APIs, and the publisher only ever calls clients by method name, so the
# construction is the only Meta-specific part left.
_CLIENT_FACTORIES: dict[str, Callable[[str, str], object]] = {
    "instagram": lambda version, base: GraphClient(version, base_url=base),
    "facebook": lambda version, base: GraphClient(version, base_url=base),
    "threads": lambda version, base: GraphClient(version, base_url=base),
    "discord": lambda _version, base: DiscordClient(base_url=base),
    "telegram": lambda _version, base: TelegramClient(base_url=base),
}

assert set(_CLIENT_FACTORIES) == set(SUPPORTED_PLATFORMS), (
    "clients._CLIENT_FACTORIES and clients.SUPPORTED_PLATFORMS disagree"
)
```
In `ClientRegistry.for_platform`, use `_CLIENT_FACTORIES[platform]` when no explicit `factory` was injected (keep the injected-factory path working — the tests rely on it), and key the cache on `(platform, base, version)` so two platforms sharing a base can't collide. Add `_CLIENT_FACTORIES` to the coverage test.

`publisher.py` — add `_publish_discord` and `_publish_telegram` with the standard
`(client, plan, token, config, sleep_fn)` signature, dispatching on `plan["post_type"]` with an
explicit `elif carousel` and a final `else: raise _NonRetryable(...)` (matching the shape the
other publishers now use — a bare `else` silently meaning "carousel" was a real bug found in the
Threads work). Discord's "token" is the webhook URL; Telegram's target is
`plan["account_id"]`. Read bytes from `plan["asset_paths"]`. Register in `_PUBLISHERS`, and add
`"discord": False, "telegram": False` to `_QUOTA_GATED` with a comment that neither platform
exposes a quota endpoint at all (so there is nothing to read — never a hardcoded number).

`preflight.py` — `_check_discord` (GET the webhook, print its name) and `_check_telegram`
(`getMe` then `getChat`, print the chat title); register both in `_CHECKS`. Never print the
credential.

`metrics.py` — add `"discord": None, "telegram": None` to `_FETCHERS`, with a comment that
`None` means *this platform has no metrics*, distinct from a missing key meaning *someone
forgot*. In `run_metrics`, treat a registered `None` as a quiet skip (debug-level at most — it
is expected, not a problem), and exclude those platforms in
`publications_needing_metrics` so they aren't reselected every cycle forever.

- [ ] **Step 5:** Full suite green — Instagram, Facebook and Threads tests must pass **unmodified**. Commit.

---

### Task 5: Discord and Telegram in the dashboard

**Files:** Modify `dashboard/lib/platforms.ts`, `dashboard/components/channel-form.tsx`, `dashboard/components/channel-credentials.tsx`, `dashboard/components/publication-queue.tsx`

- [ ] **Step 1: Add both entries plus the new capability fields** to `platforms.ts`, mirroring the worker exactly (read `worker/clients.py`'s `PLATFORM_CAPS` and copy the values). Every entry gains `usesAccountId: boolean` and `captionChars: Record<string, number>` replacing `maxCaptionChars`; add a `captionLimit(platform, postType)` helper. Discord: label "Discord", badge "DC", `usesAccountId: false`, and its token field is a **webhook URL**. Telegram: label "Telegram", badge "TG", `accountIdLabel: "Channel (@name or chat id)"`.

  Update every existing caller of `maxCaptionChars` (the composer's counter and the caption-limit helper in `lib/`) to the per-type lookup. Instagram/Facebook/Threads behaviour must be unchanged.

- [ ] **Step 2: Honour `usesAccountId`** in `channel-form.tsx` and `channel-credentials.tsx`: when false, hide the account-id field entirely and label the secret field "Webhook URL" (with a hint that it's the whole credential) instead of "Access token". Don't submit an empty account id as `""` if the rest of the code expects `null` — check what `createChannel` does.

- [ ] **Step 3: No metrics strip** for platforms that have none — `publication-queue.tsx` should render nothing (not an empty row of dashes) for Discord and Telegram posted rows. Keep the Instagram, Facebook and Threads arms byte-identical.

- [ ] **Step 4:** `npx tsc --noEmit` clean; verify in the browser on port **3939** (reuse it) that adding a Discord channel asks for exactly one credential and no account id, and that existing channels render unchanged. Save a screenshot. **Don't modify `data/socialscheduler.db`** — if you create a test channel, delete it and report before/after counts. Commit.

---

### Task 6: Docs and end-to-end verification

**Files:** Modify `docs/meta-setup.md` (or add `docs/other-platforms-setup.md` — see below), `reference.md`, `docs/tasks.md`

- [ ] **Step 1: Setup guides.** `docs/meta-setup.md` is Meta-specific by name and content; Discord and Telegram don't belong there. Create **`docs/other-platforms-setup.md`** in the same plain, numbered, non-technical voice, and link to it from `docs/meta-setup.md` and `readme.md`. Cover:
  - **Discord:** Server Settings → Integrations → Webhooks → New Webhook, pick the channel, **Copy Webhook URL**; paste it as the channel's only credential. Warn that anyone with the URL can post to that channel, so treat it like a password.
  - **Telegram:** message **@BotFather** → `/newbot` → copy the token; add the bot to your channel and **promote it to admin with "Post messages"** (the step people miss); the channel id is `@yourchannelname` (or a numeric id for private channels). Note that `preflight` catches a bot that isn't an admin.
  - Both: the limits users will hit — Discord 2000 chars / 10 attachments; Telegram 4096 text, **1024 with a photo**, 2–10 per album.
- [ ] **Step 2: `reference.md`** — verified endpoints, payload shapes (`payload_json` + `files[n]`; `attach://` naming for `sendMediaGroup`), the `{"ok": false}`-on-HTTP-200 gotcha, and that neither platform offers metrics or a quota endpoint.
- [ ] **Step 3: Verify end-to-end in dry-run against a COPY of the database** — a text, image and album post for each platform; confirm each reports `dry_run` with the right platform and post type, and that **no tunnel is opened**. Delete the copy. Confirm the real DB's row counts and `foreign_key_check` are unchanged.
- [ ] **Step 4:** Full worker suite and `npx tsc --noEmit`.
- [ ] **Step 5: `docs/tasks.md`** — mark the sub-project done, listing what shipped, and record the owner-gated follow-up (a real post to each needs a Discord webhook URL and a Telegram bot promoted to channel admin) plus the standing limitation that neither platform has metrics, so both rank 0 in auto-fill until the BPP work.
- [ ] **Step 6:** Commit.

---

## Definition of done

- Worker suite green (239 pre-existing + new); `tsc` clean.
- Text, image and album publish in tests for both platforms; **no tunnel** is opened for either.
- Telegram enforces 4096 for text but 1024 with media; Discord 2000.
- Neither platform makes a quota call; neither writes metrics rows.
- Instagram, Facebook and Threads behaviour unchanged throughout.
- All registries (now including `_CLIENT_FACTORIES`) provably cover `SUPPORTED_PLATFORMS`.
- The real database is untouched; migration verified against a copy first.
- Real posting **not** attempted — owner-gated and recorded in `docs/tasks.md`.
