# Threads Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish text, image and carousel posts to Threads, fetch their metrics, and introduce the `text` post type end-to-end.

**Architecture:** Part 1 left five guarded registries keyed by platform (`clients._BASE_URLS`, `publisher._PUBLISHERS`, `publisher._QUOTA_GATED`, `preflight._CHECKS`, `metrics._FETCHERS`), each asserted against `clients.SUPPORTED_PLATFORMS`. This plan adds a sixth — `clients.PLATFORM_CAPS`, declaring what each platform can publish — then registers Threads in all six at once, and teaches the composer to make text posts.

**Tech Stack:** Python 3.11 in the repo `.venv`, pytest; Next.js App Router + TypeScript.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-threads-adapter-design.md`. Read it before Task 1.
- **No migration.** Part 1's `0008` already widened `channels.platform` (accepts `'threads'`) and `posts.post_type` (accepts `'text'`).
- **The registry asserts run at import.** Adding `'threads'` to `SUPPORTED_PLATFORMS` without adding it to *every* registry breaks `import worker.run`. Task 4 therefore registers Threads everywhere in a single commit — do not split it.
- Never hardcode a publish quota. Threads **has** `threads_publishing_limit`, so it is gated like Instagram (`_QUOTA_GATED["threads"] = True`).
- Never log tokens, PII, or full API responses.
- Failures stay visible and per-publication; one failing must never crash the worker or affect another.
- No new dependencies (stdlib + `requests`; no new npm packages).
- Worker tests: `.venv/bin/python -m pytest worker/tests -q` — **currently 201 passing, ~110s; let it finish.**
- Dashboard typecheck: `cd dashboard && npx tsc --noEmit`
- **Never modify `data/socialscheduler.db`.** It holds the owner's real content (one Instagram channel, "Liparoto").
- Commit after each task.

---

### Task 1: Platform capabilities registry

**Files:** Modify `worker/clients.py`, `worker/publisher.py`, `worker/tests/test_platform_dispatch.py`

**Interfaces:**
- Produces (used by Tasks 2 and 4): `clients.PlatformCaps` (frozen dataclass with `supports_text: bool`, `max_carousel: int`, `max_caption_chars: int | None`) and `clients.PLATFORM_CAPS: dict[str, PlatformCaps]`, asserted against `SUPPORTED_PLATFORMS`.
- Retires `publisher.MAX_CAROUSEL`.

This task adds **no** Threads support — it only turns one hardcoded constant into a declared, guarded capability.

- [ ] **Step 1: Write the failing test**

Add to `worker/tests/test_platform_dispatch.py`:

```python
def test_platform_caps_are_declared_for_every_supported_platform():
    from worker.clients import PLATFORM_CAPS

    assert set(PLATFORM_CAPS) == set(SUPPORTED_PLATFORMS), "capability registry out of sync"


def test_neither_meta_platform_claims_text_support():
    """Instagram and Facebook have no text-only post format — a caps typo here would let
    the publisher send a captionless-image-less post at them."""
    from worker.clients import PLATFORM_CAPS

    assert PLATFORM_CAPS["instagram"].supports_text is False
    assert PLATFORM_CAPS["facebook"].supports_text is False
    assert PLATFORM_CAPS["instagram"].max_carousel == 10
```

And extend the existing `test_all_four_registries_cover_exactly_the_supported_platforms`: add `PLATFORM_CAPS` to its imports and assertions, and **rename it** to `test_all_registries_cover_exactly_the_supported_platforms` (it covers six now; drop the count from the name so it stops going stale).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_platform_dispatch.py -q`
Expected: FAIL — `ImportError: cannot import name 'PLATFORM_CAPS'`.

- [ ] **Step 3: Add the registry**

In `worker/clients.py`, add `from dataclasses import dataclass` to the imports, then after the `_BASE_URLS` assert:

