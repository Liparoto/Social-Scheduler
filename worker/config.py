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


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def load_env(override: bool = False) -> None:
    """Load KEY=VALUE pairs from the repo-root .env into os.environ.

    Minimal, stdlib-only (mirrors migrate.py) so the worker has no hard dependency
    on python-dotenv just to read a flag. With override=True, .env wins over the
    current environment — used each loop so live edits to the switches take effect.
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
    # Metrics fetching: only refresh posts published within this window, and no more
    # often than this interval per publication (keeps API usage sane).
    metrics_max_age_days: int = 30
    metrics_min_interval_hours: int = 6
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
            metrics_max_age_days=int(os.environ.get("METRICS_MAX_AGE_DAYS", "30")),
            metrics_min_interval_hours=int(os.environ.get("METRICS_MIN_INTERVAL_HOURS", "6")),
            asset_port=int(os.environ.get("ASSET_PORT", "8787")),
            cloudflared_path=os.environ.get("CLOUDFLARED_PATH", "cloudflared"),
            tunnel_provider=os.environ.get("TUNNEL_PROVIDER", "cloudflared"),
            tunnel_startup_timeout=int(os.environ.get("TUNNEL_STARTUP_TIMEOUT", "30")),
            tunnel_ready_timeout=int(os.environ.get("TUNNEL_READY_TIMEOUT", "60")),
            tod_morning=os.environ.get("TOD_MORNING", "09:00"),
            tod_afternoon=os.environ.get("TOD_AFTERNOON", "13:00"),
            tod_evening=os.environ.get("TOD_EVENING", "18:00"),
        )
