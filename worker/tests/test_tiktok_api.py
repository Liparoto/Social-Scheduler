"""TikTokClient: the OAuth pair and the read-only identity call.

TikTok returns HTTP 200 with {"error": {"code": "access_token_invalid"}} on failure, so the
BODY is the success signal, not the status code — the same trap Telegram's `ok` field sets.
"""

from __future__ import annotations

import pytest

from worker.tiktok_api import TikTokAPIError, TikTokClient


class FakeResponse:
    def __init__(self, payload, status=200, text=""):
        self._payload = payload
        self.status_code = status
        self.ok = status < 400
        self.text = text or str(payload)

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeSession:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        return self.response

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return self.response

    def put(self, url, **kwargs):
        self.calls.append(("PUT", url, kwargs))
        return self.response


TOKENS = {
    "access_token": "act.NEW",
    "expires_in": 86400,
    "refresh_token": "rft.ROTATED",
    "refresh_expires_in": 31536000,
    "open_id": "open-1",
}


def test_exchange_code_posts_form_encoded_with_pkce_verifier():
    session = FakeSession(FakeResponse(TOKENS))
    client = TikTokClient(session=session)
    out = client.exchange_code("key", "secret", "code-1", "http://localhost:3939/cb", "verifier-1")
    assert out["access_token"] == "act.NEW"
    _, url, kwargs = session.calls[0]
    assert url.endswith("/v2/oauth/token/")
    # Form-encoded, NOT json — TikTok rejects a JSON body on this endpoint.
    assert kwargs["data"]["grant_type"] == "authorization_code"
    assert kwargs["data"]["code_verifier"] == "verifier-1"
    assert kwargs["data"]["redirect_uri"] == "http://localhost:3939/cb"
    assert "json" not in kwargs


def test_refresh_returns_the_rotated_refresh_token():
    session = FakeSession(FakeResponse(TOKENS))
    client = TikTokClient(session=session)
    out = client.refresh_access_token("key", "secret", "rft.OLD")
    # The whole point: the NEW refresh token must come back, or the channel dies at the
    # next refresh.
    assert out["refresh_token"] == "rft.ROTATED"
    assert session.calls[0][2]["data"]["grant_type"] == "refresh_token"


def test_error_body_on_http_200_still_raises():
    session = FakeSession(
        FakeResponse({"error": {"code": "invalid_grant", "message": "revoked", "log_id": "L1"}})
    )
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "secret", "rft.OLD")
    assert "invalid_grant" in str(exc.value)


def test_secrets_never_appear_in_an_error():
    session = FakeSession(FakeResponse({"error": {"code": "bad", "message": "no"}}))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "SUPERSECRETVALUE", "rft.SENSITIVEVALUE")
    assert "SUPERSECRETVALUE" not in str(exc.value)
    assert "rft.SENSITIVEVALUE" not in str(exc.value)


def test_get_user_info_sends_bearer_and_requested_fields():
    session = FakeSession(
        FakeResponse({"data": {"user": {"display_name": "Kelan"}}, "error": {"code": "ok"}})
    )
    client = TikTokClient(session=session)
    user = client.get_user_info("act.TOKEN", fields=("open_id", "display_name"))
    assert user["display_name"] == "Kelan"
    _, _, kwargs = session.calls[0]
    assert kwargs["headers"]["Authorization"] == "Bearer act.TOKEN"
    assert "display_name" in kwargs["params"]["fields"]


def test_non_json_response_becomes_a_tiktok_error():
    session = FakeSession(FakeResponse(None, status=502, text="<html>bad gateway</html>"))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError):
        client.get_user_info("act.TOKEN")


def test_a_network_failure_never_leaks_the_request_via_the_exception_chain():
    import requests

    class BoomSession:
        def post(self, url, **kwargs):
            raise requests.RequestException("connection to open.tiktokapis.com failed")

    client = TikTokClient(session=BoomSession())
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "secret", "rft.OLD")
    # `from None`, not `from exc`: the original exception's own str() must not survive
    # into a traceback via __cause__, where it could carry the request back out.
    assert exc.value.__cause__ is None


# ---- Inbox upload ---------------------------------------------------------------------
from worker.tiktok_api import MAX_CHUNK_BYTES, MIN_CHUNK_BYTES, plan_chunks  # noqa: E402