```python
@dataclass(frozen=True)
class PlatformCaps:
    """What a platform can actually publish.

    Declared as data so validation is a lookup rather than a scatter of `if platform ==`
    checks, and so a new platform cannot be added without stating what it supports.
    """

    supports_text: bool          # can publish a post with a caption and no media
    max_carousel: int            # maximum children in a multi-image post
    max_caption_chars: int | None  # None = no limit this worker enforces


PLATFORM_CAPS: dict[str, PlatformCaps] = {
    # Instagram: feed carousels cap at 10 (see reference.md). No text-only format.
    "instagram": PlatformCaps(supports_text=False, max_carousel=10, max_caption_chars=None),
    # Facebook Pages: attached_media multi-photo posts cap at 10. No text-only format
    # here either — a Page status update is a different product surface we don't publish.
    "facebook": PlatformCaps(supports_text=False, max_carousel=10, max_caption_chars=None),
}

assert set(PLATFORM_CAPS) == set(SUPPORTED_PLATFORMS), (
    "clients.PLATFORM_CAPS and clients.SUPPORTED_PLATFORMS disagree"
)
```

- [ ] **Step 4: Make the publisher read it**

In `worker/publisher.py`:
- change the import to `from .clients import PLATFORM_CAPS, SUPPORTED_PLATFORMS`
- delete the `MAX_CAROUSEL = 10` line and its comment (keep `MIN_CAROUSEL = 2`)
- in `_validate`, after the platform check, add `caps = PLATFORM_CAPS[platform]` and change the carousel rule to:

```python
    if post_type == "carousel" and not (MIN_CAROUSEL <= len(assets) <= caps.max_carousel):
        raise _NonRetryable(
            f"carousel needs {MIN_CAROUSEL}-{caps.max_carousel} assets, has {len(assets)}"
        )
```

Then `grep -rn "MAX_CAROUSEL" worker/ docs/ reference.md` and update any other reference (tests, docs) so nothing points at the deleted constant.

- [ ] **Step 5: Run the full suite and commit**

Run: `.venv/bin/python -m pytest worker/tests -q`
Expected: PASS — 201 pre-existing plus 2 new. Existing carousel tests must pass **unmodified** (10 is still the Instagram limit).

```bash
git add worker/clients.py worker/publisher.py worker/tests/test_platform_dispatch.py
git commit -m "refactor(worker): declare platform capabilities instead of one global carousel cap"
```

---

### Task 2: The `text` post type in the worker

**Files:** Modify `worker/publisher.py`; create `worker/tests/test_text_posts.py`

**Interfaces:**
- Consumes `PLATFORM_CAPS` from Task 1.
- Produces: `SUPPORTED_POST_TYPES` includes `"text"`; `_validate` enforces the text and caption-length rules; `_validate`'s signature gains a trailing `caption: str | None = None`.

Threads does not exist yet, so in this task **every** platform rejects text posts — which is exactly what the tests pin.

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_text_posts.py`:

```python
"""A text post carries a caption and no media.

The composer prevents aiming one at a platform that can't publish it, but a post can be
retargeted later, restored from a backup, or hand-edited — so the worker never trusts the
UI and re-checks against the platform's declared capabilities.
"""

from __future__ import annotations

import pytest

from worker.publisher import publish_one


def _make_text_post(conn, make_publication, platform="instagram", caption="hello threads"):
    """A publication whose post is text-only: caption set, zero assets."""
    pub = make_publication(platform=platform, n_assets=0)
    conn.execute(
        "UPDATE posts SET post_type = 'text', caption = ? WHERE id = ?",
        (caption, pub["post_id"]),
    )
    conn.commit()
    return conn.execute(
        "SELECT * FROM publications WHERE id = ?", (pub["id"],)
    ).fetchone()


def test_a_text_post_is_rejected_terminally_on_a_platform_without_text_support(
    conn, config, fake_client, make_publication
):
    pub = _make_text_post(conn, make_publication, platform="instagram")

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert row["status"] == "failed"
    assert row["next_retry_at"] is None          # retrying can't give Instagram a text format
    assert "text" in row["last_error"].lower()
    assert fake_client.calls == []               # nothing attempted against the API


