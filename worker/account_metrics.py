"""Account-level metrics — the daily series behind the Insights hub's headline numbers.

Writes one row per channel per UTC day into account_metrics, upserted. Re-running the job
overwrites today's row rather than appending, so a double-run or a crash mid-cycle cannot
corrupt a series. See migrations/0018 for why the day grain is load-bearing.

Three sources feed one row, because Instagram splits them across three call shapes:

  * the account NODE      — followers_count, follows_count, media_count. Plain fields that
                            have never been renamed, which is why follower growth is read
                            here rather than from the volatile insights edge.
  * the SERIES envelope   — reach, follower_count. Accepts since/until and returns a value
                            per day in one call, which is what makes backfill affordable.
  * the TOTAL envelope    — views, profile_views, accounts_engaged and the rest. Requires
                            metric_type=total_value and returns ONE number for the window,
                            so a per-day history costs one call per day.

That asymmetry shapes the job: history is backfilled from the series envelope only, while
the totals are fetched for today and yesterday each cycle. Yesterday is refetched because
a cycle running at 06:00 UTC sees a partial day — without a second pass the row would keep
whatever the last run of that day happened to capture, silently under-reporting every day.

Read-only, so it runs under DRY_RUN like the other sync jobs.
"""

from __future__ import annotations

import json
from datetime import timedelta

from .clients import SUPPORTED_PLATFORMS
from .media_sync import CallBudget  # noqa: F401  (re-exported for callers)
from .redact import redact

# Insight/field name -> account_metrics column. Names absent here still land in raw_json,
# which is what it exists for: a metric with no column is recorded, not lost.
#
# `impressions` is deliberately unmapped: it now returns 400 in both envelopes (verified
# 2026-08-05, see reference.md) and must not be requested. The column stays for history.
COLUMN_MAP = {
    # account node fields
    "followers_count": "followers_count",
    "follows_count": "follows_count",
    "media_count": "media_count",
    # Instagram insights
    "reach": "reach",
    "views": "views",
    "profile_views": "profile_views",
    "accounts_engaged": "accounts_engaged",
    "total_interactions": "total_interactions",
    "likes": "likes",
    "comments": "comments",
    "saves": "saves",
    "shares": "shares",
    "replies": "replies",
    "website_clicks": "website_clicks",
    # Net new followers on that day. Named follower_count by Meta, which reads like a
    # total but is a delta — mapped to follows_gained so the column name cannot mislead.
    "follower_count": "follows_gained",
    # Threads. `reposts` is the closest thing Threads has to a share; `quotes` is
    # deliberately unmapped rather than folded in, for the same reason worker/metrics.py
    # keeps them apart — summing them would inflate a number that means something else.
    "reposts": "shares",
}

# Every column the upsert may write. The upsert builds SQL from this whitelist rather than
# from caller-supplied keys, so a metric name can never reach the statement as an
# identifier.
WRITABLE_COLUMNS = (
    "followers_count", "follows_count", "media_count", "reach", "impressions", "views",
    "profile_views", "accounts_engaged", "total_interactions", "likes", "comments",
    "saves", "shares", "replies", "website_clicks", "follows_gained",
)


def day_of(dt) -> str:
    return dt.strftime("%Y-%m-%d")