MB = 1024 * 1024


def test_small_file_is_one_chunk_even_below_the_5mb_minimum():
    # A whole file under 5 MB is a legal single chunk — the minimum governs the chunks of
    # a SPLIT upload, not a file that fits in one.
    assert plan_chunks(2 * MB) == (2 * MB, 1)


def test_file_at_the_single_chunk_ceiling_is_still_one_chunk():
    size, count = plan_chunks(MAX_CHUNK_BYTES)
    assert count == 1 and size == MAX_CHUNK_BYTES


def test_large_file_splits_into_legal_chunks():
    total = 200 * MB
    size, count = plan_chunks(total)
    assert MIN_CHUNK_BYTES <= size <= MAX_CHUNK_BYTES
    assert count >= 2
    last = total - size * (count - 1)
    assert last >= MIN_CHUNK_BYTES, f"final chunk of {last} bytes is below TikTok's minimum"
    assert last <= 128 * MB, "final chunk exceeds TikTok's 128 MB ceiling"


@pytest.mark.parametrize("total", [65 * MB, 70 * MB, 130 * MB, 200 * MB, 999 * MB])
def test_the_planned_count_matches_the_chunks_actually_sent(total, tmp_path):
    """TikTok is told total_chunk_count up front and rejects an upload that sends a
    different number, so the plan and the loop must agree for every size — including the
    awkward ones where the division leaves a remainder."""
    size, count = plan_chunks(total)
    sent, remaining = 0, total
    chunks = 0
    while remaining > 0:
        this = size if remaining - size >= size else remaining
        sent += this
        remaining -= this
        chunks += 1
    assert chunks == count, f"planned {count} chunks, loop would send {chunks}"
    assert sent == total


def test_init_inbox_video_sends_the_chunk_plan_and_no_caption():
    session = FakeSession(FakeResponse({
        "data": {"publish_id": "pub-1", "upload_url": "https://upload.example/1"},
        "error": {"code": "ok"},
    }))
    client = TikTokClient(session=session)
    out = client.init_inbox_video("act.TOKEN", video_size=10 * MB, chunk_size=10 * MB,
                                  total_chunk_count=1)
    assert out["publish_id"] == "pub-1"
    _, url, kwargs = session.calls[0]
    assert url.endswith("/v2/post/publish/inbox/video/init/")
    source = kwargs["json"]["source_info"]
    assert source["source"] == "FILE_UPLOAD"
    assert source["video_size"] == 10 * MB
    # There is no post_info. The inbox endpoint accepts no caption at all — the creator
    # writes it in the TikTok app. Sending one is not possible, not merely skipped.
    assert "post_info" not in kwargs["json"]


def test_upload_video_file_sends_every_chunk_with_an_inclusive_content_range(tmp_path):
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"x" * (12 * MB))
    session = FakeSession(FakeResponse({}, status=201))
    client = TikTokClient(session=session)
    client.upload_video_file("https://upload.example/1", video, chunk_size=6 * MB)
    ranges = [kw["headers"]["Content-Range"] for _, _, kw in session.calls]
    # `end` is INCLUSIVE per RFC 7233 — an off-by-one here is rejected by TikTok.
    assert ranges == [
        f"bytes 0-{6 * MB - 1}/{12 * MB}",
        f"bytes {6 * MB}-{12 * MB - 1}/{12 * MB}",
    ]


def test_a_failed_chunk_never_names_the_signed_upload_url():
    session = FakeSession(FakeResponse(None, status=403, text="forbidden"))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.upload_chunk("https://upload.example/SIGNED-SECRET", b"x", start=0, end=0, total=1)
    # The upload URL is itself a credential — a signed URL anyone can PUT to.
    assert "SIGNED-SECRET" not in str(exc.value)


