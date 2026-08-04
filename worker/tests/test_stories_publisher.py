"""Publishing to the Instagram Story surface.

A Story is a DESTINATION, not a post type (docs/design-instagram-stories.md), so these
tests are about publications carrying surface='story' — not about posts.post_type, which
stays whatever the content shape is ('single'/'carousel').

The wire format of the container itself is pinned in test_stories_publish.py.
"""

from __future__ import annotations

from datetime import datetime, timezone

from worker.publisher import _maybe_retire_one_time, publish_one

NOW = datetime(2026, 8, 1, 18, 0, 0, tzinfo=timezone.utc)


def test_story_creates_a_story_container_then_publishes_it(conn, config, fake_client,
                                                           make_publication):
    pub = make_publication(post_type="single", n_assets=1, surface="story", now=NOW)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW,
                      asset_base_url="https://assets.test")

    assert out.result == "posted", out.detail
    kinds = [c[0] for c in fake_client.calls]
    assert "story_image" in kinds, "a story must go through the STORIES container path"
    assert "image" not in kinds, "a story must NOT use the plain feed image container"
    assert "publish" in kinds, "the container must actually be published"


def test_a_story_polls_container_status_before_publishing(conn, config, fake_client,
                                                          make_publication):
    """Never skip the status check — a project rule, even where it is usually instant."""
    pub = make_publication(post_type="single", n_assets=1, surface="story", now=NOW)
    publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW,
                asset_base_url="https://assets.test")

    kinds = [c[0] for c in fake_client.calls]
    assert kinds.index("status") < kinds.index("publish")


def test_a_video_story_uses_the_video_field(conn, config, fake_client, make_publication):
    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           media_kind="video", now=NOW)
    publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW,
                asset_base_url="https://assets.test")

    kinds = [c[0] for c in fake_client.calls]
    assert "story_video" in kinds
    assert "story_image" not in kinds


def test_a_carousel_post_stories_only_the_slide_this_row_points_at(conn, config,
                                                                   fake_client,
                                                                   make_publication):
    """Fan-out happens at scheduling time: each story publication is ONE slide."""
    pub = make_publication(post_type="carousel", n_assets=3, surface="story",
                           story_slide=1, now=NOW)
    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW,
                      asset_base_url="https://assets.test")

    assert out.result == "dry_run"
    assert len(out.plan["asset_urls"]) == 1, "a story is one media, never a carousel"
    assert "?i=1" in out.plan["asset_urls"][0], "must be the slide this row points at"


def test_story_sends_the_original_not_the_feed_conformed_derivative(conn, config,
                                                                    fake_client,
                                                                    make_publication):
    """Conformance targets the FEED (4:5..1.91:1). A Story is 9:16, outside that range,
    so the conformed copy is deliberately the wrong image for this surface."""
    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           public_url=None, now=NOW)
    conn.execute(
        "UPDATE assets SET storage_path='orig.jpg', publish_path='conformed.jpg'"
    )
    conn.commit()

    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW,
                      asset_base_url="https://assets.test")

    assert "orig.jpg" in out.plan["asset_urls"][0]
    assert "conformed" not in out.plan["asset_urls"][0]


def test_a_feed_post_still_prefers_the_conformed_derivative(conn, config, fake_client,
                                                            make_publication):
    """The surface split must not change feed behaviour."""
    pub = make_publication(post_type="single", n_assets=1, public_url=None, now=NOW)
    conn.execute(
        "UPDATE assets SET storage_path='orig.jpg', publish_path='conformed.jpg'"
    )
    conn.commit()

    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW,
                      asset_base_url="https://assets.test")

    assert "conformed.jpg" in out.plan["asset_urls"][0]


def test_story_plan_carries_no_caption(conn, config, fake_client, make_publication):
    """Nulled in the PLAN, not just at the call site, so dry-run shows the truth."""
    pub = make_publication(post_type="single", n_assets=1, surface="story", now=NOW)
    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW,
                      asset_base_url="https://assets.test")

    assert out.plan["surface"] == "story"
    assert out.plan["caption"] is None


def test_story_ignores_the_caption_length_limit(conn, config, fake_client,
                                                make_publication):
    """No caption is sent, so a caption too long for the feed must not block a Story."""
    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           platform="threads", now=NOW)
    conn.execute("UPDATE posts SET caption = ?", ("x" * 5000,))
    conn.commit()

    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW,
                      asset_base_url="https://assets.test")
    # Threads has no Stories surface, so this fails — but on the SURFACE rule, never on
    # the 500-character caption limit that would otherwise trip first.
    assert "caption" not in (out.detail or "").lower()


