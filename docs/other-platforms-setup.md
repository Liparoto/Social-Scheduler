# Discord and Telegram setup

A step-by-step to connect a Discord channel and/or a Telegram channel and publish one
real post. Unlike Meta, **neither platform needs a public URL or a tunnel** — the worker
uploads the image bytes directly, so setup is much shorter.

> Verified against the worker's actual client code on 2026-07-25 (`worker/discord_api.py`,
> `worker/telegram_api.py`, `worker/clients.py`). See `reference.md` for the exact request
> shapes.

---

## Discord

### What you need
A Discord server where you have **Manage Webhooks** permission (this is automatic if
you own the server).

### Step 1 — Create a webhook
1. Open your Discord server → the channel you want to post to → the gear icon (or
   **Server Settings**) → **Integrations** → **Webhooks**.
2. Click **New Webhook**. Give it a name (e.g. "SocialScheduler") and confirm it's
   pointed at the right channel.
3. Click **Copy Webhook URL**.

### Step 2 — Add the channel in the dashboard
1. Start the dashboard: `cd dashboard && npm run dev` → open the printed URL.
2. **Channels → Add channel**:
   - Platform: **Discord**
   - Account name: e.g. `My Server #announcements`
   - Timezone: e.g. `America/New_York`
   - **Webhook URL**: paste what you copied in Step 1.

That's the only field. Discord has no separate "account id" — **the webhook URL is both
the address and the secret.** Anyone who has it can post to that channel, so treat it
like a password: don't paste it into a chat, screenshot, or public repo. If it ever
leaks, delete the webhook in Discord and create a new one — this immediately invalidates
the old URL.

### Step 3 — Preflight (verify WITHOUT posting)
```
source worker/.venv/bin/activate
python -m worker.preflight
```
A `✓ ... webhook OK — reachable ...` line means the URL is valid. This is a read-only
check (Discord's webhook object) — it posts nothing.

### Step 4 — Publish ONE real post
1. In `.env`, flip the safety switch: `DRY_RUN=0` (keep `KILL_SWITCH=0`).
2. In the dashboard, **Compose** a post to that channel and schedule it for a minute in
   the past.
3. Run one worker cycle:
   ```
   python -m worker.run --once
   ```
4. Check the Discord channel — the message should appear.

**Limits you'll hit:**
- **2000 characters** per message.
- **Up to 10 attachments** (images) per message/post.

---

## Telegram

### What you need
A Telegram account, and a channel you administer (a "channel" here means Telegram's
broadcast channel type — not a group chat).

### Step 1 — Create a bot and get its token
1. In Telegram, message **@BotFather**.
2. Send `/newbot` and follow the prompts (pick a name and a username ending in `bot`).
3. BotFather replies with a **token** that looks like `123456789:AAExampleTokenText`.
   Copy it.

### Step 2 — Add the bot to your channel and make it an admin (the step people miss)
A bot can't post to a channel just by knowing the channel name — it has to be a member
**with posting rights**.
1. Open your channel → **Administrators** (or **Manage Channel** → **Administrators**).
2. **Add Admin** → search for your bot by its username → add it.
3. Make sure **"Post Messages"** is enabled for the bot in its admin permissions.

Skipping this step is the single most common mistake — the bot token can be perfectly
valid while the bot still can't post anywhere, because it was never actually invited to
the channel. `preflight` (Step 4 below) catches exactly this.

### Step 3 — Note your channel id
- **Public channel:** use `@yourchannelname` (the same handle from your channel's
  invite link, `t.me/yourchannelname`).
- **Private channel:** you need the numeric chat id instead (a negative number, e.g.
  `-1001234567890`). The simplest way to get it: forward any message from the channel
  to **@userinfobot**, which will show you the channel's id.

### Step 4 — Add the channel in the dashboard
1. **Channels → Add channel**:
   - Platform: **Telegram**
   - Account name: e.g. `My Telegram Channel`
   - Timezone: e.g. `America/New_York`
   - **Bot token**: from Step 1
   - **Channel id**: `@yourchannelname` or the numeric id from Step 3

### Step 5 — Preflight (verify WITHOUT posting)
```
source worker/.venv/bin/activate
python -m worker.preflight
```
This runs two checks: `getMe` (proves the bot token is valid) and then `getChat` on your
channel id (proves the bot can actually see that chat). A `✓ ... token OK — chat
reachable ...` line means both passed. If you skipped Step 2, this is where it fails —
with a clear error rather than a silent no-op.

### Step 6 — Publish ONE real post
1. In `.env`, flip the safety switch: `DRY_RUN=0` (keep `KILL_SWITCH=0`).
2. In the dashboard, **Compose** a post to that channel and schedule it for a minute in
   the past.
3. Run one worker cycle:
   ```
   python -m worker.run --once
   ```
4. Check the channel — the message should appear.

**Limits you'll hit:**
- **4096 characters** for a text-only message, but only **1024 characters** once a photo
  is attached (Telegram's caption limit is much shorter than its message limit).
- **Albums (multi-photo posts) need 2–10 items** — fewer than 2 or more than 10 is
  rejected before anything is sent.

---

## Neither platform has metrics

Discord webhooks and the Telegram Bot API expose **no metrics and no publish-quota
endpoint** — there's nothing equivalent to Instagram's reach/saves or Facebook's
reactions/comments to fetch back. Posted rows for these two platforms simply show no
metrics strip in the dashboard; this isn't a bug, there is nothing there to show. It also
means auto-fill's "prefer top performers" ranking can't score Discord/Telegram posts
(they rank 0, same gap Facebook and Threads already have) until the planned
best-performing-post work revisits the ranking formula.

## After the first success
- Put `DRY_RUN` back to `1` for day-to-day safety until you're ready to run for real.
- `KILL_SWITCH=1` halts the worker instantly at any time.
- If it fails, the publication shows **Failed** with the exact error — fix and hit
  **Retry**. Nothing is silent.
