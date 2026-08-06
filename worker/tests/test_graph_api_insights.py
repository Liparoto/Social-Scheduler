"""Account-level Graph reads: pagination, the two insight envelopes, breakdown
flattening, and rate-limit header capture.

These parse real Meta response shapes. The envelopes are the fiddly part — Meta uses
`values[]` for windowed metrics and `total_value{}` for newer ones, and a parser that
assumes either shape silently returns nothing for half the metric set.
"""

from __future__ import annotations

import json

from worker.graph_api import GraphClient


class FakeResponse:
    def __init__(self, payload, *, status=200, headers=None):
        self._payload = payload
        self.status_code = status
        self.ok = 200 <= status < 300
        self.headers = headers or {}
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class FakeSession:
    """Records every GET and replays queued payloads in order."""

    def __init__(self, payloads):
        self._payloads = list(payloads)
        self.calls: list[tuple[str, dict]] = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params or {}))
        payload = self._payloads.pop(0)
        return payload if isinstance(payload, FakeResponse) else FakeResponse(payload)


def _client(payloads):
    session = FakeSession(payloads)
    return GraphClient("v25.0", session=session), session


# -- media listing -------------------------------------------------------------------

def test_get_user_media_returns_items_and_next_cursor():
    client, session = _client([
        {
            "data": [{"id": "1", "media_type": "IMAGE", "timestamp": "2026-08-01T00:00:00+0000"}],
            "paging": {"next": "https://graph.facebook.com/next-page"},
        }
    ])
    items, next_url = client.get_user_media("ig1", "tok")
    assert [i["id"] for i in items] == ["1"]
    assert next_url == "https://graph.facebook.com/next-page"
    _, params = session.calls[0]
    assert params["limit"] == 100
    assert "media_product_type" in params["fields"], (
        "media_product_type is what separates a Reel from a Story from a feed post"
    )


def test_get_user_media_last_page_has_no_next():
    client, _ = _client([{"data": [{"id": "9"}]}])
    items, next_url = client.get_user_media("ig1", "tok")
    assert len(items) == 1 and next_url is None


def test_get_user_media_follows_next_url_verbatim():
    """The paging URL already encodes fields/limit/cursor/token. Rebuilding it from
    cursors is how a paginated crawl silently starts returning different fields."""
    client, session = _client([{"data": [{"id": "2"}], "paging": {}}])
    client.get_user_media("ig1", "tok", next_url="https://graph.facebook.com/page2?after=X")
    url, params = session.calls[0]
    assert url == "https://graph.facebook.com/page2?after=X"
    assert params == {}, "the next URL must not be re-parameterised"


def test_get_user_media_empty_account():
    client, _ = _client([{"data": []}])
    items, next_url = client.get_user_media("ig1", "tok")
    assert items == [] and next_url is None


# -- insight envelopes ---------------------------------------------------------------

def test_series_insights_parse_per_day_values():
    client, session = _client([
        {"data": [{"name": "reach", "period": "day", "values": [
            {"end_time": "2026-08-01T07:00:00+0000", "value": 120},
            {"end_time": "2026-08-02T07:00:00+0000", "value": 95},
        ]}]}
    ])
    out = client.get_account_insights_series(
        "ig1", "tok", ["reach"], since="2026-08-01", until="2026-08-02"
    )
    assert out["reach"] == [
        ("2026-08-01T07:00:00+0000", 120),
        ("2026-08-02T07:00:00+0000", 95),
    ]
    _, params = session.calls[0]
    assert params["period"] == "day"
    assert "metric_type" not in params, "the series envelope must NOT request total_value"


def test_total_insights_request_metric_type_and_parse_total_value():
    client, session = _client([
        {"data": [{"name": "accounts_engaged", "total_value": {"value": 42}}]}
    ])
    out = client.get_account_insights_total("ig1", "tok", ["accounts_engaged"])
    assert out == {"accounts_engaged": 42}
    _, params = session.calls[0]
    assert params["metric_type"] == "total_value", (
        "Meta rejects these metrics outright when metric_type is missing"
    )


def test_total_insights_missing_total_value_yields_none_not_zero():
    """A metric Meta accepted but did not populate is unknown, not zero."""
    client, _ = _client([{"data": [{"name": "views"}]}])
    assert client.get_account_insights_total("ig1", "tok", ["views"]) == {"views": None}


def test_series_insights_skip_values_without_end_time():
    client, _ = _client([
        {"data": [{"name": "reach", "values": [{"value": 5}, {"end_time": "T", "value": 7}]}]}
    ])
    assert client.get_account_insights_series("ig1", "tok", ["reach"]) == {"reach": [("T", 7)]}


