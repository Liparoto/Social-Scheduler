"""Account-level metrics: day alignment, backfill chunking, merge semantics.

The day-alignment tests are the important ones. Meta buckets by the ACCOUNT'S local day
and labels each bucket with a timestamp whose name (`end_time`) does not describe what it
holds; both of the natural readings are wrong, and both fail silently by shifting every
chart a day rather than raising. See reference.md for the live cross-check that settled it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from worker.account_metrics import (
    _day_from_end_time, _shift_day, run_account_metrics, sync_demographics,
    sync_instagram_account, upsert_day,
)
from worker.media_sync import CallBudget

# 01:00 UTC on Aug 6 is 18:00 Pacific on Aug 5 — inside the window where the UTC date and
# the account's local date disagree. Every test below runs at this moment on purpose.
NOW = datetime(2026, 8, 6, 1, 0, tzinfo=timezone.utc)
LOCAL_TODAY = "2026-08-05"


class FakeAccountClient:
    """Serves Instagram account reads and records what was asked for."""

    def __init__(self, *, series=None, totals=None, profile=None, demographics=None):
        self._series = series or {}
        self._totals = totals or {}
        self._profile = profile or {
            "followers_count": 13727, "follows_count": 880, "media_count": 988,
        }
        self._demographics = demographics or {}
        self.series_calls: list[tuple[str, str]] = []
        self.total_calls: list[tuple[str, str]] = []
        self.last_usage_pct = None
        self.retry_after_seconds = 0

    def get_account_profile(self, account_id, token, fields):
        return dict(self._profile)

    def get_account_insights_series(self, account_id, token, metrics, *, period="day",
                                    since=None, until=None):
        self.series_calls.append((since, until))
        return self._series.get((since, until), {})

    def get_account_insights_total(self, account_id, token, metrics, *, period="day",
                                   since=None, until=None):
        self.total_calls.append((since, until))
        return self._totals.get(since, {})

    def get_audience_demographics(self, account_id, token, metric, breakdown,
                                  *, timeframe="this_month"):
        return self._demographics.get((metric, breakdown), {})

    def get_threads_audience_demographics(self, user_id, token, breakdown):
        return self._demographics.get(("follower_demographics", breakdown), {})


def _channel(conn, platform="instagram"):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, remote_account_id, access_token) "
        "VALUES (?, 'Acct', 'acct1', 'tok')", (platform,),
    ).lastrowid
    conn.commit()
    return conn.execute("SELECT * FROM channels WHERE id=?", (cid,)).fetchone()


def _budget():
    return CallBudget(200, 80)


def _series_points(days_back: int, value_of):
    """Build a {(since, until): {metric: [(end_time, value)]}} map for one 30-day chunk."""
    points = []
    for offset in range(days_back):
        day = datetime(2026, 8, 5, tzinfo=timezone.utc) - timedelta(days=offset)
        # 07:00Z == midnight Pacific: the stamp marks the START of the local day.
        points.append((day.strftime("%Y-%m-%dT07:00:00+0000"), value_of(offset)))
    return points


# -- day labelling -------------------------------------------------------------------

def test_end_time_labels_the_day_it_falls_on_locally():
    """07:00Z is midnight Pacific, so this point describes Aug 4 — the day the total
    endpoint returns for since=2026-08-04&until=2026-08-05."""
    assert _day_from_end_time("2026-08-04T07:00:00+0000") == "2026-08-04"


def test_day_labelling_survives_an_eastern_utc_offset():
    """The midpoint reading is what makes this robust. Taking the UTC date directly is
    right for a Pacific account and silently wrong east of Greenwich: local midnight for
    Aug 5 in UTC+8 is Aug 4 at 16:00Z."""
    assert _day_from_end_time("2026-08-04T16:00:00+0000") == "2026-08-05"


def test_day_labelling_handles_utc_accounts():
    assert _day_from_end_time("2026-08-04T00:00:00+0000") == "2026-08-04"


def test_shift_day_crosses_month_and_year_boundaries():
    assert _shift_day("2026-08-31", 1) == "2026-09-01"
    assert _shift_day("2026-01-01", -1) == "2025-12-31"


# -- the account's local day, not UTC's ----------------------------------------------

def test_todays_row_uses_the_accounts_local_day_not_utc(conn, config):
    """At 01:00 UTC the UTC date is already Aug 6 while the account is still on Aug 5.
    Labelling by UTC strands the follower count on an otherwise-empty future row and
    leaves the newest real day looking blank."""
    channel = _channel(conn)
    config.account_backfill_days = 30
    client = FakeAccountClient(
        series={("2026-07-07", "2026-08-06"): {"reach": _series_points(30, lambda i: 100 - i)}},
        totals={LOCAL_TODAY: {"views": 186, "reach": 76}},
    )
    sync_instagram_account(conn, config, client, channel, NOW, _budget())
    conn.commit()

    row = conn.execute(
        "SELECT day, followers_count, reach, views FROM account_metrics "
        "WHERE channel_id=? ORDER BY day DESC LIMIT 1", (channel["id"],),
    ).fetchone()
    assert row["day"] == LOCAL_TODAY
    assert row["followers_count"] == 13727
    assert row["views"] == 186, "the follower snapshot and the day's metrics share a row"
    assert not conn.execute(
        "SELECT 1 FROM account_metrics WHERE channel_id=? AND day='2026-08-06'",
        (channel["id"],),
    ).fetchone(), "nothing may be written to a day the account has not reached"


def test_totals_are_requested_as_a_span_never_a_single_day(conn, config):
    """since=D&until=D returns {} rather than erroring, so this shape must be enforced by
    a test — the wrong form yields nulls forever and looks like a platform limitation."""
    channel = _channel(conn)
    config.account_backfill_days = 30
    client = FakeAccountClient(
        series={("2026-07-07", "2026-08-06"): {"reach": _series_points(30, lambda i: 1)}},
    )
    sync_instagram_account(conn, config, client, channel, NOW, _budget())

    assert client.total_calls, "totals must be requested at all"
    for since, until in client.total_calls:
        assert since != until, f"single-day span {since}..{until} returns empty"
        assert _shift_day(since, 1) == until


def test_totals_cover_today_and_yesterday(conn, config):
    """Yesterday is refetched because a mid-day cycle only ever sees a partial day."""
    channel = _channel(conn)
    config.account_backfill_days = 30
    client = FakeAccountClient(
        series={("2026-07-07", "2026-08-06"): {"reach": _series_points(30, lambda i: 1)}},
        totals={LOCAL_TODAY: {"views": 186}, "2026-08-04": {"views": 431}},
    )
    sync_instagram_account(conn, config, client, channel, NOW, _budget())
    conn.commit()

    rows = dict(conn.execute(
        "SELECT day, views FROM account_metrics WHERE channel_id=? AND views IS NOT NULL",
        (channel["id"],),
    ).fetchall())
    assert rows == {LOCAL_TODAY: 186, "2026-08-04": 431}


# -- backfill ------------------------------------------------------------------------

def test_first_run_backfills_in_chunks_and_later_runs_do_not(conn, config):
    """The history check must be read BEFORE anything is written: this job's own first
    insert would otherwise make the answer 'yes' and collapse the backfill to one window."""
    channel = _channel(conn)
    config.account_backfill_days = 90
    config.account_series_window_days = 30
    windows = {}
    for chunk in range(3):
        end = datetime(2026, 8, 6, 1, 0, tzinfo=timezone.utc) - timedelta(days=30 * chunk)
        start = end - timedelta(days=30)
        windows[(start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d"))] = {
            "reach": _series_points(30, lambda i: 5)
        }
    client = FakeAccountClient(series=windows)

    sync_instagram_account(conn, config, client, channel, NOW, _budget())
    conn.commit()
    assert len(client.series_calls) == 3, "a 90-day span must be walked in three chunks"

    channel = conn.execute("SELECT * FROM channels WHERE id=?", (channel["id"],)).fetchone()
    client2 = FakeAccountClient(series=windows)
    sync_instagram_account(conn, config, client2, channel, NOW, _budget())
    assert len(client2.series_calls) == 1, "with history present, one recent window is enough"


def test_chunks_abut_without_gap_or_overlap(conn, config):
    """The series returns points with end_time in [since, until), so a gap loses a day
    and an overlap wastes a call."""
    channel = _channel(conn)
    config.account_backfill_days = 60
    config.account_series_window_days = 30
    client = FakeAccountClient(series={})
    # Serve data for whatever is asked so the walk does not stop early.
    client.get_account_insights_series = lambda a, t, m, *, period="day", since=None, until=None: (
        client.series_calls.append((since, until)) or {"reach": _series_points(2, lambda i: 1)}
    )
    sync_instagram_account(conn, config, client, channel, NOW, _budget())

    calls = client.series_calls
    assert len(calls) == 2
    assert calls[0][0] == calls[1][1], "chunk 2 must end exactly where chunk 1 begins"


def test_an_empty_window_stops_the_walk(conn, config):
    """Meta having no data that far back means walking further only burns calls."""
    channel = _channel(conn)
    config.account_backfill_days = 300
    client = FakeAccountClient(series={})  # every window empty
    sync_instagram_account(conn, config, client, channel, NOW, _budget())
    assert len(client.series_calls) == 1


def test_backfill_stops_when_the_budget_runs_out(conn, config):
    channel = _channel(conn)
    config.account_backfill_days = 300
    client = FakeAccountClient(series={})
    client.get_account_insights_series = lambda a, t, m, *, period="day", since=None, until=None: (
        client.series_calls.append((since, until)) or {"reach": _series_points(2, lambda i: 1)}
    )
    sync_instagram_account(conn, config, client, channel, NOW, CallBudget(3, 80))
    assert len(client.series_calls) == 3


# -- merge semantics -----------------------------------------------------------------

def test_a_later_partial_write_does_not_blank_earlier_columns(conn, config):
    """Three calls contribute to one row. Without COALESCE the totals pass would erase
    the reach the series pass just wrote, every single cycle."""
    channel = _channel(conn)
    upsert_day(conn, channel["id"], LOCAL_TODAY, {"reach": 100}, {}, "T1")
    upsert_day(conn, channel["id"], LOCAL_TODAY, {"views": 500}, {}, "T2")
    conn.commit()

    row = conn.execute(
        "SELECT reach, views FROM account_metrics WHERE channel_id=? AND day=?",
        (channel["id"], LOCAL_TODAY),
    ).fetchone()
    assert row["reach"] == 100 and row["views"] == 500


def test_a_new_value_overwrites_the_old_one(conn, config):
    channel = _channel(conn)
    upsert_day(conn, channel["id"], LOCAL_TODAY, {"reach": 100}, {}, "T1")
    upsert_day(conn, channel["id"], LOCAL_TODAY, {"reach": 157}, {}, "T2")
    conn.commit()
    assert conn.execute(
        "SELECT reach FROM account_metrics WHERE channel_id=?", (channel["id"],)
    ).fetchone()["reach"] == 157


def test_unmapped_metrics_survive_in_raw_json(conn, config):
    """A metric with no column is recorded, not lost — that is what raw_json is for."""
    channel = _channel(conn)
    config.account_backfill_days = 30
    client = FakeAccountClient(
        series={("2026-07-07", "2026-08-06"): {"reach": _series_points(1, lambda i: 9)}},
        totals={LOCAL_TODAY: {"profile_links_taps": 7}},
    )
    sync_instagram_account(conn, config, client, channel, NOW, _budget())
    conn.commit()
    raw = conn.execute(
        "SELECT raw_json FROM account_metrics WHERE channel_id=? AND day=?",
        (channel["id"], LOCAL_TODAY),
    ).fetchone()["raw_json"]
    assert "profile_links_taps" in raw


# -- demographics --------------------------------------------------------------------

def test_demographics_are_stored_per_audience_and_breakdown(conn, config):
    channel = _channel(conn)
    config.ig_demographic_metrics = "follower_demographics,reached_audience_demographics"
    config.ig_demographic_breakdowns = "age,gender"
    client = FakeAccountClient(demographics={
        ("follower_demographics", "age"): {"25-34": 4199, "35-44": 3427},
        ("follower_demographics", "gender"): {"F": 8552, "M": 864},
        ("reached_audience_demographics", "age"): {"25-34": 302},
        ("reached_audience_demographics", "gender"): {"F": 506},
    })
    sync_demographics(conn, config, client, channel, NOW, _budget())

    rows = conn.execute(
        "SELECT audience, breakdown, dimension, value FROM audience_demographics "
        "WHERE channel_id=? ORDER BY audience, breakdown, dimension", (channel["id"],),
    ).fetchall()
    assert len(rows) == 6
    assert ("followers", "age", "25-34", 4199) == tuple(rows[0])
    assert {r["audience"] for r in rows} == {"followers", "reached"}


def test_an_empty_demographic_result_is_not_an_error(conn, config):
    """Meta returns nothing below 100 followers. Normal state, recorded as no buckets."""
    channel = _channel(conn)
    config.ig_demographic_metrics = "follower_demographics"
    config.ig_demographic_breakdowns = "age"
    result = sync_demographics(conn, config, FakeAccountClient(demographics={}),
                               channel, NOW, _budget())
    assert result["buckets"] == 0


def test_one_failing_breakdown_does_not_lose_the_others(conn, config):
    channel = _channel(conn)
    config.ig_demographic_metrics = "follower_demographics"
    config.ig_demographic_breakdowns = "age,gender"
    client = FakeAccountClient(demographics={("follower_demographics", "gender"): {"F": 10}})
    original = client.get_audience_demographics

    def flaky(account_id, token, metric, breakdown, *, timeframe="this_month"):
        if breakdown == "age":
            raise RuntimeError("boom")
        return original(account_id, token, metric, breakdown, timeframe=timeframe)

    client.get_audience_demographics = flaky
    result = sync_demographics(conn, config, client, channel, NOW, _budget())
    assert result["buckets"] == 1


def test_demographics_re_run_updates_rather_than_duplicates(conn, config):
    channel = _channel(conn)
    config.ig_demographic_metrics = "follower_demographics"
    config.ig_demographic_breakdowns = "age"
    for value in (100, 150):
        sync_demographics(
            conn, config,
            FakeAccountClient(demographics={("follower_demographics", "age"): {"25-34": value}}),
            channel, NOW, _budget(),
        )
    rows = conn.execute(
        "SELECT value FROM audience_demographics WHERE channel_id=?", (channel["id"],)
    ).fetchall()
    assert len(rows) == 1 and rows[0]["value"] == 150


# -- the driver ----------------------------------------------------------------------

def test_platforms_without_account_insights_are_skipped(conn, config):
    for platform in ("discord", "telegram", "facebook"):
        _channel(conn, platform)
    assert run_account_metrics(conn, config, now=NOW,
                               client_for=lambda p: FakeAccountClient()) == 0


def test_one_failing_channel_does_not_stop_the_others(conn, config):
    good = _channel(conn, "instagram")
    bad = _channel(conn, "threads")

    def client_for(platform):
        client = FakeAccountClient(
            series={}, totals={LOCAL_TODAY: {"views": 1}},
        )
        if platform == "threads":
            def boom(*a, **kw):
                raise RuntimeError("bad token access_token=SECRET")
            client.get_threads_user_insights = boom
        return client

    assert run_account_metrics(conn, config, now=NOW, client_for=client_for) == 1
    error = conn.execute(
        "SELECT insights_error FROM channels WHERE id=?", (bad["id"],)
    ).fetchone()["insights_error"]
    assert error and "SECRET" not in error, "a stored error must never carry the token"
    assert conn.execute(
        "SELECT insights_error FROM channels WHERE id=?", (good["id"],)
    ).fetchone()["insights_error"] is None


def test_a_manual_refresh_clears_its_own_flag(conn, config):
    channel = _channel(conn)
    conn.execute("UPDATE channels SET insights_refresh_requested = 1 WHERE id=?",
                 (channel["id"],))
    conn.commit()
    run_account_metrics(conn, config, now=NOW, client_for=lambda p: FakeAccountClient())
    row = conn.execute(
        "SELECT insights_refresh_requested, insights_synced_at FROM channels WHERE id=?",
        (channel["id"],),
    ).fetchone()
    assert row["insights_refresh_requested"] == 0, "an uncleared flag re-syncs forever"
    assert row["insights_synced_at"] is not None


def test_a_synced_channel_waits_for_its_interval(conn, config):
    _channel(conn)
    assert run_account_metrics(conn, config, now=NOW,
                               client_for=lambda p: FakeAccountClient()) == 1
    assert run_account_metrics(conn, config, now=NOW,
                               client_for=lambda p: FakeAccountClient()) == 0
    later = NOW + timedelta(hours=config.insights_sync_interval_hours + 1)
    assert run_account_metrics(conn, config, now=later,
                               client_for=lambda p: FakeAccountClient()) == 1


def test_a_failing_sync_clears_the_refresh_flag_rather_than_wedging_it(conn, config):
    """A channel whose sync always fails (a revoked scope, for instance) must not stay
    flagged forever — the dashboard would read 'Queued, picked up next cycle' permanently
    while the actual error sat in the line next to it. One attempt per click; asking again
    is the reader's decision. Mirrors the rule avatars.py already follows."""
    from datetime import datetime, timezone

    from worker.account_metrics import run_account_metrics

    conn.execute(
        "INSERT INTO channels (platform, account_name, timezone, remote_account_id, "
        "access_token, insights_refresh_requested) "
        "VALUES ('instagram', 'ig', 'UTC', 'IG1', 'tok', 1)"
    )
    conn.commit()
    cid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    class Boom:
        """Fails on whatever the sync reaches for. WHICH call breaks is not the point —
        the contract is that any failure records an error and releases the flag."""

        def __getattr__(self, name):
            def _raise(*a, **kw):
                raise RuntimeError("scope_not_authorized")
            return _raise

    run_account_metrics(conn, config, Boom(), datetime(2026, 8, 23, tzinfo=timezone.utc))

    row = conn.execute(
        "SELECT insights_refresh_requested, insights_error FROM channels WHERE id = ?",
        (cid,),
    ).fetchone()
    assert row["insights_refresh_requested"] == 0, "the queued flag wedged on failure"
    # An error is recorded, so the dashboard shows a reason rather than a silent "Queued".
    assert row["insights_error"], "a failure left no explanation behind"
