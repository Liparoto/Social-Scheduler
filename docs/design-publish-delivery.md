# Design — Publish Delivery (getting images to Meta)

_Date: 2026-07-22 · Status: proposed, awaiting review_

## The problem

Instagram's publishing API does **not** accept image bytes. You give Meta a **public URL**,
and **Meta's servers download the image themselves**. Our images live on the owner's Mac
(`data/assets/<hash>.<ext>`) and the dashboard runs on `localhost` — neither is reachable from
the public internet. So every publish needs the image to be briefly available at a public
`https://` link that returns raw JPEG bytes.

Constraints (from `CLAUDE.md`): local-only, no paid SaaS, no cloud dependency, per-install
independence, minimize exposure, kill switch, never expose secrets.

## The approach: worker-managed ephemeral tunnel

The public link only needs to exist for the seconds Meta spends downloading. So the **worker**
brings a tunnel up at publish time, computes each image URL fresh, publishes, and tears it down.
Because the URL is built at publish time, the fact that quick-tunnel URLs change each run is
irrelevant — we never persist or reuse one.

```
PUBLISH CYCLE (worker, only when there is due, non-dry-run work):
  1. Start a tiny read-only asset server on 127.0.0.1:<ASSET_PORT>.
       Serves ONLY files under data/assets, addressed by <storage_path> (the content hash).
       No directory listing, no other routes, path-traversal guarded.
  2. Start `cloudflared tunnel --url http://127.0.0.1:<ASSET_PORT>`.
       Parse its stdout for the assigned https://<random>.trycloudflare.com base.
  3. For each asset in the post, build:  <tunnel_base>/<storage_path>
  4. Create the IG container(s) with those URLs → poll status → publish (existing flow).
  5. Tear the tunnel down (and stop the asset server if idle).
```

### Why these choices

- **Tunnel points at a dedicated image-only server, NOT the dashboard.** Only raw image bytes,
  at unguessable content-hash paths, are ever exposed — never the composer, channels, or tokens.
- **It lives in the worker.** The worker is already the only component that talks to Meta and
  already has the kill switch. Publishing infrastructure belongs with the publisher.
- **URLs are computed at publish time, not stored.** Sidesteps the ephemeral-URL limitation and
  means `assets.public_url` is no longer authoritative for the tunnel path (kept nullable for the
  "paste a public URL" escape hatch).
- **Free + easy for every cloner.** Setup is a single `brew install cloudflared` (macOS) or one
  binary download (Windows). No Cloudflare account, domain, or credit card. Per-install, nothing
  shared — consistent with the multi-tenancy rule.

## Components

| Component | File | Responsibility |
|---|---|---|
| Asset server | `worker/asset_server.py` | Minimal stdlib `http.server` serving `data/assets/<storage_path>` read-only, with content-type + path-traversal guard. Bound to `127.0.0.1`. |
| Tunnel manager | `worker/tunnel.py` | Start/stop `cloudflared` as a subprocess; parse and expose the live public base URL; health/liveness; clean teardown. Detects a missing `cloudflared` binary and fails loudly with install guidance. |
| Publisher wiring | `worker/publisher.py` | When not dry-run and the post has local assets, resolve each asset URL as `<tunnel_base>/<storage_path>` instead of the stored `public_url`. If an asset already has an external `public_url` (paste path), use it as-is and skip the tunnel for it. |
| Run loop | `worker/run.py` | Bring the tunnel up once per cycle only if there is real publish work; guarantee teardown in `finally`. Respect kill switch (no tunnel when killed). |
| Config | `worker/config.py` + `.env.example` | `ASSET_PORT` (default 8787), `CLOUDFLARED_PATH` (default `cloudflared`), `TUNNEL_PROVIDER` (default `cloudflared`; leaves room for alternatives). |

## Data flow / behavioral notes

- **Dry-run:** unchanged — no server, no tunnel, nothing exposed. (Already true.)
- **Kill switch:** no tunnel is ever started while killed.
- **One tunnel per cycle:** shared across all due publications in that cycle, torn down after.
- **Failure = visible, never silent:** if the tunnel won't start (e.g. `cloudflared` missing) or
  Meta can't fetch the image, the publication follows the existing retry/backoff → terminal-fail
  path with a clear `last_error`. It never silently succeeds.
- **`assets.public_url`** stays in the schema but becomes optional: null → use the tunnel;
  non-null external URL → use it directly (manual/paste escape hatch). No migration needed.

## Security

- Bind the asset server to `127.0.0.1` so only `cloudflared` (same machine) can reach it.
- Serve **only** files that resolve inside `data/assets` (reject `..`, absolute paths, symlinks).
- Content-hash filenames are unguessable; no listing endpoint.
- The tunnel is up only during an active publish cycle, then closed.
- Never log the tunnel URL together with anything sensitive; never expose tokens (unchanged).

## Testing / verification

1. **Unit:** asset server serves a known file with correct content-type; rejects traversal.
2. **Unit:** tunnel manager parses a captured sample of `cloudflared` output into the base URL;
   missing-binary path raises a clear error.
3. **Unit:** publisher builds `<base>/<storage_path>` for local assets and passes through an
   external `public_url` untouched. (Fake graph client — no network.)
4. **Integration (local, no Meta):** start server+tunnel, `curl` the public URL, confirm raw
   bytes come back, tear down, confirm the port/tunnel are gone.
5. **Live (one real post):** upload a real JPEG, `DRY_RUN=0`, run one cycle, confirm the image
   appears on Instagram with a real `remote_post_id`, then delete the post. (Owner-gated.)

## Out of scope (deliberately)

- Persistent/named tunnels or a custom domain (unnecessary; quick tunnel is enough).
- Video/Reels delivery specifics (Phase 6; same public-URL mechanism will apply).

## Next after this (owner's request)

Once publishing works end-to-end, **circle back to data / image / caption management** — how
assets and captions are organized, edited, versioned, and reused — before starting Phase 6.
