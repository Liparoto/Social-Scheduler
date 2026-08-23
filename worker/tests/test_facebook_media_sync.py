"""Mirroring a Facebook Page's own posts.

Probed live 2026-08-23: published_posts, posts and feed all worked and returned the same
rows for this Page, and paging walked back to 2022. So this is a genuine history backfill,
not a recent-window sync.
"""

from __future__ import annotations

from worker.media_sync import _ADAPTERS, _list_facebook, _map_facebook


class FakeGraph:
    def __init__(self, pages):
        self.pages = list(pages)
        self.calls = []

    def get_page_posts(self, page_id, token, *, limit=25, next_url=None):
        self.calls.append({"page_id": page_id, "limit": limit, "next_url": next_url})
        return self.pages.pop(0)


def test_registered_as_a_real_adapter():
    assert _ADAPTERS["facebook"] is not None


def test_maps_facebooks_own_field_names():
    """Facebook names almost everything differently from Instagram: message not caption,
    created_time not timestamp, permalink_url not permalink."""
    item = {
        "id": "269462483652949_1385173893655374",
        "message": "Chillin' with the man himself",
        "created_time": "2026-04-10T20:00:22+0000",
        "permalink_url": "https://www.facebook.com/1503508701821892/posts/1385173893655374",
        "full_picture": "https://scontent.xx.fbcdn.net/v/photo.jpg",
        "status_type": "added_photos",
    }

    out = _map_facebook(item)

    assert out["remote_post_id"] == item["id"]
    assert out["caption"] == "Chillin' with the man himself"
    assert out["permalink"] == item["permalink_url"]
    assert out["thumbnail_url"] == item["full_picture"]
    assert out["media_type"] == "IMAGE"
    assert out["media_product_type"] is None


def test_published_at_is_normalised_to_the_shared_iso_spelling():
    """Meta sends '+0000' with no colon. published_at is string-compared in SQL, so a
    mixed spelling makes date windows silently wrong rather than raising."""
    out = _map_facebook({"id": "1", "created_time": "2026-04-10T20:00:22+0000"})
    assert out["published_at"] == "2026-04-10T20:00:22+00:00"


def test_an_unrecognised_status_type_is_not_guessed_at():
    """Guessing IMAGE for a live video or a link share would put a wrong shape in the
    library, and nothing downstream would ever contradict it."""
    out = _map_facebook({"id": "1", "status_type": "something_meta_invented_later"})
    assert out["media_type"] is None


def test_known_status_types_map_to_the_shared_vocabulary():
    for status, expected in (
        ("added_photos", "IMAGE"),
        ("added_video", "VIDEO"),
        ("shared_story", "LINK"),
        ("mobile_status_update", "TEXT"),
    ):
        assert _map_facebook({"id": "1", "status_type": status})["media_type"] == expected


def test_paging_walks_backwards_through_history():
    client = FakeGraph([
        ([{"id": "a"}, {"id": "b"}], "https://graph.facebook.com/next?after=cursor1"),
        ([{"id": "c"}], None),
    ])
    channel = {"remote_account_id": "PAGE1", "access_token": "tok"}

    items, nxt = _list_facebook(client, channel, 25, None)
    assert [i["id"] for i in items] == ["a", "b"]
    assert nxt == "https://graph.facebook.com/next?after=cursor1"

    items, nxt = _list_facebook(client, channel, 25, nxt)
    assert [i["id"] for i in items] == ["c"]
    assert nxt is None
    assert client.calls[1]["next_url"] == "https://graph.facebook.com/next?after=cursor1"


def test_it_lists_the_pages_OWN_posts():
    """published_posts, not feed: feed can carry posts made BY OTHER PEOPLE on the Page,
    and mirroring those would put content the owner never wrote into their library."""
    import inspect

    from worker.graph_api import GraphClient

    source = inspect.getsource(GraphClient.get_page_posts)
    assert "published_posts" in source
    assert "/feed" not in source
