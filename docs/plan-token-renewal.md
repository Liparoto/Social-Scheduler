# Plan: keep Meta tokens alive (token upkeep)

## Why
On 2026-09-22 the Threads token hit its 60-day expiry. Nothing renewed it and nothing
tracked when it would die, so the first sign was a failed post the next evening. Every
install (the owner's, Brittany's, any future clone) has the same cliff for Instagram and
Threads.

## What Meta allows (checked against live responses 2026-09-23)
| Platform | Lifetime | Renew | Check expiry |
|---|---|---|---|
| Threads | ~60 days | `GET graph.threads.net/refresh_access_token?grant_type=th_refresh_token` — token must be ≥24h old and unexpired | `GET graph.threads.net/v1.0/debug_token?input_token=T&access_token=T` → `is_valid`, `expires_at` |
| Instagram (Instagram Login, `graph.instagram.com`) | ~60 days | `GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token` — same ≥24h rule; the response's `expires_in` is the only expiry source | none — renewing is how we learn the date |
| Facebook Page | never (`expires_at: 0`) | not needed | `graph.facebook.com/debug_token` with the app token (`META_APP_ID|META_APP_SECRET`) |
| TikTok | 24h | already handled by `worker/tiktok_tokens.py` | — |

An **expired** token can never be renewed — only a human reconnect fixes it. So the
whole point is to renew well before the date.

## Design
- **Migration `0029_token_health.sql`** adds two columns to `channels`:
  `token_error` (what a human must know, shown on the Channels page) and
  `token_next_check_at` (throttle). `token_expires_at` already exists and gets filled.
- **`worker/token_upkeep.py`** — `run_token_upkeep(conn, config, now, ...)`, called each
  worker cycle right beside the TikTok refresh. Per active IG/Threads/FB channel, only when
  `token_next_check_at` is due:
  - Threads: debug_token → store expiry; if ≤14 days left, renew.
  - Instagram (IG Login): renew when expiry unknown or ≤14 days left.
  - Facebook / IG via Facebook Login: check only (validity + expiry), never renew.
  - Next check in 12h on success, 1h after a network blip.
- **Safety rules**
  - A new token is written only after Meta returns one; a failed renewal never touches
    the stored token.
  - Invalid/expired → `token_error` tells the owner to reconnect; retrying can't help.
  - Network trouble is not an error for the owner — it just retries in an hour.
  - Never logs a token (errors go through `redact()`).
  - Runs in dry-run mode too: it posts nothing, and keeping a test install's token alive
    is the point.
- **Dashboard**
  - Saving a new access token clears `token_expires_at`, `token_error`, and
    `token_next_check_at`, so the worker checks the new token on its next cycle.
  - The channel card's "Access token" row shows the expiry date, turns amber inside 14
    days, and shows `token_error` in red.

## Rollout
Merge → Update (runs migrations) → restart the worker. Brittany's install gets it through
her Update launcher; her tokens start renewing on the next worker cycle.