# -- demographics --------------------------------------------------------------------

def test_breakdown_flattens_meta_nested_envelope():
    client, session = _client([
        {"data": [{"name": "follower_demographics", "total_value": {"breakdowns": [
            {"dimension_keys": ["age"], "results": [
                {"dimension_values": ["25-34"], "value": 412},
                {"dimension_values": ["35-44"], "value": 380},
            ]}
        ]}}]}
    ])
    out = client.get_audience_demographics("ig1", "tok", "follower_demographics", "age")
    assert out == {"25-34": 412, "35-44": 380}
    _, params = session.calls[0]
    assert params["breakdown"] == "age" and params["period"] == "lifetime"


def test_breakdown_joins_compound_dimensions():
    """A compound breakdown returns two dimension values per result; both must survive
    into the key or every age bucket collapses onto the last gender seen."""
    client, _ = _client([
        {"data": [{"total_value": {"breakdowns": [{"results": [
            {"dimension_values": ["25-34", "F"], "value": 200},
            {"dimension_values": ["25-34", "M"], "value": 150},
        ]}]}}]}
    ])
    out = client.get_audience_demographics("ig1", "tok", "follower_demographics", "age,gender")
    assert out == {"25-34 · F": 200, "25-34 · M": 150}


def test_breakdown_empty_for_small_accounts_is_not_an_error():
    """Under 100 followers Meta returns an empty envelope. That is a normal state the
    caller renders as 'not enough followers', so it must not raise."""
    client, _ = _client([{"data": [{"total_value": {"breakdowns": []}}]}])
    assert client.get_audience_demographics("ig1", "tok", "follower_demographics", "age") == {}


# -- Threads -------------------------------------------------------------------------

def test_threads_user_insights_reuse_the_two_envelope_parser():
    client, session = _client([
        {"data": [
            {"name": "views", "values": [{"value": 900}]},
            {"name": "followers_count", "total_value": {"value": 51}},
        ]}
    ])
    out = client.get_threads_user_insights("th1", "tok", ["views", "followers_count"])
    assert out == {"views": 900, "followers_count": 51}
    url, _ = session.calls[0]
    assert url.endswith("/th1/threads_insights"), "Threads uses its own edge name"


def test_threads_media_uses_the_threads_edge():
    client, session = _client([{"data": [{"id": "t1"}], "paging": {"next": "u"}}])
    items, next_url = client.get_threads_user_media("th1", "tok")
    url, params = session.calls[0]
    assert url.endswith("/th1/threads")
    assert "text" in params["fields"], "Threads posts carry `text`, not `caption`"
    assert len(items) == 1 and next_url == "u"


# -- rate limit headers --------------------------------------------------------------

def test_usage_header_is_parsed_from_business_use_case_shape():
    client, _ = _client([
        FakeResponse({"data": []}, headers={"X-Business-Use-Case-Usage": json.dumps(
            {"17841400000": [{"call_count": 12, "total_cputime": 45, "total_time": 30,
                              "estimated_time_to_regain_access": 0}]}
        )})
    ])
    client.get_user_media("ig1", "tok")
    assert client.last_usage_pct == 45, "the binding constraint is the HIGHEST percentage"
    assert client.retry_after_seconds == 0


def test_usage_header_flat_app_usage_shape():
    client, _ = _client([
        FakeResponse({"data": []}, headers={"X-App-Usage": json.dumps(
            {"call_count": 80, "total_cputime": 20, "total_time": 10}
        )})
    ])
    client.get_user_media("ig1", "tok")
    assert client.last_usage_pct == 80


def test_usage_header_is_read_from_throttled_responses_too():
    """A 429 is the response whose headers matter most — parsing must happen before the
    ok check, or the backoff goes blind exactly when it is needed."""
    client, _ = _client([
        FakeResponse({"error": {"message": "rate limited"}}, status=429, headers={
            "X-Business-Use-Case-Usage": json.dumps(
                {"1": [{"call_count": 100, "estimated_time_to_regain_access": 620}]}
            )
        })
    ])
    try:
        client.get_user_media("ig1", "tok")
    except Exception:
        pass
    assert client.last_usage_pct == 100
    assert client.retry_after_seconds == 620


def test_missing_or_malformed_usage_header_leaves_usage_unknown():
    """Unknown must stay None. A caller must not read 'no header' as 'plenty left'."""
    client, _ = _client([
        FakeResponse({"data": []}),
        FakeResponse({"data": []}, headers={"X-App-Usage": "not-json"}),
    ])
    client.get_user_media("ig1", "tok")
    assert client.last_usage_pct is None
    client.get_user_media("ig1", "tok")
    assert client.last_usage_pct is None
