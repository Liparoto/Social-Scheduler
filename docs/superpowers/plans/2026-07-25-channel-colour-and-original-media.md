# Channel Colour + Original Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two small, independent improvements — (1) platforms that don't constrain aspect ratio publish the **original** image instead of the Instagram-shaped derivative, and (2) each channel's accent colour can be **chosen from preset swatches** instead of only being derived from its id.

**Design (settled with the owner):**
- Colour is stored as a **hue (0–360 integer)**, not a hex. `dashboard/lib/format.ts`'s `channelColor` already derives the text/background/dot triple from a single hue, so storing a hue keeps contrast, theming and dark-mode behaviour exactly as they are and makes it impossible to pick an illegible combination. `NULL` means "keep the automatic colour", so every existing channel looks unchanged until someone picks.
- Preset **swatches only** — no free colour input.
- Marking a channel inactive already exists (`channel-toggles.tsx`); channel deletion stays out of scope.

## Global Constraints

- **Never modify `data/socialscheduler.db`.** It has two live channels (Instagram, Threads) that post for real. It is in **WAL mode** — any copy must include the `-wal` and `-shm` sidecars or it silently misses recent writes.
- Worker tests: `.venv/bin/python -m pytest worker/tests -q` — **314 passing**, ~110s; let it finish. Dashboard: `cd dashboard && npx tsc --noEmit`.
- No new dependencies. Never log tokens or PII.
- Instagram, Facebook and Threads publishing behaviour must not change except where Task 1 explicitly says so.
- Commit after each task.

---

### Task 1: Publish the original image where aspect ratio doesn't matter

**Files:** Modify `worker/clients.py`, `worker/publisher.py`; extend `worker/tests/test_platform_dispatch.py` and `worker/tests/test_discord_telegram_publishing.py`

Uploaded images are conformed to Instagram's spec (cropped or padded into the 4:5–1.91:1 range) and stored as `assets.publish_path` alongside the untouched `assets.storage_path`. `publisher._resolve_local_path` currently prefers `publish_path` for **every** platform, so a Discord or Telegram post shows a needlessly letterboxed image on platforms with no aspect-ratio rules at all.

**Interfaces produced:** `PlatformCaps.needs_conformed_media: bool = True`.

- [ ] **Step 1: Write the failing tests**

In `test_platform_dispatch.py`, assert the declared values — Instagram, Facebook and Threads `needs_conformed_media is True`; Discord and Telegram `False` — and that the capability registry still covers `SUPPORTED_PLATFORMS`.

In `test_discord_telegram_publishing.py`, add a test proving the **file actually uploaded** is the original: create an asset whose `storage_path` and `publish_path` point at two files with **different contents**, publish a single-image post to Discord and to Telegram, and assert the bytes handed to the client match the **original**. Add the mirror for Instagram asserting it still resolves the **conformed** file (that one guards against a regression in the working platforms).

