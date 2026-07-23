"""Meta Graph API client for Instagram content publishing.

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