def _shift_day(day: str, days: int) -> str:
    """Date arithmetic on a 'YYYY-MM-DD' label, month and year boundaries included."""
    from datetime import datetime

    return (datetime.strptime(day, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def _split(raw: str) -> list[str]:
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def upsert_day(conn, channel_id: int, day: str, values: dict, raw: dict,
               fetched_at: str) -> None:
    """Merge one day's values into that day's row.

    COALESCE on every column, with the NEW value first: a later call in the same cycle
    contributing only some metrics must not blank the ones an earlier call already wrote.
    Without it, the totals pass would erase the series pass's reach every single cycle.
    """
    columns = [c for c in WRITABLE_COLUMNS if c in values]
    insert_cols = ", ".join(["channel_id", "day", "fetched_at", "raw_json", *columns])
    placeholders = ", ".join("?" for _ in range(len(columns) + 4))
    updates = ", ".join(
        f"{c} = COALESCE(excluded.{c}, account_metrics.{c})" for c in columns
    )
    # raw_json is REPLACED rather than merged: it is the payload of the most recent fetch,
    # and a half-merged JSON blob would be worse than either version alone.
    conn.execute(
        f"""
        INSERT INTO account_metrics ({insert_cols})
        VALUES ({placeholders})
        ON CONFLICT (channel_id, day) DO UPDATE SET
            fetched_at = excluded.fetched_at,
            raw_json   = excluded.raw_json
            {', ' + updates if updates else ''}
        """,
        (channel_id, day, fetched_at, json.dumps(raw), *(values[c] for c in columns)),
    )


def _to_columns(insights: dict) -> dict:
    """Map raw metric names onto columns, dropping unmapped ones (they stay in raw_json)."""
    out: dict = {}
    for name, value in insights.items():
        column = COLUMN_MAP.get(name)
        if column and value is not None:
            out[column] = value
    return out


def sync_instagram_account(conn, config, client, channel, now, budget, logger=None) -> dict:
    account_id, token = channel["remote_account_id"], channel["access_token"]
    fetched_at = now.isoformat()
    written: set[str] = set()
    raw_today: dict = {}

    # Whether this channel already has history MUST be read before anything is written,
    # or step 3's own insert makes the answer "yes" and the first run silently collapses
    # from a full backfill to a single recent window.
    has_history = conn.execute(
        "SELECT 1 FROM account_metrics WHERE channel_id = ? LIMIT 1", (channel["id"],)
    ).fetchone() is not None

    # 1. Series metrics. Meta caps a single insights request at ~30 days, so a longer
    #    history is walked in chunks. The full backfill runs only when this channel has no
    #    account history yet; afterwards one recent window per cycle is enough, since the
    #    upsert makes re-covering the same days free.
    series_metrics = _split(config.ig_account_series_metrics)
    span = config.account_series_window_days if has_history else config.account_backfill_days

    window_end = now
    covered = 0
    while series_metrics and covered < span:
        if budget.exhausted(client):
            break
        budget.spend()
        chunk = min(config.account_series_window_days, span - covered)
        window_start = window_end - timedelta(days=chunk)
        series = client.get_account_insights_series(
            account_id, token, series_metrics,
            since=window_start.strftime("%Y-%m-%d"), until=window_end.strftime("%Y-%m-%d"),
        )
        # Transpose {metric: [(end_time, value)]} into {day: {column: value}} — the series
        # arrives metric-major but the table is day-major.
        by_day: dict[str, dict] = {}
        for metric, points in series.items():
            column = COLUMN_MAP.get(metric)
            if not column:
                continue
            for end_time, value in points:
                if value is None:
                    continue
                day = _day_from_end_time(end_time)
                if day:
                    by_day.setdefault(day, {})[column] = value
        for day, columns in by_day.items():
            upsert_day(conn, channel["id"], day, columns, {"series": True}, fetched_at)
            written.add(day)
        # An empty window means Meta has no data that far back — walking further only
        # burns calls against a wall, so stop rather than finish the span.
        if not by_day:
            break
        window_end = window_start
        covered += chunk

    # 2. Which day is "today" ON THE ACCOUNT — not in UTC.
    #
    #    Meta buckets by the account's own local day, and the two disagree for a large
    #    part of every 24 hours: 01:00 UTC on Aug 6 is 18:00 Pacific on Aug 5. Labelling
    #    by UTC put the follower snapshot on tomorrow's row every evening, leaving the
    #    newest day looking empty and the real numbers stranded a day behind.
    #
    #    Rather than configure a timezone (channels.timezone is the POSTING timezone and
    #    need not match the account's), ask Meta: the newest series bucket IS the account's
    #    current local day. Self-calibrating, and correct for any offset.
    today = max(written) if written else day_of(now)
    yesterday = _shift_day(today, -1)

    # 3. Node fields — followers/follows/media counts.
    if not budget.exhausted(client):
        budget.spend()
        profile = client.get_account_profile(
            account_id, token, "followers_count,follows_count,media_count"
        )
        raw_today.update(profile)
        upsert_day(conn, channel["id"], today, _to_columns(profile), raw_today, fetched_at)
        written.add(today)

    # 4. Total-envelope metrics, one call per day, for today and yesterday.
    #
    #    `since=D until=D` returns {} — Meta needs a SPAN, so a single day is
    #    [D, D+1). Verified live 2026-08-05; the same-day form fails silently rather
    #    than erroring, which would have left every total column null forever.
    #
    #    Yesterday is refetched because a cycle running mid-morning sees a partial day.
    #    Without the second pass, each day would keep whatever its final run captured and
    #    every historical day would under-report.
    total_metrics = _split(config.ig_account_total_metrics)
    for day in (today, yesterday):
        if not total_metrics or budget.exhausted(client):
            break
        budget.spend()
        totals = client.get_account_insights_total(
            account_id, token, total_metrics, since=day, until=_shift_day(day, 1),
        )
        if day == today:
            raw_today.update(totals)
            upsert_day(conn, channel["id"], day, _to_columns(totals), raw_today, fetched_at)
        else:
            upsert_day(conn, channel["id"], day, _to_columns(totals), totals, fetched_at)
        written.add(day)

    return {"days": len(written)}


def _day_from_end_time(end_time: str | None) -> str | None:
    """Which calendar day a series point describes.

    Established empirically on 2026-08-05 by cross-checking the two envelopes against
    each other (see reference.md), because the field is named `end_time` but does not
    behave like one:

        series point end_time=2026-08-04T07:00:00Z  -> reach 157
        total since=2026-08-04 until=2026-08-05     -> reach 157   (same day)

    07:00Z is midnight Pacific for this account, so the stamp marks the START of its local
    day, not the close. Naming notwithstanding, the point describes the day its timestamp
    falls on — locally.

    Adding 12 hours before taking the UTC date is what makes that robust for any account
    timezone: it lands the reading in the middle of the local day, so neither a negative
    nor a positive UTC offset can push it across a date boundary. Taking the UTC date
    directly works for this account and silently breaks east of Greenwich.
    """
    from datetime import datetime

    from .media_sync import parse_meta_timestamp

    parsed = parse_meta_timestamp(end_time)
    if not parsed:
        return None
    return (datetime.fromisoformat(parsed) + timedelta(hours=12)).strftime("%Y-%m-%d")


def sync_threads_account(conn, config, client, channel, now, budget, logger=None) -> dict:
    """Threads has no node-fields call and no series envelope — one insights call carries
    everything, including followers_count. So there is no backfill path here at all: the
    series starts the day this install first runs, and the UI must not imply otherwise.
    """
    metrics = _split(config.threads_account_metrics)
    if not metrics or budget.exhausted(client):
        return {"days": 0}
    budget.spend()
    insights = client.get_threads_user_insights(
        channel["remote_account_id"], channel["access_token"], metrics
    )
    upsert_day(conn, channel["id"], day_of(now), _to_columns(insights), insights,
               now.isoformat())
    return {"days": 1}


def sync_demographics(conn, config, client, channel, now, budget, logger=None) -> dict:
    """Audience breakdowns. One call per (audience, breakdown) pair — twelve on Instagram,
    which is why this runs daily rather than every cycle.

    An empty result is a NORMAL state (Meta returns nothing below 100 followers), so it is
    recorded as "no buckets" rather than treated as a failure. The UI distinguishes the
    two by whether any row exists for that day.
    """
    day, fetched_at = day_of(now), now.isoformat()
    platform = channel["platform"]
    if platform == "instagram":
        pairs = [
            (metric, breakdown)
            for metric in _split(config.ig_demographic_metrics)
            for breakdown in _split(config.ig_demographic_breakdowns)
        ]
        fetch = lambda m, b: client.get_audience_demographics(  # noqa: E731
            channel["remote_account_id"], channel["access_token"], m, b
        )
    else:
        pairs = [
            ("follower_demographics", breakdown)
            for breakdown in _split(config.threads_demographic_breakdowns)
        ]
        fetch = lambda m, b: client.get_threads_audience_demographics(  # noqa: E731
            channel["remote_account_id"], channel["access_token"], b
        )

    written = 0
    for metric, breakdown in pairs:
        if budget.exhausted(client):
            break
        budget.spend()
        try:
            buckets = fetch(metric, breakdown)
        except Exception as exc:  # noqa: BLE001 — one bad breakdown must not lose the rest
            if logger:
                logger.info(
                    "[demographics ch %s] %s/%s failed: %s",
                    channel["id"], metric, breakdown, redact(str(exc)),
                )
            continue
        audience = _AUDIENCE_OF.get(metric, "followers")
        for dimension, value in buckets.items():
            conn.execute(
                """
                INSERT INTO audience_demographics
                    (channel_id, day, audience, breakdown, dimension, value)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (channel_id, day, audience, breakdown, dimension)
                DO UPDATE SET value = excluded.value
                """,
                (channel["id"], day, audience, breakdown, dimension, value),
            )
            written += 1
    conn.commit()
    return {"buckets": written}


# Which audience each demographic metric describes. Three metrics, three very different
# questions — who follows you, who saw you, who interacted.
_AUDIENCE_OF = {
    "follower_demographics": "followers",
    "reached_audience_demographics": "reached",
    "engaged_audience_demographics": "engaged",
}

_ACCOUNT_SYNCS = {
    "instagram": sync_instagram_account,
    "threads": sync_threads_account,
    "facebook": None,   # phase 5
    "discord": None,
    "telegram": None,
    # Account-level series need the user.info.stats scopes this install does not request —
    # it asks only for what publishing and per-post metrics require. Deliberately out of
    # scope, not forgotten.
    "tiktok": None,
}

assert set(_ACCOUNT_SYNCS) == set(SUPPORTED_PLATFORMS), (
    "account_metrics._ACCOUNT_SYNCS and clients.SUPPORTED_PLATFORMS disagree"
)


def _due(last: str | None, now, hours: int, forced: bool) -> bool:
    if forced or not last:
        return True
    return last <= (now - timedelta(hours=hours)).isoformat()


def run_account_metrics(conn, config, client=None, now=None, logger=None,
                        client_for=None) -> int:
    """Refresh account-level metrics and (daily) demographics. Returns channels synced."""
    pick_client = client_for or (lambda _platform: client)
    budget = CallBudget(config.insights_max_calls_per_cycle, config.insights_usage_pct_ceiling)
    rows = conn.execute("SELECT * FROM channels WHERE is_active = 1").fetchall()
    synced = 0

    for channel in rows:
        sync = _ACCOUNT_SYNCS.get(channel["platform"])
        if sync is None or not channel["access_token"] or not channel["remote_account_id"]:
            continue
        forced = bool(channel["insights_refresh_requested"])
        if not _due(channel["insights_synced_at"], now, config.insights_sync_interval_hours,
                    forced):
            continue

        client_obj = pick_client(channel["platform"])
        try:
            sync(conn, config, client_obj, channel, now, budget, logger=logger)
            # Demographics move slowly and cost twelve calls, so they keep their own,
            # slower clock rather than riding this one.
            demo_last = conn.execute(
                "SELECT MAX(day) AS d FROM audience_demographics WHERE channel_id = ?",
                (channel["id"],),
            ).fetchone()["d"]
            if forced or demo_last != day_of(now):
                sync_demographics(conn, config, client_obj, channel, now, budget,
                                  logger=logger)
            conn.execute(
                "UPDATE channels SET insights_synced_at = ?, insights_error = NULL, "
                "insights_refresh_requested = 0 WHERE id = ?",
                (now.isoformat(), channel["id"]),
            )
            conn.commit()
            synced += 1
        except Exception as exc:  # noqa: BLE001 — one bad channel must not stop the rest
            conn.rollback()
            message = redact(str(exc))
            conn.execute(
                "UPDATE channels SET insights_error = ? WHERE id = ?",
                (message[:500], channel["id"]),
            )
            conn.commit()
            if logger:
                logger.info("[account_metrics ch %s] failed: %s", channel["id"], message)

    if logger and synced:
        logger.info("[account_metrics] refreshed %d channel(s)", synced)
    return synced
