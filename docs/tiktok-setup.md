# TikTok setup

A step-by-step to connect a TikTok account and deliver one real video.

TikTok works differently from every other channel here, and it is worth knowing why before
you start — it is TikTok's design, not a missing feature:

- **Your caption does not travel.** TikTok's upload endpoint accepts the video file and
  nothing else. The video lands in your TikTok inbox, you tap the notification, and you
  write the caption in TikTok's own editor. SocialScheduler keeps your caption on the post
  page with a **Copy caption** button, because copying it is the actual workflow.
- **Video only.** TikTok will only accept photos from a public URL on a domain you have
  proven you own via DNS. This tool serves assets from a throwaway address that changes
  every restart, so photos are not possible here. If you ever buy a domain, that changes.
- **The dashboard will say "In your TikTok inbox", not "Posted"** — because that is the
  truth until you publish it.

> **Why not fully automatic?** TikTok has a direct-post mode that carries the caption and
> publishes outright. It requires their app audit, which requires a public website with a
> privacy policy and terms of service, and explicitly excludes private-use tools — which is
> exactly what this is. See `docs/superpowers/specs/2026-08-22-tiktok-adapter-design.md`.

---

## What you need

A TikTok account, and about fifteen minutes to register a developer app.

**Every install registers its own app.** If someone else clones this repo, they make their
own — you never share your key and secret. TikTok attaches the app audit, the posting
quotas and the terms of service to the *app*, so a shared key makes one person accountable
for everyone else's posting. Their own app costs them ten minutes and needs no audit.

---

## Step 1 — Create the app

1. Go to <https://developers.tiktok.com> and sign in with your TikTok account.
2. **Manage apps → Connect an app**. Give it a name (e.g. "SocialScheduler").
3. Add two products to it: **Login Kit** and **Content Posting API**.

## Step 2 — Set the app type to Desktop  ← the step people miss

In the app's settings, set the platform/app type to **Desktop**.

This is the one that matters. A **Web** app must use an `https://` redirect URI, which this
tool has no way to provide — it runs on `localhost`. A **Desktop** app is allowed to use
`http://localhost` with a port, which is why no domain and no tunnel are needed here. Get
this wrong and TikTok rejects the redirect with an error that never mentions the app type.

## Step 3 — Register the redirect URI

Under Login Kit, add this **exactly**:

```
http://localhost:3939/api/channels/tiktok/callback
```

No trailing query string and no `#fragment` — TikTok rejects both. If you run the dashboard
on a different port, change `3939` here to match.

## Step 4 — Put the credentials in `.env`

Copy the **Client key** and **Client secret** from the app page into the repo-root `.env`:

```
TIKTOK_CLIENT_KEY=your-client-key
TIKTOK_CLIENT_SECRET=your-client-secret
```

Then restart the dashboard so it picks them up (`Ctrl-C`, then `npm run dev` from
`dashboard/`).

## Step 5 — Connect the account

1. In the dashboard: **Channels → Add channel → Platform: TikTok**.
2. Click **Connect TikTok account**. TikTok opens, you approve, and you land back on the
   Channels page with the account added.

There is no token to paste, and no account id to look up. TikTok access tokens expire after
**24 hours**, so anything you pasted by hand would be dead by tomorrow — the worker
refreshes it for you instead.

You are approving three permissions: read your basic profile (so the channel can be named
after your account), upload video to your inbox, and read your video list (for metrics).
Posting on your behalf is *not* among them.

## Step 6 — Preflight (verify without posting)

```
source .venv/bin/activate
python -m worker.preflight
```

A `✓ ... token OK — account reachable (...)` line means the connection works. This is
read-only — it posts nothing.

It also prints **reconnect before &lt;date&gt;**. That is your refresh token's 365-day
expiry. When it approaches, come back to Channels and connect again; there is no way to
extend it.

## Step 7 — Deliver one real video

1. In `.env`, check the safety switches: `DRY_RUN=0` and `KILL_SWITCH=0`.
2. **Compose** a post with a video, target the TikTok channel, and schedule it a minute in
   the past.
3. Run one worker cycle:
   ```
   python -m worker.run --once
   ```
4. Expect three things:
   - the log says `delivered to inbox -> <publish_id>`
   - a TikTok notification arrives on your phone
   - the dashboard says **"In your TikTok inbox — open TikTok to publish"**
5. Tap the notification, write your caption (copy it from the post page), and publish.

Within a while, the dashboard flips that send to **"Live on TikTok"** on its own — the
worker keeps checking for a week. If you never publish it, it settles on **"Delivered —
publication unconfirmed"**, which is the honest answer rather than a guess.

---

## Things that will trip you up

| What you see | What it means |
|---|---|
| TikTok rejects the redirect URI | The app type is **Web**, not Desktop (Step 2), or the URI does not match Step 3 character for character. |
| "TIKTOK_CLIENT_KEY is not set in .env" | You added it but did not restart the dashboard. |
| The composer refuses your post | TikTok is video only. An image or text post cannot go to it. |
| "reconnect this channel" on a send | The 365-day refresh token expired, or you revoked the app in TikTok's settings. Connect again in Channels. |
| Your caption is not on TikTok | Expected — see the top of this page. Copy it from the post page. |