def test_fetch_publish_status_returns_status_and_post_id():
    session = FakeSession(FakeResponse({
        "data": {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": ["7123"]},
        "error": {"code": "ok"},
    }))
    client = TikTokClient(session=session)
    out = client.fetch_publish_status("act.TOKEN", "pub-1")
    assert out["status"] == "PUBLISH_COMPLETE"
    # TikTok's own misspelling. Do not "fix" it.
    assert out["publicaly_available_post_id"] == ["7123"]


def test_query_videos_filters_by_id():
    session = FakeSession(FakeResponse({
        "data": {"videos": [{"id": "7123", "like_count": 5, "view_count": 100}]},
        "error": {"code": "ok"},
    }))
    client = TikTokClient(session=session)
    videos = client.query_videos("act.TOKEN", ["7123"], ["id", "like_count", "view_count"])
    assert videos[0]["view_count"] == 100
    _, _, kwargs = session.calls[0]
    assert kwargs["json"]["filters"]["video_ids"] == ["7123"]


def test_oauth_style_flat_error_is_reported_not_crashed_on():
    """The token endpoint reports failure OAuth2-style — `error` is a STRING with
    error_description beside it — while every other v2 endpoint nests {code, message}.
    Treating the string as an object raises AttributeError instead of TikTokAPIError,
    which would turn a refusable token refresh into a crash mid-publish."""
    session = FakeSession(FakeResponse({
        "error": "invalid_request",
        "error_description": "Redirect_uri is not matched with the uri when requesting code.",
        "log_id": "20260823185437010113",
    }))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "secret", "rft.OLDVALUE")
    assert "invalid_request" in str(exc.value)
    # The description is the only actionable part; losing it leaves nothing to act on.
    assert "Redirect_uri is not matched" in str(exc.value)


def test_flat_error_is_still_classified_as_revoked_where_it_should_be():
    """tiktok_tokens matches revoked-vs-transient on TikTok's code appearing in the
    message, so the flat shape has to put it there too."""
    from worker.tiktok_tokens import _REVOKED_CODES

    session = FakeSession(FakeResponse({"error": "invalid_grant", "error_description": "gone"}))
    client = TikTokClient(session=session)
    with pytest.raises(TikTokAPIError) as exc:
        client.refresh_access_token("key", "secret", "rft.OLDVALUE")
    assert any(code in str(exc.value) for code in _REVOKED_CODES)


def test_download_image_bytes_streams_and_caps(tmp_path):
    """The avatar flow is fetch-URL then DOWNLOAD-BYTES, and every client in the registry
    has to implement both halves. Testing only the URL half is how this shipped missing:
    avatars.py calls client.download_image_bytes() by name on whatever client the registry
    hands it, so a client without the method fails with AttributeError at runtime while
    its own unit tests stay green."""

    class StreamResponse:
        ok = True
        status_code = 200
        text = ""

        def __init__(self, payload):
            self._payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def iter_content(self, chunk_size=8192):
            for i in range(0, len(self._payload), chunk_size):
                yield self._payload[i:i + chunk_size]

    class StreamSession:
        def __init__(self, payload):
            self.payload = payload
            self.asked = None

        def get(self, url, **kwargs):
            self.asked = (url, kwargs)
            return StreamResponse(self.payload)

    session = StreamSession(b"JPEGDATA" * 100)
    client = TikTokClient(session=session)

    data = client.download_image_bytes("https://p16.tiktokcdn.com/avatar.jpeg")

    assert data == b"JPEGDATA" * 100
    assert session.asked[1]["stream"] is True, "must stream, not buffer an unbounded body"


def test_download_image_bytes_refuses_an_oversized_body():
    class Endless:
        ok = True
        status_code = 200
        text = ""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def iter_content(self, chunk_size=8192):
            while True:
                yield b"x" * chunk_size

    class EndlessSession:
        def get(self, url, **kwargs):
            return Endless()

    client = TikTokClient(session=EndlessSession())
    with pytest.raises(TikTokAPIError):
        client.download_image_bytes("https://p16.tiktokcdn.com/huge", max_bytes=1000)


def test_every_client_the_registry_builds_can_download_an_avatar():
    """avatars._URL_FETCHERS names the platforms that HAVE an avatar; each of their
    clients must also be able to fetch the image itself."""
    from worker.avatars import _URL_FETCHERS
    from worker.clients import _CLIENT_FACTORIES

    for platform, fetch in _URL_FETCHERS.items():
        if fetch is None:
            continue
        client = _CLIENT_FACTORIES[platform]("v1", "https://example.test")
        assert hasattr(client, "download_image_bytes"), (
            f"{platform} has an avatar fetcher but its client cannot download the image"
        )
