"""Probe: discover which account-insight metric names this account actually supports.

Meta renames and retires insight metric names without warning — a large batch went on
2026-06-15 — and their docs lag reality. Every other approach to this problem (trusting
docs, trusting a model's memory, copying a blog post) produces a hub that silently reports
nulls. So we ask the live account instead.

Each candidate name is tested in ITS OWN request. That is deliberately wasteful: asking
for twenty metrics at once means one bad name returns HTTP 400 for the whole call and
tells you nothing about the other nineteen. One name per call is the only way to learn
which specific ones work.

Read-only. Publishes nothing, writes nothing to the database, prints no tokens. Safe to
run against a live account at any time — but it is a MANUAL diagnostic, not part of the
worker loop, precisely because of the call volume.

    python3 -m worker.insights_probe              # probe every active channel
    python3 -m worker.insights_probe --channel 1  # probe just channel #1

The final section prints the .env lines to copy.
"""

from __future__ import annotations

import sys
import time

from . import db
from .clients import ClientRegistry
from .config import Config
from .graph_api import GraphAPIError
from .redact import redact

# Candidate Instagram account metrics, split by which response envelope they use. A name
# in the wrong list fails as surely as a retired one, which is itself useful output.
IG_SERIES_CANDIDATES = [
    "reach", "impressions", "profile_views", "follower_count",
    "website_clicks", "email_contacts", "get_directions_clicks",
    "phone_call_clicks", "text_message_clicks",
]
IG_TOTAL_CANDIDATES = [
    "reach", "views", "impressions", "profile_views", "accounts_engaged",
    "total_interactions", "likes", "comments", "saves", "shares", "replies",
    "follows_and_unfollows", "website_clicks", "profile_links_taps",
]
IG_DEMOGRAPHIC_METRICS = [
    "follower_demographics", "engaged_audience_demographics",
    "reached_audience_demographics",
]
IG_BREAKDOWNS = ["age", "gender", "city", "country"]

THREADS_CANDIDATES = [
    "views", "likes", "replies", "reposts", "quotes", "followers_count",
    "clicks", "shares",
]
THREADS_BREAKDOWNS = ["country", "city", "age", "gender"]

# Between probe calls. Small, but a probe fires dozens of requests back-to-back and
# there is no reason to be the reason a real publish gets throttled.
PROBE_DELAY_SECONDS = 0.3


class ProbeResult:
    """What one channel's probe learned. Collected rather than printed inline so the
    summary can print copy-paste .env lines after all channels are done."""

    def __init__(self, channel_id: int, label: str, platform: str) -> None:
        self.channel_id = channel_id
        self.label = label
        self.platform = platform
        self.media_ok = False
        self.media_count: int | None = None
        self.profile: dict = {}
        self.series_ok: list[str] = []
        self.total_ok: list[str] = []
        self.demographics_ok: list[str] = []
        self.demographics_empty: list[str] = []
        self.fatal: str | None = None


def _try(label: str, fn, print_fn) -> tuple[bool, object]:
    """Run one probe call. Returns (ok, value_or_error_text).

    Every exception is caught, not just GraphAPIError: the whole point of a probe is to
    keep going and report, so a surprise from the HTTP layer must not end the run.
    """
    time.sleep(PROBE_DELAY_SECONDS)
    try:
        return True, fn()
    except GraphAPIError as exc:
        return False, redact(str(exc))
    except Exception as exc:  # noqa: BLE001 — a probe reports failures, it doesn't raise
        return False, redact(str(exc))