def test_story_publication_without_an_asset_id_fails_terminally(conn, config, fake_client,
                                                                make_publication):
    pub = make_publication(post_type="single", n_assets=1, surface="story", now=NOW)
    conn.execute("UPDATE publications SET asset_id = NULL WHERE id = ?", (pub["id"],))
    conn.commit()
    pub = conn.execute(
        "SELECT * FROM publications WHERE id=?", (pub["id"],)
    ).fetchone()

    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW,
                      asset_base_url="https://assets.test")
    assert out.result == "failed", "a story with no slide is a data bug, not a retry"


def test_story_asset_from_a_different_post_fails_terminally(conn, config, fake_client,
                                                            make_publication):
    pub = make_publication(post_type="single", n_assets=1, surface="story", now=NOW)
    orphan = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path) "
        "VALUES ('orphan','image','x.jpg')"
    ).lastrowid
    conn.execute(
        "UPDATE publications SET asset_id = ? WHERE id = ?", (orphan, pub["id"])
    )
    conn.commit()
    pub = conn.execute("SELECT * FROM publications WHERE id=?", (pub["id"],)).fetchone()

    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW,
                      asset_base_url="https://assets.test")
    assert out.result == "failed"


def test_only_instagram_has_a_stories_surface(conn, config, fake_telegram_client,
                                              make_publication):
    pub = make_publication(post_type="single", n_assets=1, surface="story",
                           platform="telegram", now=NOW)
    out = publish_one(conn, pub, config, fake_telegram_client, dry_run=False, now=NOW,
                      asset_base_url="https://assets.test")
    assert out.result == "failed"


def test_post_type_story_is_still_refused(conn, config, fake_client, make_publication):
    """posts.post_type='story' is VESTIGIAL (migration 0014's header). The surface is
    the real mechanism; the old enum value must stay dead rather than quietly working."""
    pub = make_publication(post_type="story", n_assets=1, now=NOW)
    out = publish_one(conn, pub, config, fake_client, dry_run=False, now=NOW,
                      asset_base_url="https://assets.test")
    assert out.result == "failed"


def test_one_time_post_is_not_retired_until_every_surface_has_posted(conn,
                                                                     make_publication):
    """A post targeted at IG feed AND IG story must not retire when only the feed send
    succeeds — that would strand the Story."""
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    post_id, channel_id = pub["post_id"], pub["channel_id"]
    conn.execute("UPDATE posts SET content_kind='one_time' WHERE id=?", (post_id,))
    conn.execute("DELETE FROM post_targets WHERE post_id=?", (post_id,))
    for surface in ("feed", "story"):
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,?)",
            (post_id, channel_id, surface),
        )
    conn.execute(
        "UPDATE publications SET status='posted', is_dry_run=0 WHERE id=?", (pub["id"],)
    )
    conn.commit()

    assert _maybe_retire_one_time(conn, post_id, NOW) is False


def test_one_time_post_retires_once_both_surfaces_have_posted(conn, make_publication):
    pub = make_publication(post_type="single", n_assets=1, now=NOW)
    post_id, channel_id = pub["post_id"], pub["channel_id"]
    conn.execute("UPDATE posts SET content_kind='one_time' WHERE id=?", (post_id,))
    conn.execute("DELETE FROM post_targets WHERE post_id=?", (post_id,))
    for surface in ("feed", "story"):
        conn.execute(
            "INSERT INTO post_targets (post_id, channel_id, surface) VALUES (?,?,?)",
            (post_id, channel_id, surface),
        )
    conn.execute(
        "UPDATE publications SET status='posted', is_dry_run=0 WHERE id=?", (pub["id"],)
    )
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, surface, status, "
        "is_dry_run) VALUES (?,?,?,'story','posted',0)",
        (post_id, channel_id, NOW.isoformat()),
    )
    conn.commit()

    assert _maybe_retire_one_time(conn, post_id, NOW) is True


def test_story_plan_shows_the_original_on_disk_not_the_conformed_copy(conn, config,
                                                                      fake_client,
                                                                      make_publication):
    """The dry-run plan's asset_paths must not advertise the feed-cropped derivative for
    a story. No byte-upload platform has Stories today so this changes no real publish,
    but the plan's job is to be legible about what WOULD be sent."""
    pub = make_publication(post_type="single", n_assets=1, surface="story", now=NOW)
    (config.asset_storage_dir / "pub").mkdir(parents=True, exist_ok=True)
    orig = config.asset_storage_dir / "orig.jpg"
    conformed = config.asset_storage_dir / "pub" / "orig.jpg"
    orig.write_bytes(b"original")
    conformed.write_bytes(b"cropped")
    conn.execute(
        "UPDATE assets SET storage_path='orig.jpg', publish_path='pub/orig.jpg'"
    )
    conn.commit()

    out = publish_one(conn, pub, config, fake_client, dry_run=True, now=NOW,
                      asset_base_url="https://assets.test")

    assert out.plan["asset_paths"][0] == orig
