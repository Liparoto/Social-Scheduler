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

from .caption_length import caption_length
from .redact import redact


class GraphAPIError(Exception):
    """Raised when the Graph API returns a non-OK response, or the underlying request
    fails at the network layer. Never carries an unredacted access_token.

    Carries Meta's own error `code`/`error_subcode` when the body had them, so a caller can
    decide whether a failure is worth retrying instead of pattern-matching the message
    text. All three are None for a network-layer failure, where there is no response at all.

    The codes are not secrets and are parsed from the raw body; the MESSAGE is still built
    from `redact()`, so nothing here changes what can reach a log.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: int | None = None,
        error_subcode: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.error_subcode = error_subcode

    @property
    def is_missing_object(self) -> bool:
        """Meta saying the thing we asked about is not there.

        Code 100 with subcode 33. Meta's own text is "Object with ID '…' does not exist,
        cannot be loaded due to missing permissions, or does not support this operation" —
        note that it covers a DELETED object and a PERMISSIONS problem with one code, which
        is why no caller should treat a single occurrence as proof of deletion.
        """
        return self.code == 100 and self.error_subcode == 33


def _error_fields(body: str) -> dict:
    """Pull Meta's error code/subcode out of a response body, tolerating anything.

    An error path must never raise on its way to raising. A body that is HTML, empty, or a
    proxy's plain-text timeout is normal here, and all of it degrades to "no codes known".
    """
    try:
        error = json.loads(body).get("error", {})
    except (ValueError, AttributeError):
        return {}
    if not isinstance(error, dict):
        return {}
    fields = {}
    for src, dest in (("code", "code"), ("error_subcode", "error_subcode")):
        value = error.get(src)
        if isinstance(value, int):
            fields[dest] = value
    return fields


class GraphClient:
    # Meta reports rate-limit consumption in a response HEADER, not the body, and the
    # numbers are percentages of a quota it never publishes. Reading it is the only
    # honest way to back off — the same rule content_publishing_limit follows for
    # publishing: never hardcode a limit Meta will disagree with.
    BUC_HEADER = "X-Business-Use-Case-Usage"
    APP_USAGE_HEADER = "X-App-Usage"

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
        # Percentage (0-100) of the rate-limit quota consumed as of the last response,
        # and seconds until access returns if we are already throttled. None until a
        # response actually carries the header — "unknown", which callers must not
        # mistake for "plenty left".
        self.last_usage_pct: int | None = None
        self.retry_after_seconds: int = 0

    # -- low-level helpers ---------------------------------------------------------
    def _record_usage(self, resp) -> None:
        """Parse Meta's rate-limit headers off a response.

        Called before the ok/not-ok check on purpose: a 429 is exactly the response whose
        headers matter most, and skipping it there would blind the backoff at the one
        moment it is needed.

        Two header shapes, because Meta uses both:
          X-Business-Use-Case-Usage: {"<id>": [{"call_count": N, "total_cputime": N,
                                                "total_time": N,
                                                "estimated_time_to_regain_access": N}]}
          X-App-Usage:               {"call_count": N, "total_cputime": N, "total_time": N}
        Each number is a PERCENTAGE of its own quota, so the binding constraint is the
        highest of them, not their sum.

        This is BOOKKEEPING, and bookkeeping must never break the call it rides along
        with: a malformed header, or a response object carrying no headers at all,
        leaves usage unknown and is otherwise ignored. Telemetry must never raise into
        the caller's path.
        """
        headers = getattr(resp, "headers", None) or {}
        raw = headers.get(self.BUC_HEADER) or headers.get(self.APP_USAGE_HEADER)
        if not raw:
            return
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return
        entries: list[dict] = []
        if isinstance(parsed, dict):
            for value in parsed.values():
                if isinstance(value, list):
                    entries.extend(v for v in value if isinstance(v, dict))
            # X-App-Usage is the flat shape: the dict IS the entry.
            if not entries and any(k in parsed for k in ("call_count", "total_time")):
                entries = [parsed]
        for entry in entries:
            for key in ("call_count", "total_cputime", "total_time"):
                value = entry.get(key)
                if isinstance(value, (int, float)):
                    pct = int(value)
                    if self.last_usage_pct is None or pct > self.last_usage_pct:
                        self.last_usage_pct = pct
            wait = entry.get("estimated_time_to_regain_access")
            if isinstance(wait, (int, float)) and wait > self.retry_after_seconds:
                self.retry_after_seconds = int(wait)

    def _post(self, path: str, data: dict) -> dict:
        try:
            resp = self.session.post(f"{self.base}/{path}", data=data, timeout=self.timeout)
        except requests.RequestException as exc:
            # `from None`: exc's own str() carries the unredacted access_token (it's a
            # query param on the request URL) — never let it survive into a traceback
            # via __cause__. The redacted message above already carries what's useful.
            raise GraphAPIError(f"POST {path} -> request failed: {redact(str(exc))}") from None
        if not resp.ok:
            raise GraphAPIError(
                f"POST {path} -> {resp.status_code}: {redact(resp.text)}",
                status_code=resp.status_code,
                **_error_fields(resp.text),
            )
        return resp.json()

    def _get(self, path: str, params: dict) -> dict:
        try:
            resp = self.session.get(f"{self.base}/{path}", params=params, timeout=self.timeout)
        except requests.RequestException as exc:
            raise GraphAPIError(f"GET {path} -> request failed: {redact(str(exc))}") from None
        self._record_usage(resp)
        if not resp.ok:
            raise GraphAPIError(
                f"GET {path} -> {resp.status_code}: {redact(resp.text)}",
                status_code=resp.status_code,
                **_error_fields(resp.text),
            )
        return resp.json()

    def _get_url(self, url: str) -> dict:
        """GET a fully-formed URL, for following a `paging.next` link verbatim.

        Rebuilding the next page from cursors means re-deriving fields, limit and every
        other param correctly; Meta already handed us a URL that encodes all of it. The
        URL carries the access_token, so a failure is redacted like any other.
        """
        try:
            resp = self.session.get(url, timeout=self.timeout)
        except requests.RequestException as exc:
            raise GraphAPIError(f"GET (paged) -> request failed: {redact(str(exc))}") from None
        self._record_usage(resp)
        if not resp.ok:
            raise GraphAPIError(f"GET (paged) -> {resp.status_code}: {redact(resp.text)}")
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

    # Instagram's own limit on a comment body. Checked here rather than left to Meta:
    # an over-length comment comes back as a generic OAuthException that says nothing
    # about length, and by then the post is already live and the reason is a mystery.
    COMMENT_MAX_CHARS = 2200

    def create_comment(self, media_id: str, message: str, token: str) -> str:
        """Post a comment on a published media. Returns the comment id.

        Used for the first comment (hashtags), so this only ever runs AFTER the media
        publishes — see publisher._post_first_comment for why that ordering matters.

        Requires the `instagram_business_manage_comments` scope on the token, which is
        NOT the same scope publishing needs. A token that can publish can still fail
        here, and that failure is the comment's alone: the post stays up.
        """
        # caption_length, not len() — same reason as publisher.py's caption gate: Meta
        # counts UTF-16 code units, so an emoji-dense comment is longer than len() thinks.
        if caption_length(message) > self.COMMENT_MAX_CHARS:
            raise GraphAPIError(
                f"comment is {caption_length(message)} chars, over Instagram's "
                f"{self.COMMENT_MAX_CHARS} limit"
            )
        return self._post(
            f"{media_id}/comments", {"message": message, "access_token": token}
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

    # -- account-level reads (the Insights hub) ----------------------------------------
    # Everything below is READ-ONLY. None of it publishes, so these run even under
    # DRY_RUN — a fresh clone gets a populated hub before it ever posts for real.

    # Fields requested for each post in the account's media list. media_product_type
    # distinguishes FEED / REELS / STORY, which media_type alone does not.
    MEDIA_FIELDS = (
        "id,media_type,media_product_type,permalink,caption,"
        "thumbnail_url,media_url,timestamp,like_count,comments_count"
    )

    def get_user_media(
        self,
        account_id: str,
        token: str,
        *,
        limit: int = 100,
        fields: str | None = None,
        next_url: str | None = None,
    ) -> tuple[list[dict], str | None]:
        """One page of the account's own media. Returns (items, next_page_url).

        This is what makes the hub account-wide rather than scheduler-wide: it lists
        every post on the account, including ones published from the phone and ones
        that predate this install.

        Pass the returned next_page_url back as `next_url` to walk backwards through
        history; None means the last page. 100 is Meta's per-page maximum.
        """
        if next_url:
            data = self._get_url(next_url)
        else:
            data = self._get(
                f"{account_id}/media",
                {
                    "fields": fields or self.MEDIA_FIELDS,
                    "limit": limit,
                    "access_token": token,
                },
            )
        items = data.get("data") or []
        return items, (data.get("paging") or {}).get("next")

    def get_account_profile(self, account_id: str, token: str, fields: str) -> dict:
        """Snapshot fields off the account node itself (followers_count, media_count...).

        These are plain node fields, NOT insights — they are the one part of the account
        picture Meta has never renamed, which is why follower counts are read here rather
        than from the insights endpoint.
        """
        return self._get(account_id, {"fields": fields, "access_token": token})

    def get_account_insights_series(
        self,
        account_id: str,
        token: str,
        metrics: list[str],
        *,
        period: str = "day",
        since: str | None = None,
        until: str | None = None,
    ) -> dict[str, list[tuple[str, int]]]:
        """Day-by-day account insights. Returns {metric: [(end_time, value), ...]}.

        With since/until, one request returns the whole range as a `values` array — which
        is what makes historical backfill affordable. Meta caps a single call at roughly
        30 days, so callers walk the window in chunks rather than asking for two years.
        """
        params: dict = {
            "metric": ",".join(metrics),
            "period": period,
            "access_token": token,
        }
        if since:
            params["since"] = since
        if until:
            params["until"] = until
        data = self._get(f"{account_id}/insights", params)
        out: dict[str, list[tuple[str, int]]] = {}
        for item in data.get("data", []):
            name = item.get("name")
            if not name:
                continue
            out[name] = [
                (v.get("end_time"), v.get("value"))
                for v in (item.get("values") or [])
                if v.get("end_time") is not None
            ]
        return out

    def get_account_insights_total(
        self,
        account_id: str,
        token: str,
        metrics: list[str],
        *,
        period: str = "day",
        since: str | None = None,
        until: str | None = None,
    ) -> dict[str, int | None]:
        """Account insights that require metric_type=total_value.

        Meta split its newer account metrics (accounts_engaged, total_interactions,
        views, likes, saves...) into a different response envelope that returns ONE
        total for the period instead of a per-day series, and rejects the call outright
        if metric_type is missing. Hence two methods rather than one with a flag: the
        caller has to know which shape it is getting, because the meaning differs.
        """
        params: dict = {
            "metric": ",".join(metrics),
            "period": period,
            "metric_type": "total_value",
            "access_token": token,
        }
        if since:
            params["since"] = since
        if until:
            params["until"] = until
        data = self._get(f"{account_id}/insights", params)
        out: dict[str, int | None] = {}
        for item in data.get("data", []):
            name = item.get("name")
            if name:
                out[name] = (item.get("total_value") or {}).get("value")
        return out

    def get_audience_demographics(
        self,
        account_id: str,
        token: str,
        metric: str,
        breakdown: str,
        *,
        timeframe: str = "this_month",
    ) -> dict[str, int]:
        """One demographic breakdown. Returns {dimension: value}, e.g. {"25-34": 412}.

        Meta returns NOTHING for accounts under 100 followers. That is a documented,
        normal state — callers must render it as "not enough followers yet", never as an
        error and never as zeros.
        """
        data = self._get(
            f"{account_id}/insights",
            {
                "metric": metric,
                "period": "lifetime",
                "metric_type": "total_value",
                "breakdown": breakdown,
                "timeframe": timeframe,
                "access_token": token,
            },
        )
        return self._parse_breakdown(data)

    @staticmethod
    def _parse_breakdown(data: dict) -> dict[str, int]:
        """Flatten Meta's nested breakdown envelope to {dimension: value}.

        The shape is three levels deeper than it needs to be:
          data[0].total_value.breakdowns[0].results[]
              = {"dimension_values": ["25-34"], "value": 412}
        dimension_values is a LIST because a breakdown can be compound ("age,gender"
        yields ["25-34", "F"]); joining with " · " keeps one flat key either way.
        """
        out: dict[str, int] = {}
        for item in data.get("data", []):
            total = item.get("total_value") or {}
            for breakdown in total.get("breakdowns") or []:
                for result in breakdown.get("results") or []:
                    dims = result.get("dimension_values") or []
                    value = result.get("value")
                    if dims and value is not None:
                        out[" · ".join(str(d) for d in dims)] = value
        return out

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

    def get_page_totals(self, page_id: str, token: str) -> dict:
        """Point-in-time Page counters from the node itself.

        Separate from the /insights edge on purpose: probing the live Page on 2026-08-23
        showed page_fans, page_impressions and page_impressions_unique are all RETIRED
        (Meta answers "(#100) The value must be a valid insights metric"), while these
        node fields still work. So the follower count has to come from here, not from
        insights the way Instagram's does.
        """
        return self._get(
            page_id, {"fields": "followers_count,fan_count", "access_token": token}
        )

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
        reply_to_id: str | None = None,
        topic_tag: str | None = None,
    ) -> str:
        """Create a Threads media container. Returns the container id.

        media_type is one of:
          TEXT     - requires `text` (max 500 chars), no image_url
          IMAGE    - requires `image_url`, `text` optional
          CAROUSEL - requires `children` (2-20 container ids), `text` optional

        Carousel children are created with is_carousel_item=True beforehand, then their
        ids are passed as `children` to the CAROUSEL parent call.

        `reply_to_id` makes this container a REPLY to an existing thread rather than a
        new top-level post. Threads has no comment edge — a "first comment" here is a
        self-reply, which is a real post in the author's feed, not a hidden comment.
        Only `threads_content_publish` is needed for it (the same scope publishing
        already uses); `threads_manage_replies` governs OTHER people's replies.

        `topic_tag` names the post's ONE topic, WITHOUT the leading '#'. Passing it is
        Meta's preferred method; letting Threads pick the topic out of the text instead
        is documented as "not preferred but kept for backwards compatibility", and it
        rewrites the body — see _topic_tag_for in publisher.py for the full story.
        """
        data = {"media_type": media_type, "access_token": token}
        if reply_to_id is not None:
            data["reply_to_id"] = reply_to_id
        if topic_tag is not None:
            data["topic_tag"] = topic_tag
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

    # -- Threads account-level reads ---------------------------------------------------
    # Separate methods rather than reusing the Instagram ones: Threads uses a different
    # host, a different API version, DIFFERENT EDGE NAMES (/threads, /threads_insights
    # rather than /media, /insights) and its own response envelope. Sharing a method and
    # branching inside it would hide four incompatibilities behind one signature.

    THREADS_MEDIA_FIELDS = (
        "id,media_type,permalink,text,timestamp,thumbnail_url,is_quote_post"
    )

    def get_threads_user_media(
        self,
        user_id: str,
        token: str,
        *,
        limit: int = 100,
        fields: str | None = None,
        next_url: str | None = None,
    ) -> tuple[list[dict], str | None]:
        """One page of the account's Threads posts. Returns (items, next_page_url)."""
        if next_url:
            data = self._get_url(next_url)
        else:
            data = self._get(
                f"{user_id}/threads",
                {
                    "fields": fields or self.THREADS_MEDIA_FIELDS,
                    "limit": limit,
                    "access_token": token,
                },
            )
        items = data.get("data") or []
        return items, (data.get("paging") or {}).get("next")

    def get_threads_user_insights(
        self,
        user_id: str,
        token: str,
        metrics: list[str],
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> dict:
        """Account-level Threads insights (views, likes, replies, followers_count...).

        Reuses _parse_threads_insights because the account edge returns the same
        two-envelope shape the per-post edge does — total_value for lifetime metrics,
        values[] for windowed ones.
        """
        params: dict = {"metric": ",".join(metrics), "access_token": token}
        if since:
            params["since"] = since
        if until:
            params["until"] = until
        return self._parse_threads_insights(self._get(f"{user_id}/threads_insights", params))

    def get_threads_audience_demographics(
        self, user_id: str, token: str, breakdown: str
    ) -> dict[str, int]:
        """Threads follower demographics for one breakdown (country, city, age, gender)."""
        data = self._get(
            f"{user_id}/threads_insights",
            {
                "metric": "follower_demographics",
                "breakdown": breakdown,
                "access_token": token,
            },
        )
        return self._parse_breakdown(data)

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
