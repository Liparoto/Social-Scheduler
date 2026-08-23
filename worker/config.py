"""Configuration for the worker.

Static config (DB path, Graph version, timing) is loaded once into a Config object.
The two SAFETY SWITCHES — DRY_RUN and KILL_SWITCH — are read LIVE on every loop
iteration instead, so you can toggle them in .env (or the dashboard) and the worker
reacts without a restart.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# The variables that were ALREADY in the real environment when this process started.
#
# An explicitly-set variable is a deliberate instruction from whoever launched the
# worker, so it outranks .env for the life of the process. Without this, the
# override=True reload below silently clobbered it on the very first loop, and
#
#     DRY_RUN=1 .venv/bin/python -m worker.run --once
#
# became a LIVE run against .env's DRY_RUN=0 — it opened a tunnel and created a real
# Meta container. That is the opposite of what the command says, and it is the command
# this project's own docs told you to use to check things safely.
#
# This does not weaken live toggling. The launcher never exports the switches — it only
# reads .env to decide what to print — so in the normal path DRY_RUN/KILL_SWITCH are
# absent from the environment and .env stays authoritative, reload after reload.
_LAUNCH_ENV_KEYS = frozenset(os.environ)


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def load_env(override: bool = False) -> None:
    """Load KEY=VALUE pairs from the repo-root .env into os.environ.

    Minimal, stdlib-only (mirrors migrate.py) so the worker has no hard dependency
    on python-dotenv just to read a flag. With override=True, .env wins over the
    current environment — used each loop so live edits to the switches take effect.

    EXCEPT for variables that were set in the environment at launch: those always win,
    even with override=True. See _LAUNCH_ENV_KEYS for why.
    """
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip()
        if not key:
            continue
        if key in _LAUNCH_ENV_KEYS:
            # Explicit at launch — never overwritten, not even by override=True.
            continue
        if override or key not in os.environ:
            os.environ[key] = val


def dry_run_active() -> bool:
    """Live read: worker logs what it WOULD publish and posts nothing."""
    return _as_bool(os.environ.get("DRY_RUN"), default=True)


def kill_switch_active() -> bool:
    """Live read: worker halts immediately and publishes nothing."""
    return _as_bool(os.environ.get("KILL_SWITCH"), default=False)


@dataclass
class Config:
    database_path: Path
    asset_storage_dir: Path
    public_asset_base_url: str
    meta_app_id: str
    meta_app_secret: str
    graph_version: str
    graph_base: str
    default_timezone: str
    poll_interval: int
    # Retry policy for failed publications.
    max_attempts: int = 5
    base_backoff_seconds: int = 60
    # How long to wait before retrying when Meta's publish quota is exhausted.
    rate_limit_backoff_seconds: int = 900
    # Container status polling (used for carousel/video readiness).
    status_poll_interval: int = 5
    status_poll_max_tries: int = 60
    # Reels poll separately from images: Meta transcodes video server-side, which takes
    # far longer than an image container. 10s x 90 = a 15-minute ceiling, matching the
    # maximum Reel length. This is a considered guess, not a published figure — Meta
    # gives no transcode SLA. Revise from real observations.
    reels_status_poll_interval: int = 10
    reels_status_poll_max_tries: int = 90
    # How long a claimed publication may sit at 'publishing' before the worker treats it
    # as abandoned and marks it failed (see db.recover_stale_claims).
    #
    # This number is a safety margin, not a preference. Too SHORT and a publish still
    # legitimately in flight gets recovered and can be sent twice — the exact bug
    # claiming exists to prevent. Too long only delays visibility of a genuine crash.
    # So it is set well above the worst legitimate case and erring long is correct.
    #
    # Worst case today is a Reel: reels_status_poll_interval (10s) x
    # reels_status_poll_max_tries (90) = 900s of transcode polling, plus
    # tunnel_ready_timeout (60s) and container creation — call it ~17 minutes. 1800s is
    # comfortably clear of that while still surfacing a stranded post the same day.
    # RAISE THIS if the Reels poll budget is ever increased.
    publish_claim_lease_seconds: int = 1800
    # Metrics fetching: only refresh posts published within this window, and no more
    # often than this interval per publication (keeps API usage sane).
    metrics_max_age_days: int = 30
    metrics_min_interval_hours: int = 6
    # Facebook Page-post insight metric names. Meta deprecated a large batch on
    # 2026-06-15 and keeps renaming them, so this is configurable and read as
    # best-effort: if the name is invalid we store null instead of failing.
    fb_post_insight_metrics: str = "post_total_media_view_unique"
    # Threads insight metric names, same reasoning as fb_post_insight_metrics: Meta
    # renames insight metrics without warning, so this is configurable rather than
    # hardcoded into the fetch call.
    threads_insight_metrics: str = "views,likes,replies,reposts,quotes"
    # -- Insights hub -----------------------------------------------------------------
    # Every default below was established by probing the LIVE api on 2026-08-05
    # (python3 -m worker.insights_probe), not from docs. See reference.md, "account-level
    # insights, probed live". Configurable for the same reason fb_post_insight_metrics is:
    # Meta renames these without notice, and a retired name 400s the whole call.
    #
    # Instagram account insights come in two envelopes and a metric can work in one but
    # not the other, so they are two separate settings rather than one list.
    # NOTE: `impressions` is absent on purpose — it now returns 400 in BOTH envelopes.
    # Use `views`. Re-run the probe before adding any name here.
    ig_account_series_metrics: str = "reach,follower_count"
    ig_account_total_metrics: str = (
        "views,reach,profile_views,accounts_engaged,total_interactions,"
        "likes,comments,saves,shares,replies,website_clicks,profile_links_taps"
    )
    # Which audiences to break down, and how. All twelve combinations were verified.
    ig_demographic_metrics: str = (
        "follower_demographics,engaged_audience_demographics,reached_audience_demographics"
    )
    ig_demographic_breakdowns: str = "age,gender,city,country"
    # Threads: `shares` is excluded because it returns HTTP 500 (a server error, not a
    # clean rejection, so it must not be retried as if transient), and `clicks` because it
    # is accepted but always None.
    threads_account_metrics: str = "views,likes,replies,reposts,quotes,followers_count"
    threads_demographic_breakdowns: str = "age,gender,city,country"

    # Historical backfill bounds. The first sync walks back until it hits EITHER limit —
    # whichever comes first — so a large account cannot turn its first run into an
    # unbounded crawl. The Liparoto IG account holds 988 media, so 2000 is headroom
    # rather than a real ceiling for a typical install.
    media_sync_max_age_days: int = 730
    media_sync_max_posts: int = 2000
    media_sync_page_size: int = 100          # Meta's per-page maximum
    # Once the backfill is done, each cycle re-walks this many posts off the top rather
    # than only looking for strictly-newer ones. That refresh is what catches edited
    # captions and deleted posts — without it the mirror drifts from reality and never
    # recovers. 200 is two pages: cheap enough to run every cycle.
    media_sync_refresh_posts: int = 200
    # Thumbnails are cached to local disk because Meta's CDN links expire (see
    # migration 0019). Bounded per cycle so a first sync of a large account spreads the
    # downloads out instead of fetching a thousand images in one go.
    thumbnail_max_per_cycle: int = 120

    # Account-insight history. Meta caps a SINGLE insights request at roughly 30 days, so
    # a longer history is walked in chunks of that size — hence two settings rather than
    # one. The full backfill runs only on a channel's first sync; afterwards each cycle
    # refreshes one recent window.
    account_backfill_days: int = 365
    account_series_window_days: int = 30

    # How often each job runs. Demographics move slowly and cost one call per
    # audience/breakdown pair (twelve on Instagram), so they get their own daily cadence
    # rather than riding the 6-hour cycle.
    insights_sync_interval_hours: int = 6
    demographics_sync_interval_hours: int = 24

    # Rate limiting. A backfill of ~1000 posts cannot run in one cycle, so each cycle
    # takes a bounded bite and stops. The usage ceiling is a percentage read from Meta's
    # own X-Business-Use-Case-Usage header (see GraphClient._record_usage) — when we are
    # past it, the job stops early and resumes next cycle rather than pushing into a
    # throttle that would also block publishing.
    insights_max_calls_per_cycle: int = 200
    insights_usage_pct_ceiling: int = 80

    # Threads versions its Graph API independently of the Instagram/Facebook epoch
    # (currently v1.0, vs graph_version's v25.0+), so it cannot share graph_version.
    # Configurable rather than hardcoded — same reasoning as threads_insight_metrics:
    # Meta can bump this without notice.
    threads_api_version: str = "v1.0"
    # Publish delivery: Meta downloads images from a public URL, so at publish time the
    # worker serves the local asset store on 127.0.0.1:<asset_port> and exposes it via a
    # short-lived tunnel. See docs/design-publish-delivery.md.
    asset_port: int = 8787
    cloudflared_path: str = "cloudflared"
    tunnel_provider: str = "cloudflared"
    tunnel_startup_timeout: int = 30
    # A fresh quick tunnel takes ~15-25s before its public URL is actually reachable.
    # We wait (best-effort) for it to go live before handing URLs to Meta, so the first
    # publish doesn't fail against a cold tunnel.
    tunnel_ready_timeout: int = 60
    # TikTok app credentials (per-install: each clone registers its OWN app — the audit,
    # the quotas and the terms all attach to the app, never to the person). The dashboard
    # runs the OAuth flow; the worker needs them too, to refresh the 24-hour access token.
    tiktok_client_key: str = ""
    tiktok_client_secret: str = ""
    # Time-of-day band clock times (channel-local, "HH:MM"). See docs/design-tag-taxonomy.md.
    # anytime/untagged posts use the channel's own cadence time instead of these.
    tod_morning: str = "09:00"
    tod_afternoon: str = "13:00"
    tod_evening: str = "18:00"

    @classmethod
    def from_env(cls) -> "Config":
        load_env()

        def path_of(env_key: str, default: str) -> Path:
            raw = os.environ.get(env_key, default)
            p = Path(raw)
            return p if p.is_absolute() else (REPO_ROOT / p)

        return cls(
            database_path=path_of("DATABASE_PATH", "data/socialscheduler.db"),
            asset_storage_dir=path_of("ASSET_STORAGE_DIR", "data/assets"),
            public_asset_base_url=os.environ.get("PUBLIC_ASSET_BASE_URL", ""),
            meta_app_id=os.environ.get("META_APP_ID", ""),
            meta_app_secret=os.environ.get("META_APP_SECRET", ""),
            graph_version=os.environ.get("META_GRAPH_VERSION", "v25.0"),
            # Instagram-Login path (recommended, no FB Page): https://graph.instagram.com
            # Facebook-Login / FB Pages path:                  https://graph.facebook.com
            graph_base=os.environ.get("META_GRAPH_BASE", "https://graph.facebook.com"),
            default_timezone=os.environ.get("DEFAULT_TIMEZONE", "UTC"),
            poll_interval=int(os.environ.get("WORKER_POLL_INTERVAL", "30")),
            publish_claim_lease_seconds=int(
                os.environ.get("PUBLISH_CLAIM_LEASE_SECONDS", "1800")
            ),
            metrics_max_age_days=int(os.environ.get("METRICS_MAX_AGE_DAYS", "30")),
            metrics_min_interval_hours=int(os.environ.get("METRICS_MIN_INTERVAL_HOURS", "6")),
            fb_post_insight_metrics=os.environ.get(
                "FB_POST_INSIGHT_METRICS", "post_total_media_view_unique"
            ),
            threads_insight_metrics=os.environ.get(
                "THREADS_INSIGHT_METRICS", "views,likes,replies,reposts,quotes"
            ),
            threads_api_version=os.environ.get("THREADS_API_VERSION", "v1.0"),
            tiktok_client_key=os.environ.get("TIKTOK_CLIENT_KEY", ""),
            tiktok_client_secret=os.environ.get("TIKTOK_CLIENT_SECRET", ""),
            ig_account_series_metrics=os.environ.get(
                "IG_ACCOUNT_SERIES_METRICS", cls.ig_account_series_metrics
            ),
            ig_account_total_metrics=os.environ.get(
                "IG_ACCOUNT_TOTAL_METRICS", cls.ig_account_total_metrics
            ),
            ig_demographic_metrics=os.environ.get(
                "IG_DEMOGRAPHIC_METRICS", cls.ig_demographic_metrics
            ),
            ig_demographic_breakdowns=os.environ.get(
                "IG_DEMOGRAPHIC_BREAKDOWNS", cls.ig_demographic_breakdowns
            ),
            threads_account_metrics=os.environ.get(
                "THREADS_ACCOUNT_METRICS", cls.threads_account_metrics
            ),
            threads_demographic_breakdowns=os.environ.get(
                "THREADS_DEMOGRAPHIC_BREAKDOWNS", cls.threads_demographic_breakdowns
            ),
            media_sync_max_age_days=int(os.environ.get("MEDIA_SYNC_MAX_AGE_DAYS", "730")),
            media_sync_max_posts=int(os.environ.get("MEDIA_SYNC_MAX_POSTS", "2000")),
            media_sync_page_size=int(os.environ.get("MEDIA_SYNC_PAGE_SIZE", "100")),
            media_sync_refresh_posts=int(os.environ.get("MEDIA_SYNC_REFRESH_POSTS", "200")),
            thumbnail_max_per_cycle=int(os.environ.get("THUMBNAIL_MAX_PER_CYCLE", "120")),
            account_backfill_days=int(os.environ.get("ACCOUNT_BACKFILL_DAYS", "365")),
            account_series_window_days=int(
                os.environ.get("ACCOUNT_SERIES_WINDOW_DAYS", "30")
            ),
            insights_sync_interval_hours=int(
                os.environ.get("INSIGHTS_SYNC_INTERVAL_HOURS", "6")
            ),
            demographics_sync_interval_hours=int(
                os.environ.get("DEMOGRAPHICS_SYNC_INTERVAL_HOURS", "24")
            ),
            insights_max_calls_per_cycle=int(
                os.environ.get("INSIGHTS_MAX_CALLS_PER_CYCLE", "200")
            ),
            insights_usage_pct_ceiling=int(os.environ.get("INSIGHTS_USAGE_PCT_CEILING", "80")),
            asset_port=int(os.environ.get("ASSET_PORT", "8787")),
            cloudflared_path=os.environ.get("CLOUDFLARED_PATH", "cloudflared"),
            tunnel_provider=os.environ.get("TUNNEL_PROVIDER", "cloudflared"),
            tunnel_startup_timeout=int(os.environ.get("TUNNEL_STARTUP_TIMEOUT", "30")),
            tunnel_ready_timeout=int(os.environ.get("TUNNEL_READY_TIMEOUT", "60")),
            reels_status_poll_interval=int(os.environ.get("REELS_STATUS_POLL_INTERVAL", "10")),
            reels_status_poll_max_tries=int(os.environ.get("REELS_STATUS_POLL_MAX_TRIES", "90")),
            tod_morning=os.environ.get("TOD_MORNING", "09:00"),
            tod_afternoon=os.environ.get("TOD_AFTERNOON", "13:00"),
            tod_evening=os.environ.get("TOD_EVENING", "18:00"),
        )
