# Facebook Pages Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish single-image and multi-photo posts to a Facebook Page, and fetch their metrics, reusing the existing publication lifecycle so every queue control already works for Facebook.

**Architecture:** Three seams in the existing worker. (1) A new `worker/clients.py` selects the Graph API base URL per channel platform (FB always `graph.facebook.com`; IG keeps the install's `META_GRAPH_BASE`). (2) `worker/graph_api.py` gains Facebook Page methods (`/photos`, `/feed` with `attached_media`, post summary + insights). (3) `worker/publisher.py` and `worker/metrics.py` dispatch on `plan["platform"]` / `channel["platform"]`. **No migration** — the schema already allows `platform='facebook'`.

**Tech Stack:** Python 3.11 in the repo-root `.venv`, `requests`, `pytest`. Run tests with `.venv/bin/python -m pytest`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-facebook-pages-adapter-design.md`. Read it before Task 1.
- **No schema migration in this sub-project.** The `channels.platform` CHECK already allows `'facebook'`.
- **No new dependencies.** stdlib + `requests` only.
- **Never log tokens or full API responses containing them.** Log ids and short error strings only.
- **Never hardcode a rate limit.** FB Pages have no `content_publishing_limit` endpoint — the IG quota gate is *skipped* for FB, not replaced by a constant.
- **Failures stay visible and independent:** one publication failing must never affect another. Reuse the existing `_mark_failure` retry/backoff path.
- **Metrics are fail-soft:** Meta deprecated many post-insight metric names on 2026-06-15 and is still churning them. Stable engagement counts (reactions/comments/shares) are the primary signal; reach/views is best-effort — an invalid-metric error must store null and still record the stable counts.
- Preserve existing behavior for Instagram exactly. Every currently-passing test must still pass.
- Run the full worker suite after every task: `cd <repo root> && .venv/bin/python -m pytest worker/tests -q`
- Commit after each task.

---

### Task 1: Per-platform Graph client selection

**Files:**
- Create: `worker/clients.py`
- Create: `worker/tests/test_clients.py`
- Modify: `worker/run.py` (`run_once` signature + publish loop; `main`)

**Interfaces:**
- Consumes: `worker.config.Config` (fields `graph_version`, `graph_base`), `worker.graph_api.GraphClient`.
- Produces:
  - `FACEBOOK_BASE = "https://graph.facebook.com"`
  - `base_url_for(platform: str, config: Config) -> str`
  - `class ClientRegistry: __init__(self, config: Config, factory=None)`, `for_platform(self, platform: str) -> object`
  - `run_once(conn, config, client, *, client_for=None, now=None, logger=None, sleep_fn=time.sleep) -> int` — new optional keyword `client_for: Callable[[str], object] | None`. When `None`, `client` is used for everything (preserves all existing tests).

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_clients.py`:

```python
from worker.clients import FACEBOOK_BASE, ClientRegistry, base_url_for


def test_facebook_always_uses_facebook_base_even_on_an_ig_login_install(config):
    # An install configured for the Instagram-Login path must still reach FB Pages
    # on graph.facebook.com — the base is a per-platform fact, not a per-install one.
    config.graph_base = "https://graph.instagram.com"
    assert base_url_for("facebook", config) == FACEBOOK_BASE


def test_instagram_uses_the_installs_configured_base(config):
    config.graph_base = "https://graph.instagram.com"
    assert base_url_for("instagram", config) == "https://graph.instagram.com"


def test_unknown_platform_falls_back_to_the_installs_base(config):
    assert base_url_for("mastodon", config) == config.graph_base


def test_registry_builds_one_client_per_base_and_caches_it(config):
    config.graph_base = "https://graph.instagram.com"
    built = []

    def factory(version, base_url):
        built.append(base_url)
        return ("client", base_url)

    reg = ClientRegistry(config, factory=factory)
    ig1 = reg.for_platform("instagram")
    ig2 = reg.for_platform("instagram")
    fb = reg.for_platform("facebook")

    assert ig1 is ig2                      # cached, not rebuilt
    assert ig1 == ("client", "https://graph.instagram.com")
    assert fb == ("client", FACEBOOK_BASE)
    assert built == ["https://graph.instagram.com", FACEBOOK_BASE]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_clients.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'worker.clients'`

- [ ] **Step 3: Write `worker/clients.py`**

```python
"""Which Graph API host to talk to, per channel platform.

META_GRAPH_BASE is a per-INSTALL setting, but the correct host is really a per-PLATFORM
fact: Facebook Pages always live on graph.facebook.com, while Instagram may be reached
via graph.facebook.com (Facebook-Login path) or graph.instagram.com (Instagram-Login
path) depending on how this install is set up. So FB pins its own host and IG keeps
whatever the install configured — which lets one install mix IG and FB channels.

Clients are cached per base URL: they hold a requests.Session, so reusing them keeps
connection pooling and avoids rebuilding one per publication.
"""

from __future__ import annotations

from typing import Callable

from .config import Config
from .graph_api import GraphClient

FACEBOOK_BASE = "https://graph.facebook.com"


def base_url_for(platform: str, config: Config) -> str:
    """The Graph API base URL to use for a channel on `platform`."""
    if platform == "facebook":
        return FACEBOOK_BASE
    return config.graph_base


class ClientRegistry:
    """Lazily builds and caches one Graph client per base URL."""

    def __init__(self, config: Config, factory: Callable[[str, str], object] | None = None) -> None:
        self._config = config
        self._factory = factory or (
            lambda version, base_url: GraphClient(version, base_url=base_url)
        )
        self._cache: dict[str, object] = {}

    def for_platform(self, platform: str):
        base = base_url_for(platform, self._config)
        if base not in self._cache:
            self._cache[base] = self._factory(self._config.graph_version, base)
        return self._cache[base]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest worker/tests/test_clients.py -q`
Expected: PASS (4 passed)

- [ ] **Step 5: Wire it into `worker/run.py`**

In `run_once`, change the signature to add `client_for` and resolve a per-publication client. Replace the signature (currently line 32):

```python
def run_once(conn, config: Config, client, *, client_for=None, now=None, logger=None,
             sleep_fn=time.sleep) -> int:
```

Immediately after the docstring, add the resolver:

```python
    # A channel's platform decides which Graph host to use (see clients.base_url_for).
    # Without a resolver (tests, --once with a single client) everything uses `client`.
    pick_client = client_for or (lambda _platform: client)
```

In the publish loop, replace the `publish_one(...)` call (currently lines 110-112) so it uses the resolved client:

```python
        for pub in due:
            load_env(override=True)
            if kill_switch_active():
                if logger:
                    logger.warning("KILL_SWITCH flipped mid-batch — stopping.")
                break
            channel = db.get_channel(conn, pub["channel_id"])
            pub_client = pick_client(channel["platform"]) if channel else client
            publish_one(conn, pub, config, pub_client, dry_run=dry_run,
                        asset_base_url=asset_base_url, now=now,
                        logger=logger, sleep_fn=sleep_fn)
            processed += 1
```

`publish_one` already loads the channel itself; this extra `get_channel` is one cheap
indexed lookup and keeps `publish_one`'s signature unchanged.

**Leave the `run_metrics(...)` call on line 118 alone for now.** It only grows a
`client_for` keyword once `run_metrics` accepts one, which happens in Task 4 — passing it
today would raise `TypeError` and break the suite.

In `main()`, build the registry and pass both (replace lines 144-158's client construction):

```python
def main() -> int:
    config = Config.from_env()
    logger = configure_logging(config.database_path.parent / "logs")
    registry = ClientRegistry(config)
    # Default client for code paths that don't know a platform yet; per-publication
    # selection happens inside run_once via client_for.
    client = registry.for_platform("instagram")

    if "--once" in sys.argv:
        conn = db.connect(config.database_path)
        try:
            n = run_once(conn, config, client, client_for=registry.for_platform, logger=logger)
            logger.info("Processed %d publication(s).", n)
        finally:
            conn.close()
        return 0

    run_forever(config, client, logger, client_for=registry.for_platform)
    return 0
```

Add the import at the top of `run.py` (next to the other relative imports):

```python
from .clients import ClientRegistry
```

Update `run_forever` to accept and forward it (currently line 122):

```python
def run_forever(config: Config, client, logger, *, client_for=None) -> None:
```
and inside its loop change the call to:
```python
                run_once(conn, config, client, client_for=client_for, logger=logger)
```

- [ ] **Step 6: Run the full suite**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS — all pre-existing tests plus the 4 new ones. If `test_run.py` fails, you changed a signature incompatibly; `client_for=None` must keep old behavior.

- [ ] **Step 7: Commit**

```bash
git add worker/clients.py worker/tests/test_clients.py worker/run.py
git commit -m "feat(worker): select the Graph API host per channel platform"
```

---

### Task 2: Facebook Page methods on the Graph client

**Files:**
- Modify: `worker/graph_api.py`
- Create: `worker/tests/test_graph_api_facebook.py`

**Interfaces:**
- Consumes: the existing `GraphClient._post` / `_get` helpers and `GraphAPIError`.
- Produces (called by Tasks 3 and 4):
  - `create_page_photo(self, page_id: str, image_url: str, token: str, *, caption: str | None = None, published: bool = True) -> dict` — returns the raw dict (has `id`, and `post_id` when published).
  - `create_page_feed_post(self, page_id: str, token: str, *, message: str | None = None, attached_media: list[str] | None = None) -> str` — returns the feed post id.
  - `get_page_post_summary(self, post_id: str, token: str) -> dict` — returns a subset of `{"fb_reactions": int, "fb_comments": int, "fb_shares": int}`.
  - `get_page_post_insights(self, post_id: str, token: str, metrics: list[str]) -> dict` — `{metric_name: value}`.

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_graph_api_facebook.py`:

```python
"""Facebook Page publishing calls: exact endpoint paths and parameter encoding.

attached_media has to be sent as indexed, JSON-encoded form fields
(attached_media[0]={"media_fbid":"1"}), which is the fiddly part worth pinning down.
"""

import json

import pytest

from worker.graph_api import GraphAPIError, GraphClient


class FakeResponse:
    def __init__(self, payload, ok=True, status_code=200, text=""):
        self._payload = payload
        self.ok = ok
        self.status_code = status_code
        self.text = text

    def json(self):
        return self._payload


class FakeSession:
    """Records requests and replays queued responses."""

    def __init__(self, responses=None):
        self.posts = []
        self.gets = []
        self._responses = list(responses or [])

    def _next(self):
        return self._responses.pop(0) if self._responses else FakeResponse({"id": "x"})

    def post(self, url, data=None, timeout=None):
        self.posts.append((url, data))
        return self._next()

    def get(self, url, params=None, timeout=None):
        self.gets.append((url, params))
        return self._next()


def client(responses=None):
    return GraphClient("v25.0", session=FakeSession(responses),
                       base_url="https://graph.facebook.com")


def test_published_photo_posts_url_and_caption_to_the_photos_edge():
    c = client([FakeResponse({"id": "photo-1", "post_id": "page_1_post_1"})])
    out = c.create_page_photo("PAGE1", "https://x.test/a.jpg", "tok", caption="hi")

    url, data = c.session.posts[0]
    assert url == "https://graph.facebook.com/v25.0/PAGE1/photos"
    assert data["url"] == "https://x.test/a.jpg"
    assert data["caption"] == "hi"
    assert data["published"] == "true"
    assert data["access_token"] == "tok"
    assert out == {"id": "photo-1", "post_id": "page_1_post_1"}


def test_unpublished_photo_sends_published_false_and_no_caption():
    # Carousel children are uploaded unpublished; the text belongs on the feed post,
    # so a caption here would be dead weight (and shows up nowhere).
    c = client([FakeResponse({"id": "photo-1"})])
    c.create_page_photo("PAGE1", "https://x.test/a.jpg", "tok",
                        caption="ignored", published=False)

    _url, data = c.session.posts[0]
    assert data["published"] == "false"
    assert "caption" not in data


def test_feed_post_encodes_attached_media_as_indexed_json_fields():
    c = client([FakeResponse({"id": "page_1_post_9"})])
    post_id = c.create_page_feed_post("PAGE1", "tok", message="two photos",
                                      attached_media=["11", "22"])

    url, data = c.session.posts[0]
    assert url == "https://graph.facebook.com/v25.0/PAGE1/feed"
    assert data["message"] == "two photos"
    assert json.loads(data["attached_media[0]"]) == {"media_fbid": "11"}
    assert json.loads(data["attached_media[1]"]) == {"media_fbid": "22"}
    assert post_id == "page_1_post_9"


def test_post_summary_flattens_reactions_comments_and_shares():
    c = client([FakeResponse({
        "reactions": {"summary": {"total_count": 12}},
        "comments": {"summary": {"total_count": 3}},
        "shares": {"count": 2},
        "id": "page_1_post_1",
    })])
    out = c.get_page_post_summary("page_1_post_1", "tok")

    _url, params = c.session.gets[0]
    assert "reactions.summary(total_count)" in params["fields"]
    assert "comments.summary(total_count)" in params["fields"]
    assert "shares" in params["fields"]
    assert out == {"fb_reactions": 12, "fb_comments": 3, "fb_shares": 2}


def test_post_summary_omits_fields_facebook_didnt_return():
    # A post with zero shares has no "shares" key at all — that must not become 0,
    # and must not blow up.
    c = client([FakeResponse({"reactions": {"summary": {"total_count": 1}}})])
    assert c.get_page_post_summary("p1", "tok") == {"fb_reactions": 1}


def test_page_post_insights_parses_the_standard_insights_shape():
    c = client([FakeResponse({"data": [
        {"name": "post_total_media_view_unique", "values": [{"value": 40}]},
    ]})])
    out = c.get_page_post_insights("p1", "tok", ["post_total_media_view_unique"])

    _url, params = c.session.gets[0]
    assert params["metric"] == "post_total_media_view_unique"
    assert out == {"post_total_media_view_unique": 40}


def test_a_failed_call_raises_graph_api_error():
    c = client([FakeResponse({}, ok=False, status_code=400, text="(#100) invalid metric")])
    with pytest.raises(GraphAPIError):
        c.get_page_post_insights("p1", "tok", ["post_impressions"])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_graph_api_facebook.py -q`
Expected: FAIL with `AttributeError: 'GraphClient' object has no attribute 'create_page_photo'`

- [ ] **Step 3: Implement the Facebook methods**

In `worker/graph_api.py`, add `import json` under `from __future__ import annotations` (above `import requests`).

Extend the module docstring's first line to mention both platforms:

```python
"""Meta Graph API client for Instagram and Facebook Page content publishing.
```

Refactor the insights parsing out of `get_media_insights` so both platforms share it. Replace the body of `get_media_insights` (lines 99-108) with:

```python
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
```

Then append the Facebook section at the end of the class:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest worker/tests/test_graph_api_facebook.py -q`
Expected: PASS (7 passed)

Then the full suite (the `get_media_insights` refactor must not change IG behavior):
Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/graph_api.py worker/tests/test_graph_api_facebook.py
git commit -m "feat(worker): add Facebook Page publish + metrics calls to the Graph client"
```

---

### Task 3: Publish to a Facebook Page

**Files:**
- Modify: `worker/publisher.py`
- Modify: `worker/tests/conftest.py` (extend `FakeGraphClient` + `make_publication`)
- Modify: `worker/tests/test_publisher.py` (add Facebook cases)

**Interfaces:**
- Consumes: `GraphClient.create_page_photo(...) -> dict` and `create_page_feed_post(...) -> str` from Task 2.
- Produces: for Task 4 and reviewers — `_build_plan` now emits the key **`account_id`** (was `ig_user_id`); `publish_one` skips the IG quota gate when `plan["platform"] == "facebook"`.

- [ ] **Step 1: Check for existing uses of the key you're renaming**

Run: `grep -rn "ig_user_id" worker/ dashboard/ docs/ --include=*.py --include=*.ts --include=*.tsx --include=*.md`
Expected: hits in `worker/graph_api.py` (IG method *parameter* names — leave those alone), `worker/publisher.py`, and possibly `worker/tests/`. Only the **plan dict key** is being renamed. If a test asserts on `plan["ig_user_id"]`, update it in Step 4.

- [ ] **Step 2: Extend the test fixtures**

In `worker/tests/conftest.py`, add Facebook methods to `FakeGraphClient` (after `publish_container`, inside the class):

```python
    # -- Facebook Page surface -----------------------------------------------------
    def create_page_photo(self, page_id, image_url, token, *, caption=None, published=True):
        self.calls.append(("page_photo" if published else "page_child", image_url))
        if "page_photo" in self.fail_on:
            raise RuntimeError("page photo boom")
        self._n += 1
        if published:
            return {"id": f"photo-{self._n}", "post_id": f"page_{self._n}"}
        return {"id": f"photo-{self._n}"}

    def create_page_feed_post(self, page_id, token, *, message=None, attached_media=None):
        self.calls.append(("page_feed", tuple(attached_media or ())))
        if "page_feed" in self.fail_on:
            raise RuntimeError("page feed boom")
        self._n += 1
        return f"page_{self._n}"

    def get_page_post_summary(self, post_id, token):
        self.calls.append(("page_summary", post_id))
        if "page_summary" in self.fail_on:
            raise RuntimeError("summary boom")
        return dict(self.page_summary)

    def get_page_post_insights(self, post_id, token, metrics):
        self.calls.append(("page_insights", post_id))
        if "page_insights" in self.fail_on:
            raise RuntimeError("(#100) invalid metric")
        return dict(self.page_insights)
```

And extend `FakeGraphClient.__init__` to hold the new canned payloads — replace its signature/body head:

```python
    def __init__(self, limit=(0, 50, 86400), fail_on=None, insights=None,
                 page_summary=None, page_insights=None):
        self.calls = []
        self.limit = limit
        self.fail_on = set(fail_on or [])
        self.insights = insights or {
            "reach": 100, "likes": 10, "comments": 2, "saved": 5, "shares": 1,
        }
        self.page_summary = page_summary if page_summary is not None else {
            "fb_reactions": 12, "fb_comments": 3, "fb_shares": 2,
        }
        self.page_insights = page_insights if page_insights is not None else {
            "post_total_media_view_unique": 40,
        }
        self._n = 0
```

Then let `make_publication` create Facebook channels. Change its signature and the channel INSERT:

```python
    def _make(post_type="single", n_assets=1, public_url="https://assets.test/a.jpg",
              scheduled_offset_min=-1, with_token=True, now=None,
              platform="instagram", remote_account_id=None):
        if remote_account_id is None:
            remote_account_id = "PAGE1" if platform == "facebook" else "178414"
        cur = conn.execute(
            """INSERT INTO channels (platform, account_name, remote_account_id, access_token)
               VALUES (?, ?, ?, ?)""",
            (platform,
             "Test FB Page" if platform == "facebook" else "Test IG",
             remote_account_id,
             "tok-123" if with_token else None),
        )
```

- [ ] **Step 3: Write the failing tests**

Append to `worker/tests/test_publisher.py`:

```python
def test_facebook_single_publishes_in_one_call_and_stores_the_feed_post_id(
    conn, config, fake_client, make_publication
):
    pub = make_publication(platform="facebook")
    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "posted"
    kinds = [k for k, _ in fake_client.calls]
    # No "limit": Facebook Pages have no content_publishing_limit endpoint.
    # No container/status polling either — a Page photo publishes in one call.
    assert kinds == ["page_photo"]
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "posted"
    # post_id (the feed post), NOT id (the photo) — insights are read against the post.
    assert row["remote_post_id"] == "page_1"


def test_facebook_carousel_uploads_unpublished_photos_then_one_feed_post(
    conn, config, fake_client, make_publication
):
    pub = make_publication(post_type="carousel", n_assets=3, platform="facebook")
    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "posted"
    kinds = [k for k, _ in fake_client.calls]
    assert kinds == ["page_child", "page_child", "page_child", "page_feed"]
    # The feed post attaches exactly the media_fbids returned by the uploads.
    attached = [arg for k, arg in fake_client.calls if k == "page_feed"][0]
    assert attached == ("photo-1", "photo-2", "photo-3")
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["remote_post_id"] == "page_4"


def test_facebook_publish_failure_is_visible_and_retried(
    conn, config, fake_client, make_publication
):
    pub = make_publication(platform="facebook")
    fake_client.fail_on.add("page_photo")
    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "retry_scheduled"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "scheduled"
    assert row["attempt_count"] == 1
    assert "page photo boom" in row["last_error"]
    assert row["next_retry_at"] is not None


def test_facebook_dry_run_publishes_nothing(
    conn, config, fake_client, make_publication
):
    pub = make_publication(platform="facebook")
    out = publish_one(conn, pub, config, fake_client, dry_run=True)

    assert out.result == "dry_run"
    assert fake_client.calls == []
    assert out.plan["platform"] == "facebook"
    assert out.plan["account_id"] == "PAGE1"
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_publisher.py -q`
Expected: FAIL — the FB cases fail (the publisher still runs the IG path, so it calls `create_image_container` / the quota gate). Pre-existing IG tests still pass.

- [ ] **Step 5: Implement the Facebook publish path**

In `worker/publisher.py`:

**(a)** Rename the plan key in `_build_plan` (line 145) from `"ig_user_id"` to `"account_id"`, and update its comment:

```python
    return {
        "platform": channel["platform"],
        "account": channel["account_name"],
        # IG user id, or FB Page id — whichever this channel's platform uses.
        "account_id": channel["remote_account_id"],
        "post_type": post["post_type"],
        "caption": caption,
        "first_comment": post["first_comment"],
        "asset_urls": asset_urls,
    }
```

**(b)** Update the two IG helpers to read the new key — in `_publish_single` (line 168) and `_publish_carousel` (line 178) replace `ig = plan["ig_user_id"]` with:

```python
    ig = plan["account_id"]
```

**(c)** Add the Facebook publishers after `_publish_carousel`:

```python
def _publish_fb_single(client, plan, token) -> str:
    """One call, no container polling. Returns the FEED POST id (what insights use)."""
    res = client.create_page_photo(
        plan["account_id"], plan["asset_urls"][0], token, caption=plan["caption"]
    )
    # Prefer post_id (the feed post). Fall back to the photo id so a response missing
    # post_id still records something we can look up, rather than crashing.
    return res.get("post_id") or res["id"]


def _publish_fb_multi(client, plan, token) -> str:
    """Upload each photo unpublished, then attach them all to one feed post."""
    page = plan["account_id"]
    media_fbids = []
    for url in plan["asset_urls"]:
        res = client.create_page_photo(page, url, token, published=False)
        media_fbids.append(res["id"])
    return client.create_page_feed_post(
        page, token, message=plan["caption"], attached_media=media_fbids
    )
```

**(d)** Skip the IG-only quota gate for Facebook. Wrap step 3 (lines 255-270) in a platform check — replace the section header and indent the existing block:

```python
    # 3. Rate-limit gate: read Meta's REAL quota, cache it, refuse if exhausted.
    #    Instagram only — Facebook Pages expose no content_publishing_limit endpoint,
    #    and inventing a hardcoded number here would be worse than not gating.
    if plan["platform"] == "instagram":
        try:
            usage, total, duration = client.get_content_publishing_limit(ig, token)
            db.record_publish_limit(conn, channel["id"], usage, total, duration, _iso(now))
            if usage is not None and total is not None and usage >= total:
                retry_at = _iso(now + timedelta(seconds=config.rate_limit_backoff_seconds))
                db.update_publication(
                    conn, pub["id"],
                    status="scheduled", next_retry_at=retry_at,
                    last_error=f"rate limit reached ({usage}/{total})", updated_at=_iso(now),
                )
                log(f"rate limit reached {usage}/{total}; deferring to {retry_at}")
                return PublishOutcome("rate_limited", f"quota {usage}/{total}")
        except Exception as exc:  # noqa: BLE001 — a quota-check failure is retryable
            log(f"quota check failed: {exc}")
            return _mark_failure(conn, pub, config, now, f"quota check: {exc}", terminal=False)
```

Also update the local variable above it (line 253) from `ig = plan["ig_user_id"]` to:

```python
    ig = plan["account_id"]
```

**(e)** Dispatch on platform in step 4 (lines 274-278) — replace the try block's body:

```python
    try:
        if plan["platform"] == "facebook":
            if plan["post_type"] == "single":
                media_id = _publish_fb_single(client, plan, token)
            else:
                media_id = _publish_fb_multi(client, plan, token)
        elif plan["post_type"] == "single":
            media_id = _publish_single(client, plan, token, config, sleep_fn)
        else:
            media_id = _publish_carousel(client, plan, token, config, sleep_fn)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS — the 4 new FB cases plus every pre-existing test.

- [ ] **Step 7: Commit**

```bash
git add worker/publisher.py worker/tests/conftest.py worker/tests/test_publisher.py
git commit -m "feat(worker): publish single + multi-photo posts to a Facebook Page"
```

---

### Task 4: Facebook metrics, fail-soft

**Files:**
- Modify: `worker/metrics.py`
- Modify: `worker/config.py` (one configurable metric-name list)
- Modify: `worker/run.py` (pass `client_for` into `run_metrics` — the deferred edit from Task 1 Step 5)
- Modify: `worker/tests/test_metrics.py`
- Modify: `.env.example` (document the new setting)

**Interfaces:**
- Consumes: `get_page_post_summary` / `get_page_post_insights` (Task 2); `ClientRegistry.for_platform` (Task 1).
- Produces: `run_metrics(conn, config, client, now, logger=None, client_for=None) -> int`.

- [ ] **Step 1: Write the failing tests**

Append to `worker/tests/test_metrics.py`:

```python
def _posted_fb_pub(conn, make_publication, now):
    """A Facebook publication already posted, due for a metrics fetch."""
    pub = make_publication(platform="facebook", now=now)
    conn.execute(
        """UPDATE publications
              SET status='posted', is_dry_run=0, remote_post_id='page_1',
                  published_at=?
            WHERE id=?""",
        (now.isoformat(), pub["id"]),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM publications WHERE id = ?", (pub["id"],)
    ).fetchone()


def test_facebook_metrics_use_the_page_endpoints_and_map_to_our_columns(
    conn, config, fake_client, make_publication
):
    now = datetime.now(timezone.utc)
    pub = _posted_fb_pub(conn, make_publication, now)

    assert run_metrics(conn, config, fake_client, now) == 1

    kinds = [k for k, _ in fake_client.calls]
    assert "page_summary" in kinds
    assert "insights" not in kinds  # the IG media-insights call must not be used

    row = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (pub["id"],)
    ).fetchone()
    assert row["likes"] == 12       # reactions total
    assert row["comments"] == 3
    assert row["shares"] == 2
    assert row["reach"] == 40       # post_total_media_view_unique
    assert row["saves"] is None     # an Instagram-only concept


def test_a_deprecated_insight_metric_still_records_the_stable_counts(
    conn, config, fake_client, make_publication
):
    # Meta retired a batch of post-insight names on 2026-06-15 and keeps changing them.
    # An invalid-metric error must NOT cost us the reactions/comments/shares we can get.
    now = datetime.now(timezone.utc)
    pub = _posted_fb_pub(conn, make_publication, now)
    fake_client.fail_on.add("page_insights")

    assert run_metrics(conn, config, fake_client, now) == 1

    row = conn.execute(
        "SELECT * FROM post_metrics WHERE publication_id = ?", (pub["id"],)
    ).fetchone()
    assert row["likes"] == 12
    assert row["comments"] == 3
    assert row["reach"] is None      # unavailable, stored as unknown rather than 0


def test_losing_the_stable_counts_skips_the_snapshot(
    conn, config, fake_client, make_publication
):
    now = datetime.now(timezone.utc)
    pub = _posted_fb_pub(conn, make_publication, now)
    fake_client.fail_on.add("page_summary")

    assert run_metrics(conn, config, fake_client, now) == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM post_metrics WHERE publication_id = ?", (pub["id"],)
    ).fetchone()[0] == 0


def test_metrics_pick_the_client_for_each_channels_platform(
    conn, config, fake_client, make_publication
):
    now = datetime.now(timezone.utc)
    _posted_fb_pub(conn, make_publication, now)
    seen = []

    def client_for(platform):
        seen.append(platform)
        return fake_client

    assert run_metrics(conn, config, fake_client, now, client_for=client_for) == 1
    assert seen == ["facebook"]
```

Make sure `test_metrics.py` has the imports these need (`datetime`, `timezone`, `run_metrics`) — it already imports what the existing tests use; add any missing name to the existing import lines.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_metrics.py -q`
Expected: FAIL — `run_metrics` currently calls `get_media_insights` for every platform and has no `client_for` keyword (`TypeError`).

- [ ] **Step 3: Add the configurable metric list**

In `worker/config.py`, add a field to `Config` right after `metrics_min_interval_hours: int = 6`:

```python
    # Facebook Page-post insight metric names. Meta deprecated a large batch on
    # 2026-06-15 and keeps renaming them, so this is configurable and read as
    # best-effort: if the name is invalid we store null instead of failing.
    fb_post_insight_metrics: str = "post_total_media_view_unique"
```

And in `from_env()`, after the `metrics_min_interval_hours=...` line:

```python
            fb_post_insight_metrics=os.environ.get(
                "FB_POST_INSIGHT_METRICS", "post_total_media_view_unique"
            ),
```

In `.env.example`, under the `# ---- Metrics ----` section, append:

```
# Facebook Page-post insight metric(s) for reach/views, comma-separated. Meta deprecated
# many of these on 2026-06-15 and keeps renaming them, so it's configurable here and read
# as BEST-EFFORT: an invalid name just stores a blank reach, it never fails the fetch.
# Reactions, comments and shares don't depend on this — they always work.
FB_POST_INSIGHT_METRICS=post_total_media_view_unique
```

- [ ] **Step 4: Implement the Facebook metrics path**

In `worker/metrics.py`:

**(a)** Extend `COLUMN_MAP` (line 23) with the Facebook names so `_record` needs no changes:

```python
# Map insight names -> our post_metrics columns.
COLUMN_MAP = {
    # Instagram media insights
    "reach": "reach",
    "impressions": "impressions",
    "likes": "likes",
    "comments": "comments",
    "saved": "saves",
    "shares": "shares",
    "video_views": "video_views",
    "plays": "video_views",
    # Facebook Page posts: stable edge summaries...
    "fb_reactions": "likes",
    "fb_comments": "comments",
    "fb_shares": "shares",
    # ...plus best-effort insight names for reach/views (see Config.fb_post_insight_metrics).
    "post_total_media_view_unique": "reach",
    "post_impressions_unique": "reach",
    "post_impressions": "impressions",
}
```

**(b)** Add the two fetchers above `run_metrics`:

```python
def _fetch_instagram(client, remote_post_id: str, token: str, config, logger, pub_id) -> dict:
    return client.get_media_insights(remote_post_id, token, REQUESTED_METRICS)


def _fetch_facebook(client, remote_post_id: str, token: str, config, logger, pub_id) -> dict:
    """Stable counts first, then reach/views as best-effort.

    Reactions/comments/shares are plain edge summaries and are required — if they fail,
    the caller skips this snapshot. The insights call is the fragile one (Meta keeps
    retiring metric names), so a failure there only costs us reach: we log it and record
    the counts we did get.
    """
    summary = client.get_page_post_summary(remote_post_id, token)
    metrics = [m.strip() for m in config.fb_post_insight_metrics.split(",") if m.strip()]
    insights: dict = {}
    if metrics:
        try:
            insights = client.get_page_post_insights(remote_post_id, token, metrics)
        except Exception as exc:  # noqa: BLE001 — best-effort by design
            if logger:
                logger.info(
                    "[metrics pub %s] Facebook reach unavailable (%s): %s",
                    pub_id, ",".join(metrics), exc,
                )
    return {**summary, **insights}


_FETCHERS = {"instagram": _fetch_instagram, "facebook": _fetch_facebook}
```

**(c)** Rewrite `run_metrics`'s signature and per-publication body to select platform + client. Replace lines 87-111 through the fetch:

```python
def run_metrics(conn, config: Config, client, now, logger=None, client_for=None) -> int:
    """Fetch + store metrics for all due publications. Returns count fetched."""
    now_iso = now.isoformat()
    pick_client = client_for or (lambda _platform: client)
    due = publications_needing_metrics(
        conn, now, config.metrics_max_age_days, config.metrics_min_interval_hours
    )
    fetched = 0
    for pub in due:
        was_flagged = pub["metrics_refresh_requested_at"] is not None
        try:
            channel = conn.execute(
                "SELECT access_token, platform FROM channels WHERE id = ?",
                (pub["channel_id"],),
            ).fetchone()
            token = channel["access_token"] if channel else None
            if not token:
                continue
            platform = channel["platform"]
            fetch = _FETCHERS.get(platform)
            if fetch is None:
                if logger:
                    logger.info(
                        "[metrics pub %s] no metrics adapter for platform '%s'",
                        pub["id"], platform,
                    )
                continue
            try:
                insights = fetch(
                    pick_client(platform), pub["remote_post_id"], token,
                    config, logger, pub["id"],
                )
            except Exception as exc:  # noqa: BLE001 — a metrics fetch failure is non-fatal
                if logger:
                    logger.info("[metrics pub %s] fetch failed: %s", pub["id"], exc)
                continue
            _record(conn, pub["id"], now_iso, insights)
            fetched += 1
        finally:
```

(The `finally:` block that clears `metrics_refresh_requested_at`, and the trailing log + `return fetched`, stay exactly as they are.)

**(d)** Update the module docstring's opening to say it covers both platforms:

```python
"""Metrics fetch job (Instagram media insights + Facebook Page-post counts).
```

**(e)** Now do Task 1's deferred edit — in `worker/run.py`, change the `run_metrics` call (line 118) to forward the resolver:

```python
    run_metrics(conn, config, client, now, logger=logger, client_for=client_for)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS — the 4 new metrics cases plus everything before.

- [ ] **Step 6: Commit**

```bash
git add worker/metrics.py worker/config.py worker/run.py worker/tests/test_metrics.py .env.example
git commit -m "feat(worker): fetch Facebook Page post metrics, fail-soft on deprecated insights"
```

---

### Task 5: Docs + end-to-end dry-run verification

**Files:**
- Modify: `docs/meta-setup.md` (Facebook Page section)
- Modify: `reference.md` (verified FB publish + metrics facts)
- Modify: `docs/tasks.md` (mark the sub-project done)
- Read: `dashboard/components/channel-form.tsx` (confirm a FB channel can be created as-is)

- [ ] **Step 1: Confirm the dashboard can already create a Facebook channel**

Run: `grep -n "facebook\|linked_page_id\|Page id" dashboard/components/channel-form.tsx`
Expected: a `<option value="facebook">Facebook Page</option>`, and a label that switches to "Page id" for Facebook. Confirm no code change is needed to enter a Page id + Page token. If the form blocks Facebook in any way, note it and add the smallest fix.

- [ ] **Step 2: Add the Facebook Page setup guide**

In `docs/meta-setup.md`, add a section at the end. Keep the plain, step-by-step voice of the existing file:

```markdown
## Adding a Facebook Page

Publishing to your own Page works with your app in **Development mode** — no App Review —
as long as you're an **admin** on both the app and the Page. Same arrangement as Instagram.

1. **Set the API host.** In `.env`, make sure `META_GRAPH_BASE=https://graph.facebook.com`.
   (Facebook Pages always use this host. If your Instagram channel is on the
   Instagram-Login path, leave your IG setting alone — the worker picks the right host
   per channel automatically.)
2. **Give your app the permissions.** In the Graph API Explorer, pick your app and request
   `pages_show_list`, `pages_read_engagement`, and `pages_manage_posts`.
3. **Get your Page id and a Page access token.** Call `GET /me/accounts` in the Explorer.
   Each entry has the Page's `id` and an `access_token` — that token is the *Page* token,
   which is what SocialScheduler needs (a personal user token will not publish).
4. **Make the token long-lived.** Short-lived Page tokens expire in about an hour. Exchange
   yours for a long-lived one, then re-run step 3 to get a Page token derived from it:
   `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<SHORT_TOKEN>`
5. **Add the channel.** In the dashboard: **Channels → Add channel**, platform
   **Facebook Page**, put the Page id in the id field and the long-lived Page token in the
   token field.
6. **Verify without posting.** Run `python3 -m worker.preflight` — it checks credentials and
   publishes nothing. Then schedule a post with `DRY_RUN=1` and confirm the worker logs the
   plan. Only then set `DRY_RUN=0` for a real post.

**What gets published.** A single-image post goes up in one call. A multi-image post uploads
each photo unpublished, then attaches them to one feed post (Facebook's equivalent of a
carousel). Videos, Reels and Stories aren't supported yet.

**About the numbers.** Reactions, comments and shares are always available. Reach/views
depends on a Facebook insights metric name that Meta deprecated a batch of in June 2026 and
keeps changing — if it's unavailable, reach shows blank and everything else still works. You
can point it at a different metric with `FB_POST_INSIGHT_METRICS` in `.env`.
```

- [ ] **Step 3: Record the verified API facts in `reference.md`**

Add to `reference.md`, matching its existing "verified on <date>" style:

```markdown
### Facebook Pages publishing (verified 2026-07-23)
- Single photo: `POST /{page-id}/photos` with `url`, `caption`, `published=true`. The response
  carries both `id` (photo) and **`post_id`** (the feed post) — store `post_id`, since insights
  are read against the post.
- Multi-photo: upload each with `published=false`, collect each `id`, then
  `POST /{page-id}/feed` with `message` + `attached_media[i]={"media_fbid": <id>}`
  (indexed JSON fields on a form-encoded request). Photos and videos can't be mixed this way.
- **No container/status polling** and **no `content_publishing_limit`** on Pages — the IG quota
  gate is skipped for Facebook rather than replaced with a hardcoded number.
- Requires a **Page** access token (`pages_manage_posts`); works on your own Page with the app
  in Development mode + an admin role, no App Review.
- Metrics: reactions/comments/shares come from edge summaries on the post
  (`reactions.summary(total_count)`, `comments.summary(total_count)`, `shares`) and are stable.
  Post **insights** metric names are volatile — Meta deprecated a large batch on **2026-06-15**
  (reach/impressions moving to "views"/"unique media viewers"), so reach is fetched best-effort
  via `FB_POST_INSIGHT_METRICS` and stored null when the name is rejected.
```

- [ ] **Step 4: Verify the whole worker end-to-end in dry-run**

Run the full suite plus a real dry-run publish against the live dev database, using a
throwaway Facebook channel that is deleted afterward. Use the repo venv.

```bash
.venv/bin/python -m pytest worker/tests -q
```
Expected: all green.

Then a scripted dry-run (writes to the real dev DB, then cleans up — **do not** leave test rows behind):

```bash
.venv/bin/python - <<'PY'
import sqlite3, datetime as dt
from worker import db as dbmod, publisher
from worker.config import Config
from worker.clients import ClientRegistry, base_url_for

config = Config.from_env()
conn = dbmod.connect(config.database_path)
now = dt.datetime.now(dt.timezone.utc)

# A throwaway FB channel + post + asset + due publication.
cur = conn.execute("""INSERT INTO channels (platform, account_name, remote_account_id, access_token)
                      VALUES ('facebook','ZZ TEMP FB','PAGE_TEST','tok-temp')""")
ch = cur.lastrowid
cur = conn.execute("INSERT INTO posts (caption, post_type) VALUES ('zz temp fb dryrun','single')")
post = cur.lastrowid
cur = conn.execute("""INSERT INTO assets (content_hash, media_kind, storage_path, public_url)
                      VALUES ('zz-temp-hash','image','assets/zz.jpg','https://example.test/zz.jpg')""")
asset = cur.lastrowid
conn.execute("INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)", (post, asset))
cur = conn.execute("INSERT INTO publications (post_id, channel_id, scheduled_at) VALUES (?,?,?)",
                   (post, ch, (now - dt.timedelta(minutes=1)).isoformat()))
pub_id = cur.lastrowid
conn.commit()

print("base for facebook:", base_url_for("facebook", config))
print("base for instagram:", base_url_for("instagram", config))

pub = conn.execute("SELECT * FROM publications WHERE id=?", (pub_id,)).fetchone()
out = publisher.publish_one(conn, pub, config, client=None, dry_run=True, now=now)
print("dry-run result:", out.result)
print("plan platform:", out.plan["platform"], "account_id:", out.plan["account_id"])

# Clean up every row we created.
conn.execute("DELETE FROM publications WHERE id=?", (pub_id,))
conn.execute("DELETE FROM post_assets WHERE post_id=?", (post,))
conn.execute("DELETE FROM posts WHERE id=?", (post,))
conn.execute("DELETE FROM assets WHERE id=?", (asset,))
conn.execute("DELETE FROM channels WHERE id=?", (ch,))
conn.commit()
left = conn.execute("SELECT COUNT(*) FROM channels WHERE account_name='ZZ TEMP FB'").fetchone()[0]
print("temp rows left:", left)
conn.close()
PY
```
Expected: `base for facebook: https://graph.facebook.com`, `dry-run result: dry_run`,
`plan platform: facebook account_id: PAGE_TEST`, `temp rows left: 0`. A dry-run must
reach zero network calls, which is why passing `client=None` is safe here.

Confirm the dev database is back to its prior state:
```bash
.venv/bin/python -c "
import sqlite3;c=sqlite3.connect('data/socialscheduler.db')
print('channels', c.execute('SELECT COUNT(*) FROM channels').fetchone()[0])
print('posts', c.execute('SELECT COUNT(*) FROM posts').fetchone()[0])
print('pubs', c.execute('SELECT COUNT(*) FROM publications').fetchone()[0])
print('fk', c.execute('PRAGMA foreign_key_check').fetchall())"
```
Expected: the same counts as before the script (1 channel, 1 post, 2 publications at the
time of writing) and `fk []`.

- [ ] **Step 5: Mark the sub-project done in `docs/tasks.md`**

Change the Phase 6 Facebook line from `[~]` to `[x]` and replace its body with what shipped:

```markdown
- [x] **Facebook Pages publish + metrics adapter** — spec
      `docs/superpowers/specs/2026-07-23-facebook-pages-adapter-design.md`, plan
      `docs/superpowers/plans/2026-07-23-facebook-pages-adapter.md`. Single image
      (`/{page}/photos`, one call, stores the feed `post_id`) + multi-photo (unpublished
      uploads → `attached_media` feed post). No schema change. New `worker/clients.py`
      picks the Graph host per platform (FB pinned to graph.facebook.com, IG keeps
      `META_GRAPH_BASE`) so one install can mix IG + FB. IG quota gate skipped for FB
      (Pages have no `content_publishing_limit`). Metrics: stable reactions/comments/shares
      + best-effort reach via `FB_POST_INSIGHT_METRICS` (null, never fatal, when Meta
      rejects the name — a batch was deprecated 2026-06-15). Queue controls, captions,
      fan-out and dry-run all work unchanged.
- [ ] Real-post verification (owner): add a test Page + long-lived Page token per
      `docs/meta-setup.md`, then one real photo + one real multi-photo post.
```

- [ ] **Step 6: Commit**

```bash
git add docs/meta-setup.md reference.md docs/tasks.md
git commit -m "docs: Facebook Page setup, verified API facts, tasks status"
```

---

## Definition of done

- `.venv/bin/python -m pytest worker/tests -q` fully green, including ~19 new cases.
- A Facebook publication dry-runs end-to-end and its plan shows `platform: facebook`.
- Instagram behavior is byte-for-byte unchanged (no IG test modified except the
  `ig_user_id` → `account_id` plan-key rename, if any test asserted on it).
- The dev database is left exactly as it was found, FK integrity intact.
- Real posting is **not** attempted — that's the owner-gated step recorded in `docs/tasks.md`.
