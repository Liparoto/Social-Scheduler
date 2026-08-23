"""Mirroring TikTok's back catalogue.

This is the half of "past data" that IS available. /v2/video/list/ returns every video
the account has posted, with its CURRENT counts — so a backfill establishes where each
post stands today, and day-by-day history accrues from then on. What no TikTok endpoint
can give is what a video's numbers WERE last week.
"""

from __future__ import annotations

from datetime import datetime, timezone

from worker.media_sync import _ADAPTERS, _list_tiktok, _map_tiktok


class FakeTikTok:
    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def get_user_videos(self, token, fields, *, limit=20, cursor=None):
        self.calls.append({"limit": limit, "cursor": cursor, "fields": tuple(fields)})
        return self.pages.pop(0)


def test_registered_as_a_real_adapter():
    assert _ADAPTERS["tiktok"] is not None


def test_maps_a_video_onto_the_mirror_row():
    item = {
        "id": "7677325675732176159",
        "create_time": 1787516697,
        "video_description": "Loving our time in Tahoe",
        "cover_image_url": "https://p19.tiktokcdn.com/cover.jpeg",
        "share_url": "https://www.tiktok.com/@liparoto88/video/7677325675732176159",
        "duration": 7,
    }

    out = _map_tiktok(item)

    assert out["remote_post_id"] == "7677325675732176159"
    assert out["media_type"] == "VIDEO"
    assert out["media_product_type"] is None      # TikTok has no product-surface concept
    assert out["permalink"] == item["share_url"]
    assert out["thumbnail_url"] == item["cover_image_url"]


def test_the_caption_comes_back_even_though_it_never_went_out():
    """The publish path cannot send a caption — the creator types it in the TikTok app.
    This sync is the only way the caption a post ACTUALLY carries ever reaches this
    install."""
    out = _map_tiktok({"id": "1", "create_time": 1787516697,
                       "video_description": "what they actually typed"})
    assert out["caption"] == "what they actually typed"


def test_published_at_is_normalised_to_the_shared_iso_spelling():
    """TikTok sends a unix epoch while Meta sends a string. published_at is
    string-compared in SQL, so a mixed spelling silently produces wrong date windows
    rather than an error."""
    out = _map_tiktok({"id": "1", "create_time": 1787516697})

    assert out["published_at"] == datetime.fromtimestamp(
        1787516697, tz=timezone.utc
    ).isoformat()
    assert out["published_at"].endswith("+00:00")


def test_a_video_with_no_timestamp_maps_to_none_rather_than_the_epoch():
    assert _map_tiktok({"id": "1"})["published_at"] is None


def test_paging_carries_the_cursor_and_stops_when_tiktok_says_so():
    """TikTok pages by cursor where Meta pages by URL. The loop's token is opaque, so the
    contract holds as long as the last page reports no more."""
    client = FakeTikTok([
        ([{"id": "a"}, {"id": "b"}], 1787516697205),
        ([{"id": "c"}], None),
    ])
    channel = {"access_token": "act.T", "remote_account_id": "open-1"}

    items, cursor = _list_tiktok(client, channel, 20, None)
    assert [i["id"] for i in items] == ["a", "b"]
    assert cursor == 1787516697205

    items, cursor = _list_tiktok(client, channel, 20, cursor)
    assert [i["id"] for i in items] == ["c"]
    assert cursor is None, "a final page must report no more, or the loop never ends"
    assert client.calls[1]["cursor"] == 1787516697205


def test_the_page_size_is_clamped_to_what_tiktok_accepts():
    """Found on the first live run, not in a test: MEDIA_SYNC_PAGE_SIZE is tuned for
    Meta's larger pages, and TikTok rejects anything over 20 outright with
    "invalid_params: max_count needs to be in the range of [1, 20]" — so every sync cycle
    failed. Clamped in the adapter so the other platforms keep their bigger pages."""
    from worker.media_sync import TIKTOK_MAX_PAGE_SIZE

    client = FakeTikTok([([], None)])
    _list_tiktok(client, {"access_token": "act.T"}, 100, None)

    assert client.calls[0]["limit"] == TIKTOK_MAX_PAGE_SIZE == 20


def test_a_smaller_configured_page_size_is_left_alone():
    client = FakeTikTok([([], None)])
    _list_tiktok(client, {"access_token": "act.T"}, 5, None)
    assert client.calls[0]["limit"] == 5