def _short(error: str, limit: int = 110) -> str:
    """Meta's 400 bodies are long and mostly boilerplate; the useful part is the front."""
    flat = " ".join(str(error).split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def probe_instagram(client, ch, result: ProbeResult, print_fn) -> None:
    account_id, token = ch["remote_account_id"], ch["access_token"]

    print_fn("  media list:")
    ok, value = _try("media", lambda: client.get_user_media(account_id, token, limit=1), print_fn)
    if ok:
        items, next_url = value
        result.media_ok = True
        print_fn(f"    ✓ /media reachable ({'has more pages' if next_url else 'single page'})")
        if items:
            sample = items[0]
            print_fn(
                f"      sample: {sample.get('media_type')}"
                f"/{sample.get('media_product_type')} @ {sample.get('timestamp')}"
            )
    else:
        print_fn(f"    ✗ /media FAILED — {_short(value)}")
        print_fn("      (the hub cannot be account-wide without this — check the token's scopes)")

    print_fn("  profile fields:")
    ok, value = _try(
        "profile",
        lambda: client.get_account_profile(
            account_id, token, "username,followers_count,follows_count,media_count"
        ),
        print_fn,
    )
    if ok:
        result.profile = value
        print_fn(
            f"    ✓ followers={value.get('followers_count')} "
            f"follows={value.get('follows_count')} media={value.get('media_count')}"
        )
        result.media_count = value.get("media_count")
    else:
        print_fn(f"    ✗ profile fields FAILED — {_short(value)}")

    print_fn("  account insights — per-day series (period=day):")
    for metric in IG_SERIES_CANDIDATES:
        ok, value = _try(
            metric,
            lambda m=metric: client.get_account_insights_series(account_id, token, [m]),
            print_fn,
        )
        if ok and value:
            points = value.get(metric) or []
            result.series_ok.append(metric)
            latest = points[-1][1] if points else None
            print_fn(f"    ✓ {metric:<24} {len(points)} day(s), latest={latest}")
        elif ok:
            print_fn(f"    · {metric:<24} accepted but returned no data")
        else:
            print_fn(f"    ✗ {metric:<24} {_short(value, 70)}")

    print_fn("  account insights — totals (metric_type=total_value):")
    for metric in IG_TOTAL_CANDIDATES:
        ok, value = _try(
            metric,
            lambda m=metric: client.get_account_insights_total(account_id, token, [m]),
            print_fn,
        )
        if ok and value:
            result.total_ok.append(metric)
            print_fn(f"    ✓ {metric:<24} = {value.get(metric)}")
        elif ok:
            print_fn(f"    · {metric:<24} accepted but returned no data")
        else:
            print_fn(f"    ✗ {metric:<24} {_short(value, 70)}")

    print_fn("  audience demographics:")
    for metric in IG_DEMOGRAPHIC_METRICS:
        for breakdown in IG_BREAKDOWNS:
            ok, value = _try(
                f"{metric}/{breakdown}",
                lambda m=metric, b=breakdown: client.get_audience_demographics(
                    account_id, token, m, b
                ),
                print_fn,
            )
            name = f"{metric}/{breakdown}"
            if ok and value:
                result.demographics_ok.append(name)
                top = sorted(value.items(), key=lambda kv: kv[1], reverse=True)[:3]
                preview = ", ".join(f"{k}={v}" for k, v in top)
                print_fn(f"    ✓ {name:<44} {len(value)} bucket(s): {preview}")
            elif ok:
                # Meta returns an empty set below 100 followers. Normal, not an error.
                result.demographics_empty.append(name)
                print_fn(f"    · {name:<44} empty (needs 100+ followers)")
            else:
                print_fn(f"    ✗ {name:<44} {_short(value, 50)}")


def probe_threads(client, ch, result: ProbeResult, print_fn) -> None:
    user_id, token = ch["remote_account_id"], ch["access_token"]

    print_fn("  media list:")
    ok, value = _try(
        "threads", lambda: client.get_threads_user_media(user_id, token, limit=1), print_fn
    )
    if ok:
        items, next_url = value
        result.media_ok = True
        print_fn(f"    ✓ /threads reachable ({'has more pages' if next_url else 'single page'})")
        if items:
            print_fn(f"      sample: {items[0].get('media_type')} @ {items[0].get('timestamp')}")
    else:
        print_fn(f"    ✗ /threads FAILED — {_short(value)}")

    print_fn("  account insights:")
    for metric in THREADS_CANDIDATES:
        ok, value = _try(
            metric,
            lambda m=metric: client.get_threads_user_insights(user_id, token, [m]),
            print_fn,
        )
        if ok and value:
            result.total_ok.append(metric)
            print_fn(f"    ✓ {metric:<24} = {value.get(metric)}")
        elif ok:
            print_fn(f"    · {metric:<24} accepted but returned no data")
        else:
            print_fn(f"    ✗ {metric:<24} {_short(value, 70)}")

    print_fn("  audience demographics:")
    for breakdown in THREADS_BREAKDOWNS:
        ok, value = _try(
            breakdown,
            lambda b=breakdown: client.get_threads_audience_demographics(user_id, token, b),
            print_fn,
        )
        if ok and value:
            result.demographics_ok.append(f"follower_demographics/{breakdown}")
            top = sorted(value.items(), key=lambda kv: kv[1], reverse=True)[:3]
            print_fn(
                f"    ✓ follower_demographics/{breakdown:<10} "
                f"{len(value)} bucket(s): {', '.join(f'{k}={v}' for k, v in top)}"
            )
        elif ok:
            result.demographics_empty.append(f"follower_demographics/{breakdown}")
            print_fn(f"    · follower_demographics/{breakdown:<10} empty (needs 100+ followers)")
        else:
            print_fn(f"    ✗ follower_demographics/{breakdown:<10} {_short(value, 50)}")


# Platforms with no insights endpoint at all are reported as such rather than probed —
# the same distinction metrics._FETCHERS makes with an explicit None.
_PROBES = {
    "instagram": probe_instagram,
    "threads": probe_threads,
    "facebook": None,   # Page insights land in phase 5; names are volatile enough to need
                        # their own probe rather than a guess bolted onto this one.
    "discord": None,
    "telegram": None,
}


def probe_channels(rows, registry: ClientRegistry, *, print_fn=print) -> list[ProbeResult]:
    """Probe every channel row. Split out from main() so tests can drive it against a
    fake registry — the same shape preflight.check_channels uses."""
    results: list[ProbeResult] = []
    for ch in rows:
        label = f"#{ch['id']} {ch['account_name']} ({ch['platform']})"
        result = ProbeResult(ch["id"], ch["account_name"], ch["platform"])
        results.append(result)
        print_fn(f"\n{label}")

        if not ch["access_token"] or not ch["remote_account_id"]:
            result.fatal = "missing credentials"
            print_fn("  ✗ no access token or account id set — configure it in the dashboard")
            continue
        probe = _PROBES.get(ch["platform"])
        if probe is None:
            result.fatal = "no insights endpoint"
            print_fn(f"  · platform '{ch['platform']}' has no account-insights endpoint — skipped")
            continue
        try:
            probe(registry.for_platform(ch["platform"]), ch, result, print_fn)
        except Exception as exc:  # noqa: BLE001
            result.fatal = redact(str(exc))
            print_fn(f"  ✗ probe aborted: {_short(result.fatal)}")
    return results


def print_summary(results: list[ProbeResult], *, print_fn=print) -> None:
    print_fn("\n" + "=" * 78)
    print_fn("SUMMARY — copy these into .env")
    print_fn("=" * 78)

    ig = [r for r in results if r.platform == "instagram" and not r.fatal]
    threads = [r for r in results if r.platform == "threads" and not r.fatal]

    if ig:
        # Intersection, not union: a metric that works on one account but not another
        # would fail every cycle on the account that lacks it. The shared set is the only
        # one safe to configure install-wide.
        series = set(ig[0].series_ok)
        totals = set(ig[0].total_ok)
        demos = set(ig[0].demographics_ok)
        for r in ig[1:]:
            series &= set(r.series_ok)
            totals &= set(r.total_ok)
            demos &= set(r.demographics_ok)
        # demographics_ok holds "metric/breakdown" pairs; config wants the two axes
        # separately, so split them back apart rather than making the operator do it.
        demo_metrics = sorted({d.split("/")[0] for d in demos})
        demo_breakdowns = sorted({d.split("/")[1] for d in demos if "/" in d})
        print_fn(f"\n# Instagram — worked on all {len(ig)} IG channel(s)")
        print_fn(f"IG_ACCOUNT_SERIES_METRICS={','.join(sorted(series)) or '(none worked)'}")
        print_fn(f"IG_ACCOUNT_TOTAL_METRICS={','.join(sorted(totals)) or '(none worked)'}")
        print_fn(f"IG_DEMOGRAPHIC_METRICS={','.join(demo_metrics) or '(none worked)'}")
        print_fn(f"IG_DEMOGRAPHIC_BREAKDOWNS={','.join(demo_breakdowns) or '(none worked)'}")
        for r in ig:
            extra_s = set(r.series_ok) - series
            extra_t = set(r.total_ok) - totals
            if extra_s or extra_t:
                print_fn(
                    f"#   note: {r.label} also supports "
                    f"{','.join(sorted(extra_s | extra_t))} — not shared by all channels"
                )

    if threads:
        totals = set(threads[0].total_ok)
        demos = set(threads[0].demographics_ok)
        for r in threads[1:]:
            totals &= set(r.total_ok)
            demos &= set(r.demographics_ok)
        demo_breakdowns = sorted({d.split("/")[1] for d in demos if "/" in d})
        print_fn(f"\n# Threads — worked on all {len(threads)} Threads channel(s)")
        print_fn(f"THREADS_ACCOUNT_METRICS={','.join(sorted(totals)) or '(none worked)'}")
        print_fn(f"THREADS_DEMOGRAPHIC_BREAKDOWNS={','.join(demo_breakdowns) or '(none worked)'}")

    blocked = [r for r in results if r.fatal]
    if blocked:
        print_fn("\n# Skipped or failed")
        for r in blocked:
            print_fn(f"#   #{r.channel_id} {r.label} ({r.platform}): {r.fatal}")

    if not ig and not threads:
        print_fn("\n(No channel produced usable results — nothing to configure yet.)")


def main() -> int:
    config = Config.from_env()
    conn = db.connect(config.database_path)
    registry = ClientRegistry(config)

    channel_id = None
    if "--channel" in sys.argv:
        try:
            channel_id = int(sys.argv[sys.argv.index("--channel") + 1])
        except (IndexError, ValueError):
            print("Usage: python3 -m worker.insights_probe [--channel <id>]", file=sys.stderr)
            return 2

    if channel_id is not None:
        rows = conn.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM channels WHERE is_active = 1").fetchall()

    if not rows:
        print("No channels to probe. Add one in the dashboard first.")
        return 0

    print(f"Graph API {config.graph_version} — probing {len(rows)} channel(s).")
    print("Read-only: nothing is published and nothing is written to the database.")

    results = probe_channels(rows, registry)
    print_summary(results)
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
