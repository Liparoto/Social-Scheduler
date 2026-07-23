# Meta setup & first live post

A step-by-step to connect your **own** Instagram professional account and publish one
real post — staying in **Development mode**, no App Review, no paid tools.

> Verified against Meta docs on 2026-07-22 (API v25.0). Meta iterates the dashboard
> wording, so exact button labels may differ slightly; the panel locations are stable.
> Items marked ⚠ couldn't be pinned to a single authoritative page.

## What you need first
- An Instagram **professional** account (Business or Creator). Personal accounts can't publish via API.
- A Meta developer account (developers.facebook.com).

---

## Step 1 — Create the Meta app (Development mode)
1. developers.facebook.com → **My Apps** → **Create App**.
2. The dashboard is now **use-case based**. Choose **"Manage messaging and content on Instagram."**
   (If you don't see it: **Other → Business** also works, but the Instagram use case is the intended path.)
3. Name the app, confirm your email, create. It starts in **Development mode** — leave it there.
4. Copy the **App ID** and **App Secret** (App Settings → Basic) into your `.env`:
   ```
   META_APP_ID=...
   META_APP_SECRET=...
   ```

## Step 2 — Use the Instagram-Login path (simplest — no Facebook Page)
1. App Dashboard → **Products** → **Instagram** → **Set up**.
2. Open **"API setup with Instagram login"** (NOT the Facebook-login one).
3. Under **Generate access tokens**, click **Add account** → log in with your IG
   Creator/Business account and authorize.
4. Click **Generate token** next to the account. Approve the dialog. **Copy the token now —
   it isn't shown again.** (This first token is short-lived, ~1 hour — see Step 3.)
5. The same panel shows your **Instagram user id** (a long number). Note it.
   - You don't need to add yourself as an "Instagram Tester" for your *own* account — the
     Add-account/Generate-token step is the authorization. ⚠ (Strongly implied by Meta's
     flow; not stated verbatim on one page.)

Then point the worker at the Instagram-Login host — add to `.env`:
```
META_GRAPH_BASE=https://graph.instagram.com
```

## Step 3 — Turn the short-lived token into a 60-day token
The Step 2 token expires in ~1 hour. Exchange it (uses your app secret — server-side only):
```
curl -s "https://graph.instagram.com/access_token\
?grant_type=ig_exchange_token\
&client_secret=YOUR_APP_SECRET\
&access_token=SHORT_LIVED_TOKEN"
```
The returned `access_token` is valid **60 days**. Refresh before expiry with
`ig_refresh_token` (see reference.md). Use this long-lived token in Step 4.

> Ask me and I can add a `python -m worker.exchange_token` helper that does this for you
> using the app id/secret already in `.env`.

## Step 4 — Add the channel in the dashboard
1. Start the dashboard: `cd dashboard && npm run dev` → open the printed URL.
2. **Channels → Add channel**:
   - Platform: **Instagram**
   - Account name: e.g. `Liparoto`
   - Timezone: e.g. `America/New_York`
   - **IG user id**: from Step 2
   - **Access token**: the 60-day token from Step 3
3. Save.

## Step 5 — Preflight (verify the token WITHOUT posting)
From the repo root, with the venv active:
```
source worker/.venv/bin/activate
python -m worker.preflight
```
A `✓ token OK — published N/M ...` line means auth + IG user id are valid and content
publishing is reachable. This posts **nothing** — it only reads your quota. Fix any `✗`
before continuing.

## Step 6 — Host one test image at a public URL
Meta fetches the image from a public URL, so it must return **raw JPEG bytes** (not an HTML
page). **JPEG only** for image posts.
- Easiest free option: **GitHub raw** — commit a `test.jpg` to any repo and use the
  `https://raw.githubusercontent.com/USER/REPO/main/test.jpg` URL (NOT the `/blob/` page URL).
- Also fine: an S3/Cloudflare R2 public object (set content-type `image/jpeg`), or a free
  cloudflared/ngrok tunnel exposing a local file server that sends `Content-Type: image/jpeg`.
- **Won't work:** Google Drive / Dropbox *share* links (they return HTML).

Verify it:
```
curl -sI "https://your-url/test.jpg"   # expect: 200 and content-type: image/jpeg
```

Set the base URL your uploaded assets will use (only needed for real posting):
```
PUBLIC_ASSET_BASE_URL=https://your-public-host
```
For a very first smoke test you can skip the dashboard upload and point a post's asset
straight at a known-public JPEG — ask me and I'll wire that quickly.

## Step 7 — Publish ONE real post
1. In `.env`, flip the safety switch: `DRY_RUN=0` (keep `KILL_SWITCH=0`).
2. In the dashboard, **Compose** a post to that channel and schedule it for a minute in the
   **past** (so it's due now).
3. Run one worker cycle:
   ```
   python -m worker.run --once
   ```
4. Check Instagram — the post should appear. In the dashboard Overview it flips to
   **Posted** with a real `remote_post_id` (not `DRYRUN`).

If it fails, the publication shows **Failed** with the exact Graph API error — fix and hit
**Retry**. Nothing is silent.

---

## After the first success
- Put `DRY_RUN` back to `1` for day-to-day safety until you're ready to run for real.
- Metrics for the post will populate within a few worker cycles (reach/saves/likes appear on
  the Overview row).
- `KILL_SWITCH=1` halts the worker instantly at any time.

## Notes / gotchas
- Media containers **expire after 24h** — the worker publishes promptly, so this only matters
  if a post sits failed for a day.
- Publishing rate limit is read live per account (Meta's own docs disagree on 50 vs 100) — the
  worker paces itself; you don't set a number.
- Our uploader currently accepts JPEG/PNG/WebP, but **Meta only accepts JPEG for image posts** —
  use JPEG for anything you'll actually publish. (A validation tightening we can add.)