@pytest.fixture
def text_capable_instagram(monkeypatch):
    """Pretend Instagram supports text, so the LATER text rules are reachable.

    Without this the `supports_text` rule fires first and every text test would just be
    re-testing that one branch — the asset and caption rules would never be exercised.
    """
    from worker import clients

    caps = dict(clients.PLATFORM_CAPS)
    caps["instagram"] = clients.PlatformCaps(
        supports_text=True, max_carousel=10, max_caption_chars=None
    )
    monkeypatch.setattr(clients, "PLATFORM_CAPS", caps)
    monkeypatch.setattr("worker.publisher.PLATFORM_CAPS", caps)
    return caps


def test_a_text_post_with_assets_attached_is_rejected(
    conn, config, fake_client, make_publication, text_capable_instagram
):
    # post_type says text but an image is attached — contradictory, so refuse rather than
    # silently dropping the image or silently ignoring the type.
    pub = make_publication(platform="instagram", n_assets=1)
    conn.execute("UPDATE posts SET post_type = 'text' WHERE id = ?", (pub["post_id"],))
    conn.commit()
    pub = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT last_error FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert "asset" in row["last_error"].lower()


def test_a_text_post_with_no_caption_is_rejected(
    conn, config, fake_client, make_publication, text_capable_instagram
):
    pub = _make_text_post(conn, make_publication, caption="   ")

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT last_error FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert "caption" in row["last_error"].lower()


def test_an_over_length_caption_is_rejected_when_the_platform_declares_a_limit(
    conn, config, fake_client, make_publication, monkeypatch
):
    from worker import clients

    # Give Instagram a tiny limit for this test rather than waiting for Threads to exist.
    capped = dict(clients.PLATFORM_CAPS)
    capped["instagram"] = clients.PlatformCaps(
        supports_text=False, max_carousel=10, max_caption_chars=10
    )
    monkeypatch.setattr(clients, "PLATFORM_CAPS", capped)
    monkeypatch.setattr("worker.publisher.PLATFORM_CAPS", capped)

    pub = make_publication(platform="instagram", n_assets=1)
    conn.execute(
        "UPDATE posts SET caption = ? WHERE id = ?",
        ("x" * 50, pub["post_id"]),
    )
    conn.commit()
    pub = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "failed"
    row = conn.execute("SELECT last_error FROM publications WHERE id = ?", (pub["id"],)).fetchone()
    assert "50" in row["last_error"] and "10" in row["last_error"]
    assert fake_client.calls == []


def test_a_normal_image_post_is_unaffected(conn, config, fake_client, make_publication):
    """Guard against the new rules leaking into the existing path."""
    pub = make_publication(platform="instagram", n_assets=1)

    out = publish_one(conn, pub, config, fake_client, dry_run=False)

    assert out.result == "posted"
```

`make_publication` must accept `n_assets=0`. Check `worker/tests/conftest.py` — if the factory can't currently produce a post with zero assets, make it able to, without changing behavior for any existing caller.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_text_posts.py -q`
Expected: FAIL — `post_type 'text' not supported until Phase 6` for the text cases, and no caption-length rule exists.

- [ ] **Step 3: Implement the rules**

In `worker/publisher.py`:

**(a)** `SUPPORTED_POST_TYPES = ("single", "carousel", "text")`

**(b)** Give `_validate` the caption and the new rules. Its signature becomes:
```python
def _validate(post, assets, dry_run: bool, asset_base_url: str | None, platform: str,
              caption: str | None = None) -> None:
```
After the existing `post_type not in SUPPORTED_POST_TYPES` check and `caps = PLATFORM_CAPS[platform]`, add:

```python
    if post_type == "text":
        if not caps.supports_text:
            raise _NonRetryable(f"{platform} cannot publish text-only posts")
        if assets:
            raise _NonRetryable(
                f"a text post must have no assets, has {len(assets)}"
            )
        if not (caption or "").strip():
            raise _NonRetryable("a text post needs a caption")
    if caps.max_caption_chars is not None and caption is not None:
        if len(caption) > caps.max_caption_chars:
            raise _NonRetryable(
                f"caption is {len(caption)} characters; {platform} allows "
                f"{caps.max_caption_chars}"
            )
```

