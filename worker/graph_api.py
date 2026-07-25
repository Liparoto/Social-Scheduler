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


class GraphAPIError(Exception):
    """Raised when the Graph API returns a non-OK response."""


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
        resp = self.session.post(f"{self.base}/{path}", data=data, timeout=self.timeout)
        if not resp.ok:
            raise GraphAPIError(f"POST {path} -> {resp.status_code}: {resp.text}")
        return resp.json()

    def _get(self, path: str, params: dict) -> dict:
        resp = self.session.get(f"{self.base}/{path}", params=params, timeout=self.timeout)
        if not resp.ok:
            raise GraphAPIError(f"GET {path} -> {resp.status_code}: {resp.text}")
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