- [ ] **Step 2: Run them; expect failure** (`needs_conformed_media` doesn't exist).

- [ ] **Step 3: Add the capability** to `PlatformCaps` in `worker/clients.py`, defaulting to `True` so every existing platform keeps today's behaviour, with a comment explaining that it means "this platform constrains aspect ratio, so send the Instagram-conformed derivative". Set `needs_conformed_media=False` on the Discord and Telegram entries only.

- [ ] **Step 4: Use it** in `worker/publisher.py`'s `_resolve_local_path`. It needs the platform's caps — pass them in (or the platform name) from the caller rather than looking up a global inside a helper that currently takes only an asset and config. When `needs_conformed_media` is False, prefer `storage_path` (the original) and fall back to `publish_path` if the original is missing; when True, keep today's precedence exactly. Update the docstring, which currently says the precedence is the same as `_resolve_url`.

  Check every call site of `_resolve_local_path` (`_validate` and `_build_plan` both use it) and keep them consistent — validation must check the same file the publisher will actually send, or a post could validate against one file and upload another.

- [ ] **Step 5:** Full suite green, then commit.

---

### Task 2: Store a chosen hue per channel

**Files:** Create `migrations/0010_channel_colour.sql`, `worker/tests/test_migration_0010.py`; modify `dashboard/lib/types.ts`, `dashboard/lib/queries.ts`, `dashboard/app/api/channels/route.ts`, `dashboard/app/api/channels/[id]/route.ts`

**This migration is purely additive** — a nullable `ALTER TABLE … ADD COLUMN`, so unlike `0008`/`0009` it needs **no table rebuild** and carries none of the cascade risk. Do not copy their rebuild procedure; a single `ALTER TABLE` is correct here.

- [ ] **Step 1: Write the failing test** — `test_migration_0010.py`: build a DB through `0009`, seed a channel, apply `0010`, then assert the channel row survives with its values intact, the new column exists and defaults to `NULL`, an integer hue can be stored and read back, and `PRAGMA foreign_key_check` is empty. Follow the shape of `test_migration_0009.py` but without the rebuild-specific assertions.

- [ ] **Step 2: Run; expect failure.**

- [ ] **Step 3: Write the migration** — `ALTER TABLE channels ADD COLUMN color_hue INTEGER;` with a comment recording that NULL means "derive the colour from the channel id, as before", and that a hue (0–360) is stored rather than a hex so the existing HSL derivation continues to guarantee contrast.

- [ ] **Step 4: Expose it through the dashboard's data layer**
  - `dashboard/lib/types.ts` — add `color_hue: number | null` to `Channel`.
  - `dashboard/lib/queries.ts` — include it in `CreateChannelInput`, in `createChannel`'s INSERT, and in `updateChannel`'s allowed fields. Check whether any channel-shaped `SELECT` lists columns explicitly and add it there too.
  - `dashboard/app/api/channels/route.ts` and `[id]/route.ts` — accept `color_hue`, **validating it is either null or an integer 0–360**, and rejecting anything else with the routes' existing 400 shape. Don't let a string or an out-of-range number reach the database.

- [ ] **Step 5:** `npx tsc --noEmit` clean; run the worker suite (the migration test is in it). Apply the migration for real with `.venv/bin/python migrate.py`, confirm re-running says "Nothing to do", and confirm the live DB's row counts and `foreign_key_check` are unchanged. Commit.

---

### Task 3: Pick the colour from preset swatches

**Files:** Modify `dashboard/lib/format.ts`, `dashboard/components/ui.tsx`, `dashboard/components/channel-form.tsx`, `dashboard/components/channel-credentials.tsx` (or wherever channel editing lives), plus the call sites listed below

- [ ] **Step 1: Make the colour helpers accept a chosen hue**

In `dashboard/lib/format.ts`, `channelColor(channelId)` becomes `channelColor(channelId, colorHue?: number | null)` — using the given hue when it's a number, otherwise falling back to today's `channelHue(channelId)`. **Keep the existing signature working** (a call with one argument must behave exactly as now), so unrelated call sites don't have to change in lockstep.

Export the swatch palette from the same module — around **10 hues**, evenly spread and visually distinct, each with a short human name (the picker needs labels for accessibility, and a name reads better than a number in a tooltip).

- [ ] **Step 2: Thread the hue through the places that render a channel**

`channelColor` is used in `dashboard/components/ui.tsx` (the `ChannelChip`, which takes `id` today), `dashboard/app/page.tsx`, `dashboard/components/composer.tsx`, `dashboard/components/library-view.tsx` and `dashboard/components/post-editor.tsx`.

Give `ChannelChip` an optional `colorHue` prop and pass it from each caller. **Some call sites may not have the hue to hand** — a publication row knows `channel_id` but may not carry the channel's colour. Check each one: where the data isn't there, add it to the query that feeds it (`getPublicationsOverview` and any sibling that supplies channel display data), rather than leaving that surface on the old auto colour while others change. If a call site genuinely can't get it without disproportionate work, say so in your report instead of silently leaving it inconsistent.

- [ ] **Step 3: Add the swatch picker**

In the channel form (create) and the channel edit panel, add a row of swatch buttons rendering the palette, plus an explicit **"Automatic"** choice that stores `NULL`. The selected swatch must be visibly selected (not colour alone — use a ring or check, so it's distinguishable without relying on colour vision), each button needs an accessible label, and the whole row must be keyboard-navigable. Show a live preview of the resulting chip so the choice is obvious before saving.

- [ ] **Step 4: Verify in the browser**

Dev server is on port **3939** — reuse it. Confirm: an existing channel with no chosen hue looks **exactly as before**; picking a swatch updates the chip on the Channels page and the Overview queue rail; "Automatic" returns it to the derived colour; the choice survives a reload. **Do not modify `data/socialscheduler.db`** — if you change a real channel's colour to test, set it back to its original value (`NULL` unless it was already set) and report the before/after.

Save a screenshot of the picker and reference the path in your report.

- [ ] **Step 5:** `npx tsc --noEmit` clean; commit.

---

## Definition of done

- Discord and Telegram upload the **original** image; Instagram, Facebook and Threads still upload the conformed derivative, proven by a test comparing actual file contents.
- A channel's colour can be chosen from swatches or left automatic; existing channels are visually unchanged until someone picks.
- Worker suite green; `tsc` clean; the live database's channel rows are untouched apart from the additive column.