The existing `single`/`carousel` asset-count rules and the public-URL check stay exactly as they are — but the public-URL check must not fire for a text post. It already won't: it iterates `assets`, which is empty.

**(c)** `publish_one` currently validates *before* selecting the caption, so `_validate` can't see it. Reorder those three statements inside the existing `try:` so the caption is chosen first:

```python
        channel, post, assets = _load_targets(conn, pub)
        used_count = conn.execute(
            "SELECT COUNT(*) FROM publications WHERE post_id=? AND channel_id=? AND status='posted'",
            (pub["post_id"], pub["channel_id"]),
        ).fetchone()[0]
        caption = _select_caption(conn, post["id"], channel["platform"], used_count)
        _validate(post, assets, dry_run, asset_base_url, channel["platform"], caption)
        plan = _build_plan(channel, post, assets, asset_base_url, caption)
```
Nothing else moves; `_select_caption` has no dependency on validation.

- [ ] **Step 4: Run the tests, then the full suite**

Run: `.venv/bin/python -m pytest worker/tests/test_text_posts.py -q` → PASS (5).
Run: `.venv/bin/python -m pytest worker/tests -q` → PASS, everything else unmodified.

- [ ] **Step 5: Commit**

```bash
git add worker/publisher.py worker/tests/
git commit -m "feat(worker): validate text posts against platform capabilities"
```

---

### Task 3: Threads API methods on the Graph client

**Files:** Modify `worker/graph_api.py`; create `worker/tests/test_graph_api_threads.py`

**Interfaces (used by Task 4):**
- `create_threads_container(user_id, token, *, media_type, text=None, image_url=None, is_carousel_item=False, children=None) -> str`
- `get_threads_container_status(container_id, token) -> str`
- `publish_threads_container(user_id, creation_id, token) -> str`
- `get_threads_publishing_limit(user_id, token) -> tuple[int|None, int|None, int|None]` — same `(usage, total, duration_seconds)` shape as `get_content_publishing_limit`, so the existing quota gate needs no changes
- `get_threads_insights(media_id, token, metrics) -> dict`

This task touches no registry, so nothing else changes behavior.

- [ ] **Step 1: Write the failing tests**

