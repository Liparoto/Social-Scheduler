"""Meta Graph API client for Instagram, Facebook Page, and Threads content publishing.

Implements the verified flow (see reference.md, checked against v25.0):
  * create a media container (POST /{ig-user-id}/media)
  * for carousels: child containers (is_carousel_item=true) -> parent (media_type=CAROUSEL)
  * poll container status (?fields=status_code) until FINISHED
  * publish (POST /{ig-user-id}/media_publish)
  * read the runtime publish quota (GET /{ig-user-id}/content_publishing_limit)

The publisher depends only on this class's method surface, so tests can inject a fake
client with the same methods and exercise the whole pipeline without real HTTP.
"""

from __future__ import annotations

import json

import requests

from .redact import redact


class GraphAPIError(Exception):
    """Raised when the Graph API returns a non-OK response, or the underlying request
    fails at the network layer. Never carries an unredacted access_token."""


class GraphClient:
    def __init__(
        self,
        graph_version: str,
        session: requests.Session | None = None,
        base_url: str = "https://graph.facebook.com",
        timeout: int = 60,
    ) -> None:
        self.base = f"{base_url.rstrip('/')}/{graph_version}"
        self.session = session or requests.Session()
        self.timeout = timeout

    # -- low-level helpers ---------------------------------------------------------
    def _post(self, path: str, data: dict) -> dict:
        try:
            resp = self.session.post(f"{self.base}/{path}", data=data, timeout=self.timeout)
        except requests.RequestException as exc:
            # `from None`: exc's own str() carries the unredacted access_token (it's a
            # query param on the request URL) — never let it survive into a traceback
            # via __cause__. The redacted message above already carries what's useful.
            raise GraphAPIError(f"POST {path} -> request failed: {redact(str(exc))}") from None
        if not resp.ok:
            raise GraphAPIError(f"POST {path} -> {resp.status_code}: {redact(resp.text)}")
        return resp.json()

    def _get(self, path: str, params: dict) -> dict:
        try:
            resp = self.session.get(f"{self.base}/{path}", params=params, timeout=self.timeout)
        except requests.RequestException as exc:
            raise GraphAPIError(f"GET {path} -> request failed: {redact(str(exc))}") from None
        if not resp.ok:
            raise GraphAPIError(f"GET {path} -> {resp.status_code}: {redact(resp.text)}")
        return resp.json()

    # -- publishing flow -----------------------------------------------------------
    def create_image_container(
        self,
        ig_user_id: str,
        image_url: str,
        token: str,
        caption: str | None = None,
        is_carousel_item: bool = False,
    ) -> str:
        data = {"image_url": image_url, "access_token": token}
        if caption:
            data["caption"] = caption
        if is_carousel_item:
            data["is_carousel_item"] = "true"
        return self._post(f"{ig_user_id}/media", data)["id"]

    def create_carousel_container(
        self,
        ig_user_id: str,
        children_ids: list[str],
        token: str,
        caption: str | None = None,
    ) -> str:
        data = {
            "media_type": "CAROUSEL",
            "children": ",".join(children_ids),
            "access_token": token,
        }
        if caption:
            data["caption"] = caption
        return self._post(f"{ig_user_id}/media", data)["id"]

    def create_video_container(
        self,
        ig_user_id: str,
        video_url: str,
        token: str,
        caption: str | None = None,
        thumb_offset: int | None = None,
        cover_url: str | None = None,
    ) -> str:
        """Create a REELS container. Meta downloads video_url server-side, transcodes it,
        and the container is not publishable until its status_code reaches FINISHED —
        which for video takes far longer than for an image (see the Reels poll budget).

        thumb_offset is a MILLISECOND offset; Meta extracts that frame as the cover, so
        we never generate or upload a cover image for that path. Meta's documented
        default is 0 (the first frame) when the field is absent.

        cover_url is a real image (public URL) to use as the cover instead. Meta's own
        docs say cover_url wins and thumb_offset is ignored if both are sent — but our
        caller (_build_plan / _publish_reel) already resolves that choice and only ever
        passes one of the two, so this method just forwards whichever is given.
        """
        data = {
            "media_type": "REELS",
            "video_url": video_url,
            "access_token": token,
        }
        if caption:
            data["caption"] = caption
        # Explicitly `is not None`: 0 means "the first frame, deliberately chosen", and a
        # truthiness check would silently drop it.
        if thumb_offset is not None:
            data["thumb_offset"] = thumb_offset
        if cover_url is not None:
            data["cover_url"] = cover_url
        return self._post(f"{ig_user_id}/media", data)["id"]

    def create_story_container(
        self,
        ig_user_id: str,
        token: str,
        image_url: str | None = None,
        video_url: str | None = None,
    ) -> str:
        """Create a STORIES container from exactly ONE image or video.

        There is no such thing as a carousel Story in the API. A multi-slide post becomes
        SEVERAL Stories, fanned out into one publication per slide before we ever get here
        (see publisher._load_targets), so this call is always single-media.

        Stories take NO caption: the field does not exist on this surface. There is
        deliberately no caption parameter to pass, rather than one that gets dropped —
        the caller cannot accidentally believe a caption went out.
        """
        if bool(image_url) == bool(video_url):
            raise ValueError("a story needs exactly one of image_url or video_url")
        data = {"media_type": "STORIES", "access_token": token}
        if video_url:
            data["video_url"] = video_url
        else:
            data["image_url"] = image_url
        return self._post(f"{ig_user_id}/media", data)["id"]

    def get_container_status(self, container_id: str, token: str) -> str:
        return self._get(
            container_id, {"fields": "status_code", "access_token": token}
        )["status_code"]

    def publish_container(self, ig_user_id: str, creation_id: str, token: str) -> str:
        return self._post(
            f"{ig_user_id}/media_publish",
            {"creation_id": creation_id, "access_token": token},
        )["id"]

    def get_media_insights(
        self, media_id: str, token: str, metrics: list[str]
    ) -> dict:
        """Fetch insight metrics for a published media. Returns {metric_name: value}.

        IG insights response shape:
          {"data": [{"name": "reach", "values": [{"value": N}]}, ...]}
        """
        data = self._get(
            f"{media_id}/insights",
            {"metric": ",".join(metrics), "access_token": token},
        )
        return self._parse_insights(data)

    @staticmethod
    def _parse_insights(data: dict) -> dict:
        """Both IG media and FB Page-post insights use the same response shape:
        {"data": [{"name": ..., "values": [{"value": N}]}, ...]}
        """
        out: dict = {}
        for item in data.get("data", []):
            name = item.get("name")
            values = item.get("values") or [{}]
            out[name] = values[0].get("value")
        return out

    def get_content_publishing_limit(
        self, ig_user_id: str, token: str
    ) -> tuple[int | None, int | None, int | None]:
        """Return (quota_usage, quota_total, quota_duration_seconds).

        Never hardcode the limit — Meta's own docs disagree (50 vs 100). Read it live.
        """
        data = self._get(
            f"{ig_user_id}/content_publishing_limit",
            {"fields": "quota_usage,config", "access_token": token},
        )
        entries = data.get("data") or [{}]
        entry = entries[0]
        cfg = entry.get("config", {}) or {}
        return (
            entry.get("quota_usage"),
            cfg.get("quota_total"),
            cfg.get("quota_duration"),
        )

    # -- Facebook Page publishing ---------------------------------------------------
    # A Page post is simpler than IG: no container to poll. A single photo publishes in
    # one call; a multi-photo post uploads each photo UNPUBLISHED, then attaches them to
    # one feed post. Meta fetches image_url server-side, exactly like IG.
    def create_page_photo(
        self,
        page_id: str,
        image_url: str,
        token: str,
        *,
        caption: str | None = None,
        published: bool = True,
    ) -> dict:
        """Upload a photo to a Page. Returns the raw response.

        When published=True the response carries both `id` (the photo) and `post_id`
        (the feed post — the id insights are read against). When published=False it
        returns only `id`, to be used as a media_fbid in create_page_feed_post().
        """
        data = {
            "url": image_url,
            "access_token": token,
            "published": "true" if published else "false",
        }
        # An unpublished child photo never shows its caption anywhere — the text goes on
        # the feed post as `message` instead.
        if caption and published:
            data["caption"] = caption
        return self._post(f"{page_id}/photos", data)

    def create_page_feed_post(
        self,
        page_id: str,
        token: str,
        *,
        message: str | None = None,
        attached_media: list[str] | None = None,
    ) -> str:
        """Create a Page feed post, optionally attaching already-uploaded photos."""
        data = {"access_token": token}
        if message:
            data["message"] = message
        for i, media_fbid in enumerate(attached_media or []):
            # Form-encoded requests take attached_media as indexed JSON objects.
            data[f"attached_media[{i}]"] = json.dumps({"media_fbid": str(media_fbid)})
        return self._post(f"{page_id}/feed", data)["id"]

    def get_page_post_summary(self, post_id: str, token: str) -> dict:
        """Stable engagement counts for a Page post.

        These are plain edge summaries, NOT insights, so they are unaffected by the
        2026-06-15 Page-insights metric deprecation. Returns only what came back —
        a missing key means "unknown", which must stay null rather than become 0.
        """
        data = self._get(
            post_id,
            {
                "fields": (
                    "reactions.summary(total_count).limit(0),"
                    "comments.summary(total_count).limit(0),"
                    "shares"
                ),
                "access_token": token,
            },
        )
        out: dict = {}
        reactions = (data.get("reactions") or {}).get("summary") or {}
        if "total_count" in reactions:
            out["fb_reactions"] = reactions["total_count"]
        comments = (data.get("comments") or {}).get("summary") or {}
        if "total_count" in comments:
            out["fb_comments"] = comments["total_count"]
        shares = data.get("shares") or {}
        if "count" in shares:
            out["fb_shares"] = shares["count"]
        return out

    def get_page_info(self, page_id: str, token: str) -> dict:
        """Minimal read-only node fetch, used by preflight to prove a Page token and
        Page id are valid. Facebook Pages have no content_publishing_limit endpoint,
        so this is the FB equivalent of that IG quota check — it proves reachability,
        not quota.
        """
        return self._get(page_id, {"fields": "id,name", "access_token": token})

    def get_page_post_insights(self, post_id: str, token: str, metrics: list[str]) -> dict:
        """Insight metrics for a Page post. Returns {metric_name: value}.

        Meta deprecated a large set of these names on 2026-06-15 and keeps changing
        them, so an invalid metric raises here and the CALLER treats it as best-effort
        (see metrics._fetch_facebook) rather than a hard failure.
        """
        data = self._get(
            f"{post_id}/insights",
            {"metric": ",".join(metrics), "access_token": token},
        )
        return self._parse_insights(data)

    # -- Threads publishing -----------------------------------------------------------
    # Threads publishing is a container -> publish flow like Instagram's, built at
    # https://graph.threads.net/v1.0 instead of graph.facebook.com. Two differences that
    # are easy to get backwards:
    #   * the container-status field is named `status`, not IG's `status_code`
    #   * lifetime insight metrics come back as {"total_value": {"value": N}} rather than
    #     IG/FB's {"values": [{"value": N}]} — handled by _parse_threads_insights below,
    #     which stays separate from the shared _parse_insights so IG/FB behavior can't
    #     regress from a Threads-only envelope change.
    def create_threads_container(
        self,
        threads_user_id: str,
        token: str,
        *,
        media_type: str,
        text: str | None = None,
        image_url: str | None = None,
        is_carousel_item: bool = False,
        children: list[str] | None = None,
    ) -> str:
        """Create a Threads media container. Returns the container id.

        media_type is one of:
          TEXT     - requires `text` (max 500 chars), no image_url
          IMAGE    - requires `image_url`, `text` optional
          CAROUSEL - requires `children` (2-20 container ids), `text` optional

        Carousel children are created with is_carousel_item=True beforehand, then their
        ids are passed as `children` to the CAROUSEL parent call.
        """
        data = {"media_type": media_type, "access_token": token}
        if text is not None:
            data["text"] = text
        if image_url is not None:
            data["image_url"] = image_url
        if is_carousel_item:
            data["is_carousel_item"] = "true"
        if children is not None:
            data["children"] = ",".join(children)
        return self._post(f"{threads_user_id}/threads", data)["id"]

    def get_threads_container_status(self, container_id: str, token: str) -> str:
        """Poll until this returns FINISHED before publishing. Note the field name is
        `status`, unlike Instagram's `status_code`.

        Raises if the field is absent, matching Instagram's get_container_status — a
        malformed response must fail fast rather than silently returning "" and burning
        every retry (status_poll_max_tries x status_poll_interval, synchronously, inside
        the batch loop) waiting for a value that will never arrive.
        """
        data = self._get(container_id, {"fields": "status", "access_token": token})
        if "status" not in data:
            raise GraphAPIError(
                f"GET {container_id} -> response missing 'status' field"
            )
        return data["status"]

    def publish_threads_container(
        self, threads_user_id: str, creation_id: str, token: str
    ) -> str:
        return self._post(
            f"{threads_user_id}/threads_publish",
            {"creation_id": creation_id, "access_token": token},
        )["id"]

    def get_threads_publishing_limit(
        self, threads_user_id: str, token: str
    ) -> tuple[int | None, int | None, int | None]:
        """Return (quota_usage, quota_total, quota_duration_seconds).

        250 published posts per rolling 24h, per Meta's docs — but read it live rather
        than hardcoding it, same reasoning as get_content_publishing_limit. Mirrors that
        method's defensive parsing: `data` may be missing or empty, `config` may be
        missing.
        """
        data = self._get(
            f"{threads_user_id}/threads_publishing_limit",
            {"fields": "quota_usage,config", "access_token": token},
        )
        entries = data.get("data") or [{}]
        entry = entries[0]
        cfg = entry.get("config", {}) or {}
        return (
            entry.get("quota_usage"),
            cfg.get("quota_total"),
            cfg.get("quota_duration"),
        )

    def get_threads_insights(
        self, media_id: str, token: str, metrics: list[str]
    ) -> dict:
        """Fetch insight metrics (e.g. views, likes, replies, reposts, quotes) for a
        published Threads post. Returns {metric_name: value}."""
        data = self._get(
            f"{media_id}/insights",
            {"metric": ",".join(metrics), "access_token": token},
        )
        return self._parse_threads_insights(data)

    @staticmethod
    def _parse_threads_insights(data: dict) -> dict:
        """Threads insights response shape:
        {"data": [{"name": ..., "total_value": {"value": N}}, ...]}
        for lifetime metrics, but some items instead carry the IG/FB-style
        {"values": [{"value": N}]}. Prefer total_value when present.
        """
        out: dict = {}
        for item in data.get("data", []):
            name = item.get("name")
            if "total_value" in item:
                out[name] = (item.get("total_value") or {}).get("value")
            else:
                values = item.get("values") or [{}]
                out[name] = values[0].get("value")
        return out

    # -- profile photos ----------------------------------------------------------------
    # Each lookup distinguishes "no photo" (None) from "the request failed" (raises).
    # avatars.py depends on that: None is a normal state that falls back to the initial
    # circle, while an exception means keep the existing photo and record an error.

    def get_instagram_profile_picture_url(self, ig_user_id: str, token: str) -> str | None:
        data = self._get(ig_user_id, {"fields": "profile_picture_url", "access_token": token})
        return data.get("profile_picture_url") or None

    def get_page_picture_url(self, page_id: str, token: str) -> str | None:
        """Page profile picture. Nested one level deeper than IG's flat field.

        `is_silhouette` means the Page never set a picture and Meta is handing back its
        generic grey figure. That is worse than our own initial circle, which at least
        says which account it is — so it is treated as "no photo".
        """
        data = self._get(
            page_id,
            {"fields": "picture.width(320).height(320)", "access_token": token},
        )
        picture = ((data.get("picture") or {}).get("data")) or {}
        if picture.get("is_silhouette"):
            return None
        return picture.get("url") or None

    def get_threads_profile_picture_url(self, threads_user_id: str, token: str) -> str | None:
        data = self._get(
            threads_user_id,
            {"fields": "threads_profile_picture_url", "access_token": token},
        )
        return data.get("threads_profile_picture_url") or None

    def download_image_bytes(self, url: str, max_bytes: int = 5_000_000) -> bytes:
        """Fetch raw bytes from an absolute CDN URL (NOT a Graph path, so it does not go
        through _get). Streams so an unexpectedly huge or endless response is stopped at
        max_bytes rather than read into memory in full.
        """
        try:
            with self.session.get(url, timeout=self.timeout, stream=True) as resp:
                if not resp.ok:
                    raise GraphAPIError(
                        f"GET avatar -> {resp.status_code}: {redact(resp.text)}"
                    )
                chunks: list[bytes] = []
                total = 0
                for chunk in resp.iter_content(chunk_size=8192):
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise GraphAPIError(
                            f"avatar download too large (> {max_bytes} bytes)"
                        )
                    chunks.append(chunk)
                return b"".join(chunks)
        except requests.RequestException as exc:
            raise GraphAPIError(f"GET avatar -> request failed: {redact(str(exc))}") from None