Create `worker/tests/test_graph_api_threads.py`, following the structure of `worker/tests/test_graph_api_facebook.py` (reuse its `FakeResponse`/`FakeSession` pattern — copy them in; they're small and keeping the files independent is worth the duplication). Cover:

1. A TEXT container posts to `https://graph.threads.net/v1.0/USER1/threads` with `media_type=TEXT` and `text`, and **no** `image_url`.
2. An IMAGE container sends `media_type=IMAGE` plus `image_url`, and includes `text` when given.
3. A carousel **child** sends `is_carousel_item=true`; a carousel **parent** sends `media_type=CAROUSEL` with `children` as a comma-separated string.
4. `get_threads_container_status` reads the `status` field (Threads names it `status`, not Instagram's `status_code`) and returns it.
5. `publish_threads_container` posts `creation_id` to `USER1/threads_publish` and returns the new id.
6. `get_threads_publishing_limit` returns `(usage, total, duration)` from a payload shaped `{"data":[{"quota_usage":7,"config":{"quota_total":250,"quota_duration":86400}}]}`, and returns `(None, None, None)`-ish safely from an empty `{"data":[]}`.
7. `get_threads_insights` parses **both** envelope shapes — an item carrying `{"total_value":{"value":N}}` and an item carrying `{"values":[{"value":N}]}` — because Threads uses the former for lifetime metrics while Instagram uses the latter, and returns `{metric: value}`.
8. A non-OK response raises `GraphAPIError`.

Assert on the exact URL and the exact `data`/`params` dict contents, and on the returned value — not just that a call happened.

- [ ] **Step 2: Run them to verify they fail**

Run: `.venv/bin/python -m pytest worker/tests/test_graph_api_threads.py -q`
Expected: FAIL — `AttributeError: 'GraphClient' object has no attribute 'create_threads_container'`.

- [ ] **Step 3: Implement**

Append a Threads section to `GraphClient` in `worker/graph_api.py`, after the Facebook section, and extend the module docstring's first line to mention Threads. Guidance:

- Build `data` conditionally — only include `text`, `image_url`, `is_carousel_item`, `children` when they apply, so a TEXT container never carries an `image_url` key.
- `is_carousel_item` is sent as the string `"true"` (matching the Instagram method's convention).
- `children` is joined with commas.
- `get_threads_container_status` requests `fields=status` and returns the value, defaulting to `""` when absent rather than raising a `KeyError`.
- `get_threads_publishing_limit` mirrors `get_content_publishing_limit`'s defensive parsing exactly (`data` may be missing or empty; `config` may be missing).
- `get_threads_insights` must handle both envelopes described above. Prefer `total_value.value` when present, else `values[0].value`, else `None`. Do **not** reuse `_parse_insights` unless you extend it to cover `total_value` — in which case re-run the Instagram and Facebook metrics tests to prove they're unaffected.
- Docstrings should note the verified facts: 500-character text limit, 2–20 carousel children, 250 published posts per rolling 24h.

- [ ] **Step 4: Run the tests, then the full suite, then commit**

```bash
git add worker/graph_api.py worker/tests/test_graph_api_threads.py
git commit -m "feat(worker): add Threads publish, quota and insights calls to the Graph client"
```

---

### Task 4: Register Threads in every registry

**Files:** Modify `worker/clients.py`, `worker/publisher.py`, `worker/preflight.py`, `worker/metrics.py`, `worker/config.py`, `.env.example`, `worker/tests/conftest.py`; create `worker/tests/test_threads_publishing.py`

**This task must land in ONE commit.** The registry asserts run at import, so a partial registration breaks `import worker.run`.

**Interfaces:** consumes Task 1's `PLATFORM_CAPS`, Task 2's text validation, Task 3's client methods.

- [ ] **Step 1: Extend the fake client and the publication factory**

In `worker/tests/conftest.py`:
- Add Threads methods to `FakeGraphClient` mirroring Task 3's surface, recording call kinds `threads_text`, `threads_image`, `threads_child`, `threads_carousel`, `threads_status`, `threads_publish`, `threads_limit`, `threads_insights`, each honouring `fail_on`. Return ids in the existing `f"...-{self._n}"` style. Give it canned `threads_limit=(0, 250, 86400)` and `threads_insights={"views": 500, "likes": 12, "replies": 3, "reposts": 2, "quotes": 1}`, both overridable via `__init__` like the Facebook ones.
- `make_publication` must accept `platform="threads"`, defaulting `remote_account_id` to `"THREADS1"` and the account name to `"Test Threads"`.

- [ ] **Step 2: Write the failing tests**

Create `worker/tests/test_threads_publishing.py` covering:

1. **Text post** — publishes with call kinds `["threads_limit", "threads_text", "threads_status", "threads_publish"]`; `remote_post_id` is the published id; `status='posted'`.
2. **Image post** — `["threads_limit", "threads_image", "threads_status", "threads_publish"]`.
3. **Carousel** with 3 assets — three `threads_child` + `threads_status` pairs, then `threads_carousel`, `threads_status`, `threads_publish`; the parent's `children` argument equals the three child ids in asset order.
4. **The quota gate is live for Threads** — with `FakeGraphClient(threads_limit=(250, 250, 86400))` the publication is deferred (`out.result == "rate_limited"`, status back to `scheduled`, `next_retry_at` set) and **no** container is created. This is the rule "never hardcode the limit — read it at runtime"; Threads has a real endpoint, so unlike Facebook it must gate.
5. **A 501-character caption is rejected terminally** and no API call is made (Threads declares `max_caption_chars=500`).
6. **A 21-asset carousel is rejected terminally** (Threads declares `max_carousel=20`), while **20 is accepted** — pin both sides of the boundary.
7. **Dry-run** makes zero calls and reports `plan["platform"] == "threads"`.
8. **Preflight** for a Threads channel calls `threads_limit` and prints a `✓` line; it must **not** call Instagram's `get_content_publishing_limit`.
9. **Metrics** map to columns: `views→impressions`, `likes→likes`, `replies→comments`, `reposts→shares`; `reach` and `saves` stay `None`; `quotes` appears in `raw_json` but in no column.
10. **A metrics failure is non-fatal** — no `post_metrics` row is written and the run continues.

- [ ] **Step 3: Run them to verify they fail**

Expected: FAIL — `'threads'` isn't in any registry, so publications are rejected as an unsupported platform.

- [ ] **Step 4: Register Threads everywhere**

**`worker/clients.py`:**
```python
THREADS_BASE = "https://graph.threads.net"
```
add `"threads"` to `SUPPORTED_PLATFORMS`; add `"threads": lambda _config: THREADS_BASE` to `_BASE_URLS` (Threads always has its own host, like Facebook); and add to `PLATFORM_CAPS`:
```python
    # Threads: text-first. 500-character text limit, 2-20 carousel children,
    # 250 API-published posts per rolling 24h (verified 2026-07-25).
    "threads": PlatformCaps(supports_text=True, max_carousel=20, max_caption_chars=500),
```

**`worker/publisher.py`:** generalise the container poll so Threads can reuse it — give `_poll_until_finished` a `status_fn=None` parameter defaulting to `client.get_container_status`, and pass `client.get_threads_container_status` from the Threads path. Instagram's calls must be unchanged. Then:

```python
def _publish_threads(client, plan, token, config, sleep_fn) -> str:
    """Container -> publish, like Instagram, but text posts need no media at all."""
    user = plan["account_id"]
    post_type = plan["post_type"]

    if post_type == "text":
        container = client.create_threads_container(
            user, token, media_type="TEXT", text=plan["caption"]
        )
    elif post_type == "single":
        container = client.create_threads_container(
            user, token, media_type="IMAGE",
            image_url=plan["asset_urls"][0], text=plan["caption"],
        )
    else:
        children = []
        for url in plan["asset_urls"]:
            child = client.create_threads_container(
                user, token, media_type="IMAGE", image_url=url, is_carousel_item=True
            )
            _poll_until_finished(
                client, child, token, config, sleep_fn,
                status_fn=client.get_threads_container_status,
            )
            children.append(child)
        container = client.create_threads_container(
            user, token, media_type="CAROUSEL", children=children, text=plan["caption"]
        )

    _poll_until_finished(
        client, container, token, config, sleep_fn,
        status_fn=client.get_threads_container_status,
    )
    return client.publish_threads_container(user, container, token)
```
Register `"threads": _publish_threads` in `_PUBLISHERS` and `"threads": True` in `_QUOTA_GATED`, extending that dict's comment to record that Threads exposes `threads_publishing_limit` (250/24h).

The quota gate calls `client.get_content_publishing_limit(...)`. Threads uses a different method, so make the gate look up the quota reader per platform too — add a `_QUOTA_READERS` dict (`{"instagram": lambda c, acct, tok: c.get_content_publishing_limit(acct, tok), "threads": lambda c, acct, tok: c.get_threads_publishing_limit(acct, tok)}`) and have the gate call `_QUOTA_READERS[platform]`. Facebook has no entry and no gate. Assert that `_QUOTA_READERS`' keys are exactly the platforms whose `_QUOTA_GATED` value is `True`, and add that assertion to the coverage test.

**`worker/preflight.py`:** add `_check_threads`, printing the same quota line as Instagram's check but via `get_threads_publishing_limit`; register it in `_CHECKS`.

**`worker/metrics.py`:** add to `COLUMN_MAP`:
```python
    # Threads insights. "quotes" is deliberately unmapped — it has no column, and folding
    # it into shares would silently inflate that number; it stays in raw_json.
    "views": "impressions",
    "replies": "comments",
    "reposts": "shares",
```
(`likes` is already mapped.) Add `_fetch_threads`, reading the metric list from a new `config.threads_insight_metrics`. Unlike Facebook there is no stable summary endpoint to fall back on, so if the insights call fails, **let it raise** — `run_metrics`' existing handler logs it and skips the snapshot rather than recording an all-null row. Register it in `_FETCHERS`.

**`worker/config.py`:** add `threads_insight_metrics: str = "views,likes,replies,reposts,quotes"` and read `THREADS_INSIGHT_METRICS` in `from_env`. Document it in `.env.example` next to `FB_POST_INSIGHT_METRICS`, noting Meta renames insight metrics without warning.

- [ ] **Step 5: Run the tests, then the full suite**

Expected: PASS. Instagram and Facebook tests must pass **unmodified**; the coverage test now sees six registries plus the quota-reader assertion.

- [ ] **Step 6: Commit**

```bash
git add worker/ .env.example
git commit -m "feat(worker): publish text, image and carousel posts to Threads"
```

---

### Task 5: Threads in the dashboard

**Files:** Modify `dashboard/lib/platforms.ts`, `dashboard/components/publication-queue.tsx`

- [ ] **Step 1: Add Threads and the capability fields**

In `dashboard/lib/platforms.ts`, give **every** platform three new fields mirroring the worker's `PLATFORM_CAPS` — `supportsText`, `maxCarousel`, `maxCaptionChars` (`null` for no limit) — and add the Threads entry:

```ts
  {
    value: "threads",
    label: "Threads",
    badge: "TH",
    accountIdLabel: "Threads user id",
    usesLinkedPage: false,
    supportsText: true,
    maxCarousel: 20,
    maxCaptionChars: 500,
  },
```
Instagram and Facebook both get `supportsText: false, maxCarousel: 10, maxCaptionChars: null`.

Add helpers `supportsText(value: string): boolean` (default **false** for unknown platforms — the safe direction) and `maxCaptionChars(value: string): number | null`.

Add a comment recording that these mirror `worker/clients.py`'s `PLATFORM_CAPS`, that **the worker is authoritative** and re-validates at publish time, and that this copy exists only to shape the composer.

- [ ] **Step 2: Give Threads its own metrics strip**

In `dashboard/components/publication-queue.tsx`, the posted-metrics block currently forks Facebook vs everything-else. Make it a three-way branch, leaving the Instagram and Facebook arms **byte-identical**, and adding for `threads`:
`👁 views (m_impressions) · ♥ likes (m_likes) · 💬 replies (m_comments) · ↻ reposts (m_shares)`, with `title` tooltips matching that naming. Do not show reach or saves for Threads — both are always empty there.

- [ ] **Step 3: Typecheck and commit**

Run: `cd dashboard && npx tsc --noEmit` → exit 0.

```bash
git add dashboard/
git commit -m "feat(dashboard): Threads platform entry, capabilities and metrics strip"
```

---

### Task 6: The "Text only" composer toggle

**Files:** Modify `dashboard/components/composer.tsx` (and the compose API route if it needs to accept the new post type)

**Read `dashboard/components/composer.tsx` in full before changing anything**, and follow its existing state and styling conventions rather than introducing new ones.

Required behavior:

1. A **"Text only"** toggle at the top of the composer, off by default. Off ⇒ the composer behaves exactly as it does today.
2. When **on**: the image upload/ordering area is hidden; the post is submitted with `post_type: "text"` and no assets.
3. When **on**: a live **character counter** appears against the strictest limit among the currently-selected channels (Threads = 500). Over the limit, the counter reads as an error and **Save/Schedule is disabled** — the worker would reject it terminally anyway, so failing here is kinder.
4. When **on**: channels whose platform has `supportsText: false` are **disabled in the picker**, with a short reason such as "Instagram can't post text-only". Any already-selected unsupported channel is deselected when the toggle is switched on — don't silently submit a target that can't work.
5. Turning the toggle **off** restores normal behavior; any text typed is preserved.
6. Existing Instagram/Facebook composing is **unchanged** with the toggle off.

Check whether `POST /api/posts` (or whichever route the composer submits to) hardcodes `post_type` to `single`/`carousel`; if so, let it accept `text` and validate server-side that a text post has no assets and a non-empty caption. The dashboard route mirrors the worker's rules; the worker remains authoritative.

- [ ] **Step 1: Implement, then typecheck**

Run: `cd dashboard && npx tsc --noEmit` → exit 0.

- [ ] **Step 2: Verify in the browser**

The dev server runs on port **3939** (don't start a second one). Confirm:
- Toggle **off**: the composer looks and behaves exactly as before; the existing Instagram channel is selectable; an image post can still be composed.
- Toggle **on**: images disappear, the counter appears, Instagram is disabled with its reason, and a previously-selected Instagram channel gets deselected.
- Typing past 500 characters shows the error state and disables the submit control.

Take a screenshot of both states and **save them to files**, referencing the paths in your report.

- [ ] **Step 3: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): compose text-only posts behind an explicit toggle"
```

---

### Task 7: Docs and end-to-end verification

**Files:** Modify `docs/meta-setup.md`, `reference.md`, `docs/tasks.md`

- [ ] **Step 1: Write the Threads setup guide**

Add a "Adding a Threads account" section to `docs/meta-setup.md`, matching the file's plain, numbered, non-technical voice. It must make clear that **Threads Login is its own OAuth flow with its own app product and its own scopes (`threads_basic`, `threads_content_publish`) — it is not the Facebook Login flow**, and that the Threads user id is not the Instagram user id. Cover: adding the Threads use case/product to a Meta app, authorising, obtaining a long-lived token, finding the Threads user id, adding the channel in the dashboard (platform **Threads**), and verifying with `python3 -m worker.preflight` before any real post. Note the limits users will actually hit: 500 characters, 2–20 carousel images, 250 posts/24h.

- [ ] **Step 2: Record the verified API facts**

Add a Threads section to `reference.md` in its existing "verified on <date>" style: base URL `https://graph.threads.net/v1.0`, the container/publish endpoints, `media_type` values and their parameters, the `status` field name (**not** Instagram's `status_code`), 2–20 children, `threads_publishing_limit` (250/24h, and that it *is* gated at runtime unlike Facebook), the insights metrics and the two response envelopes, and the metric→column mapping including why `quotes` is unmapped.

- [ ] **Step 3: Verify end-to-end in dry-run against a copy**

Copy the real database, add a Threads channel and both a text post and an image post to the **copy**, run them through `publish_one` in dry-run, and confirm both report `dry_run` with `plan["platform"] == "threads"` and the right `post_type`. Then delete the copy. Print the outcomes.

**Do not touch `data/socialscheduler.db`.** Confirm at the end that its row counts and `PRAGMA foreign_key_check` are unchanged.

- [ ] **Step 4: Confirm the whole suite and typecheck**

Run: `.venv/bin/python -m pytest worker/tests -q` and `cd dashboard && npx tsc --noEmit`.

- [ ] **Step 5: Update `docs/tasks.md`**

Mark the Threads adapter done under Phase 6, listing what shipped, and add an owner-gated follow-up for the first real Threads post (mirroring the parked Facebook one), plus the known limitation that auto-fill ranks Threads posts as 0 until the BPP work.

- [ ] **Step 6: Commit**

```bash
git add docs/ reference.md
git commit -m "docs: Threads setup guide, verified API facts, task status"
```

---

## Definition of done

- Worker suite green (201 pre-existing + the new tests); dashboard `tsc` clean.
- Threads text, image and carousel all publish in tests; the quota gate defers at 250/250.
- A text post aimed at Instagram fails terminally, and a sibling publication still publishes.
- Instagram and Facebook behavior unchanged throughout.
- All six registries plus `_QUOTA_READERS` provably cover their platforms.
- `data/socialscheduler.db` untouched; no migration added.
- Real posting **not** attempted — owner-gated and recorded in `docs/tasks.md`.
