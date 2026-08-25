"""Tests for turning the database into export dataclasses."""

from __future__ import annotations

import pytest

from worker.export.collect import slugify


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Shoulder Mobility Tips", "shoulder-mobility-tips"),
        ("  Balance   Screening!! ", "balance-screening"),
        ("Café naïve", "cafe-naive"),
        ("🎉🎉🎉", "untitled"),
        ("", "untitled"),
        (None, "untitled"),
        ("a" * 80, "a" * 40),
    ],
)
def test_slugify_normalizes_captions(raw, expected):
    assert slugify(raw) == expected


def test_slugify_does_not_end_in_a_dash_after_truncation():
    # Truncating mid-word must not leave a trailing separator.
    assert not slugify("word " * 20).endswith("-")


from worker.export.collect import collect_posts


def _post_with(conn, caption="Shoulder Mobility Tips", post_type="single"):
    cur = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES (?, ?)", (caption, post_type)
    )
    return cur.lastrowid


def test_collect_posts_returns_empty_list_for_empty_database(conn):
    assert collect_posts(conn) == []


def test_collect_posts_reads_core_fields(conn):
    post_id = _post_with(conn)
    conn.commit()

    posts = collect_posts(conn)

    assert len(posts) == 1
    assert posts[0].post_id == post_id
    assert posts[0].caption == "Shoulder Mobility Tips"
    assert posts[0].post_type == "single"
    assert posts[0].content_kind == "evergreen"


def test_collect_posts_joins_tags_periods_and_targets(conn):
    post_id = _post_with(conn)
    tag_id = conn.execute("INSERT INTO tags (name) VALUES ('mobility')").lastrowid
    conn.execute("INSERT INTO post_tags (post_id, tag_id) VALUES (?,?)", (post_id, tag_id))

    green = conn.execute(
        "INSERT INTO periods (name, start_month, start_day, end_month, end_day)"
        " VALUES ('Summer', 6, 1, 8, 31)"
    ).lastrowid
    black = conn.execute(
        "INSERT INTO periods (name, start_month, start_day, end_month, end_day)"
        " VALUES ('Holidays', 12, 20, 12, 31)"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?,'green')",
        (post_id, green),
    )
    conn.execute(
        "INSERT INTO post_periods (post_id, period_id, mode) VALUES (?,?,'blackout')",
        (post_id, black),
    )

    channel_id = conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('instagram', 'Test IG')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_targets (post_id, channel_id) VALUES (?,?)", (post_id, channel_id)
    )
    conn.commit()

    post = collect_posts(conn)[0]

    assert post.tags == ["mobility"]
    assert post.green_periods == ["Summer"]
    assert post.blackout_periods == ["Holidays"]
    assert post.target_channels == ["Test IG"]


def test_collect_posts_names_images_by_post_and_carousel_position(conn):
    post_id = _post_with(conn, caption="Shoulder Mobility Tips", post_type="carousel")
    for i in range(2):
        asset_id = conn.execute(
            "INSERT INTO assets (content_hash, media_kind, storage_path)"
            " VALUES (?, 'image', ?)",
            (f"hash-{i}", f"assets/raw-{i}.JPG"),
        ).lastrowid
        conn.execute(
            "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,?)",
            (post_id, asset_id, i),
        )
    conn.commit()

    post = collect_posts(conn)[0]

    assert [img.export_filename for img in post.images] == [
        f"{post_id:04d}_shoulder-mobility-tips_1.jpg",
        f"{post_id:04d}_shoulder-mobility-tips_2.jpg",
    ]


def test_collect_posts_orders_images_by_sort_order_not_insertion(conn):
    post_id = _post_with(conn, post_type="carousel")
    first = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path)"
        " VALUES ('h-b', 'image', 'assets/b.jpg')"
    ).lastrowid
    second = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path)"
        " VALUES ('h-a', 'image', 'assets/a.jpg')"
    ).lastrowid
    # Insert position 1 before position 0.
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,1)",
        (post_id, first),
    )
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
        (post_id, second),
    )
    conn.commit()

    post = collect_posts(conn)[0]

    assert [img.asset_id for img in post.images] == [second, first]


def test_collect_posts_sets_published_filename_only_when_conformed(conn):
    post_id = _post_with(conn)
    plain = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path)"
        " VALUES ('h-plain', 'image', 'assets/plain.jpg')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
        (post_id, plain),
    )
    other_id = _post_with(conn, caption="Cropped One")
    cropped = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path, publish_path,"
        " conform_mode) VALUES ('h-crop', 'image', 'assets/c.jpg', 'assets/c-pub.jpg', 'crop')"
    ).lastrowid
    conn.execute(
        "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
        (other_id, cropped),
    )
    conn.commit()

    by_id = {p.post_id: p for p in collect_posts(conn)}

    assert by_id[post_id].images[0].published_filename is None
    assert by_id[other_id].images[0].published_filename == (
        f"{other_id:04d}_cropped-one_1.jpg"
    )


def test_collect_posts_produces_globally_unique_image_filenames(conn):
    # An asset shared by two posts is exported under each post's own name; post_id
    # plus carousel position makes every name unique without any suffix logic.
    shared = conn.execute(
        "INSERT INTO assets (content_hash, media_kind, storage_path)"
        " VALUES ('h-shared', 'image', 'assets/shared.jpg')"
    ).lastrowid
    for _ in range(2):
        post_id = _post_with(conn, caption="Same Caption")
        conn.execute(
            "INSERT INTO post_assets (post_id, asset_id, sort_order) VALUES (?,?,0)",
            (post_id, shared),
        )
    conn.commit()

    names = [img.export_filename for p in collect_posts(conn) for img in p.images]

    assert len(names) == 2
    assert len(set(names)) == 2


import sqlite3

from worker.export.collect import CHANNEL_COLUMNS, collect_all, to_local

GENERATED_AT = "2026-07-24T19:30:00+00:00"


def test_channel_allow_list_excludes_every_secret():
    assert "access_token" not in CHANNEL_COLUMNS
    assert "token_expires_at" not in CHANNEL_COLUMNS


def test_channel_allow_list_rejects_any_secret_shaped_column_name():
    # Name-specific checks (above) only catch secrets we already know about. This
    # one is structural: it fails the moment ANYONE adds a future credential column
    # (refresh_token, client_secret, webhook_signing_key, api_key, ...) to the
    # allow-list, without needing to know its exact name in advance.
    secret_substrings = ("token", "secret", "password", "key", "credential")
    for column in CHANNEL_COLUMNS:
        lowered = column.lower()
        hits = [s for s in secret_substrings if s in lowered]
        assert not hits, (
            f"CHANNEL_COLUMNS contains {column!r}, which looks like a credential "
            f"(matches {hits}). This allow-list controls what the export is allowed "
            "to read from `channels` and ends up in files people drag into Google "
            "Drive — secret-shaped columns must never be added to it. If this is a "
            "genuine non-secret column, rename it to avoid the substring or update "
            "this test's rationale."
        )


def test_channel_allow_list_only_names_real_columns(conn):
    actual = {r[1] for r in conn.execute("PRAGMA table_info(channels)")}
    assert set(CHANNEL_COLUMNS) <= actual


def test_to_local_converts_utc_into_the_channel_timezone():
    assert to_local("2026-07-24T18:00:00+00:00", "America/New_York") == "2026-07-24 14:00"


def test_to_local_treats_naive_timestamps_as_utc():
    assert to_local("2026-07-24T18:00:00", "America/New_York") == "2026-07-24 14:00"


def test_to_local_falls_back_to_utc_for_an_unknown_timezone():
    assert to_local("2026-07-24T18:00:00+00:00", "Mars/Olympus") == "2026-07-24 18:00"


def test_to_local_returns_none_for_missing_timestamps():
    assert to_local(None, "UTC") is None


def test_collect_all_never_reads_the_access_token(conn, make_publication):
    make_publication()

    bundle = collect_all(conn, GENERATED_AT)

    assert len(bundle.channels) == 1
    assert not hasattr(bundle.channels[0], "access_token")


def test_collect_all_on_an_empty_database_returns_empty_lists(conn):
    bundle = collect_all(conn, GENERATED_AT)

    assert bundle.generated_at == GENERATED_AT
    assert bundle.posts == []
    assert bundle.sends == []
    assert bundle.metrics == []
    assert bundle.assets == []
    assert bundle.channels == []


def test_collect_all_builds_sends_with_local_and_utc_times(conn, make_publication):
    pub = make_publication()
    conn.execute("UPDATE channels SET timezone = 'America/New_York'")
    conn.execute(
        "UPDATE publications SET scheduled_at = '2026-07-24T18:00:00+00:00' WHERE id = ?",
        (pub["id"],),
    )
    conn.commit()

    send = collect_all(conn, GENERATED_AT).sends[0]

    assert send.scheduled_at_utc == "2026-07-24T18:00:00+00:00"
    assert send.scheduled_at_local == "2026-07-24 14:00"
    assert send.caption_preview == "hello world"


def test_rollups_count_only_real_posted_sends(conn, make_publication):
    pub = make_publication()
    post_id = pub["post_id"]
    channel_id = pub["channel_id"]
    conn.execute(
        "UPDATE publications SET status='posted', published_at='2026-07-01T12:00:00+00:00'"
        " WHERE id = ?",
        (pub["id"],),
    )
    # A dry run and a failure must not count toward times_posted.
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status, published_at,"
        " is_dry_run) VALUES (?,?,'2026-07-02T12:00:00+00:00','posted',"
        "'2026-07-02T12:00:00+00:00',1)",
        (post_id, channel_id),
    )
    conn.execute(
        "INSERT INTO publications (post_id, channel_id, scheduled_at, status)"
        " VALUES (?,?,'2026-07-03T12:00:00+00:00','failed')",
        (post_id, channel_id),
    )
    conn.commit()

    post = collect_all(conn, GENERATED_AT).posts[0]

    assert post.times_posted == 1
    assert post.last_posted_at == "2026-07-01T12:00:00+00:00"


def test_rollups_sum_only_the_latest_metric_snapshot_per_send(conn, make_publication):
    pub = make_publication()
    conn.execute("UPDATE publications SET status='posted' WHERE id = ?", (pub["id"],))
    for fetched, reach, likes in [
        ("2026-07-01T00:00:00+00:00", 100, 10),
        ("2026-07-05T00:00:00+00:00", 400, 40),
    ]:
        conn.execute(
            "INSERT INTO post_metrics (publication_id, fetched_at, reach, likes)"
            " VALUES (?,?,?,?)",
            (pub["id"], fetched, reach, likes),
        )
    conn.commit()

    bundle = collect_all(conn, GENERATED_AT)

    # Both snapshots are kept for charting, but the rollup counts the newest only.
    assert len(bundle.metrics) == 2
    assert bundle.posts[0].total_reach == 400
    assert bundle.posts[0].total_likes == 40


def test_rollups_do_not_double_count_same_fetched_at_snapshots(conn, make_publication):
    # Two snapshots for the SAME publication with the SAME fetched_at (the worker
    # computes one now_iso and reuses it across a batch). The rollup must pick a
    # single deterministic winner, never sum both.
    pub = make_publication()
    conn.execute("UPDATE publications SET status='posted' WHERE id = ?", (pub["id"],))
    conn.execute(
        "INSERT INTO post_metrics (publication_id, fetched_at, reach, likes)"
        " VALUES (?,?,?,?)",
        (pub["id"], "2026-07-10T00:00:00+00:00", 100, 10),
    )
    conn.execute(
        "INSERT INTO post_metrics (publication_id, fetched_at, reach, likes)"
        " VALUES (?,?,?,?)",
        (pub["id"], "2026-07-10T00:00:00+00:00", 400, 40),
    )
    conn.commit()

    bundle = collect_all(conn, GENERATED_AT)

    # Must equal the higher-id row's values (the tie-break winner), not the sum (500/50).
    assert bundle.posts[0].total_reach == 400
    assert bundle.posts[0].total_likes == 40


def test_collect_all_is_read_only_under_query_only(db_path):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON;")

    # Must not raise: every statement collect_all issues is a read.
    bundle = collect_all(conn, GENERATED_AT)

    assert bundle.posts == []
    conn.close()


# ---- channel groups ------------------------------------------------------------------
# A group's identity and membership are NOT recoverable from the channels pointing at it.
# Before this was collected, a restored backup silently returned every grouped channel to
# solo auto-fill: each would then pick its own content on its own days, which is exactly
# what grouping exists to prevent.
#
# The group's SCHEDULE is asserted on the lanes below instead — since migration 0028 it
# lives one row per surface in autofill_lanes, and the same-named columns here are frozen.

def test_channel_groups_are_backed_up(conn):
    gid = conn.execute(
        "INSERT INTO channel_groups (name, timezone) VALUES ('Personal','America/Los_Angeles')"
    ).lastrowid
    conn.commit()

    bundle = collect_all(conn, GENERATED_AT)

    assert len(bundle.channel_groups) == 1
    group = bundle.channel_groups[0]
    assert group.group_id == gid
    assert group.name == "Personal"
    assert group.timezone == "America/Los_Angeles"
    assert group.is_active is True


def test_a_channels_group_membership_is_backed_up(conn):
    """The group rows alone are not enough — without group_id every channel comes back
    ungrouped, and the restored groups would exist with nothing pointing at them."""
    gid = conn.execute(
        "INSERT INTO channel_groups (name) VALUES ('Personal')"
    ).lastrowid
    conn.execute(
        "INSERT INTO channels (platform, account_name, group_id)"
        " VALUES ('instagram', 'Grouped', ?)", (gid,),
    )
    conn.execute(
        "INSERT INTO channels (platform, account_name) VALUES ('threads', 'Solo')"
    )
    conn.commit()

    channels = {c.account_name: c.group_id for c in collect_all(conn, GENERATED_AT).channels}

    assert channels["Grouped"] == gid
    assert channels["Solo"] is None, "an ungrouped channel must stay ungrouped"


def test_group_export_still_carries_no_credentials(conn):
    """The channel allow-list exists to keep tokens out of a file people email around.
    Widening it for group_id must not have widened it for anything else."""
    conn.execute(
        "INSERT INTO channels (platform, account_name, access_token, token_expires_at)"
        " VALUES ('instagram', 'IG', 'SECRET-TOKEN', '2027-01-01')"
    )
    conn.commit()

    from dataclasses import asdict

    dumped = str([asdict(c) for c in collect_all(conn, GENERATED_AT).channels])

    assert "SECRET-TOKEN" not in dumped
    assert "access_token" not in dumped
    assert "token_expires_at" not in dumped


def test_bpp_marks_are_backed_up(conn):
    """Curation work — a judgement made post by post while reviewing stats — and it is not
    recoverable from anything else in the file. A restore without it silently loses the
    whole pool and the rotation quietly stops."""
    marked = conn.execute(
        "INSERT INTO posts (caption, post_type, is_bpp, bpp_marked_at)"
        " VALUES ('keeper','single',1,'2026-08-06T12:00:00+00:00')"
    ).lastrowid
    plain = conn.execute(
        "INSERT INTO posts (caption, post_type) VALUES ('ordinary','single')"
    ).lastrowid
    conn.commit()

    by_id = {p.post_id: p for p in collect_all(conn, GENERATED_AT).posts}

    assert by_id[marked].is_bpp is True
    assert by_id[marked].bpp_marked_at == "2026-08-06T12:00:00+00:00"
    assert by_id[plain].is_bpp is False, "an unmarked post must not come back marked"


# ---- auto-fill lanes -----------------------------------------------------------------
# Since migration 0028 the auto-fill config lives per (owner, surface) in autofill_lanes,
# and the columns it superseded on channels/channel_groups are frozen and unwritten. An
# export that kept emitting those columns would state a cadence the worker is not running
# — confidently, in a human-readable file — and would never show a Story lane at all.

def test_autofill_lanes_are_backed_up(conn):
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, timezone, remote_account_id,"
        "  access_token) VALUES ('instagram','Solo IG','America/Los_Angeles','a','t')"
    ).lastrowid
    gid = conn.execute(
        "INSERT INTO channel_groups (name, timezone) VALUES ('Personal','America/New_York')"
    ).lastrowid
    conn.execute(
        "INSERT INTO autofill_lanes (channel_id, surface, enabled, cadence_config,"
        "  min_queue_depth, target_queue_depth, reuse_min_age_days)"
        " VALUES (?, 'story', 1, '{\"mon\":1}', 2, 4, 30)", (cid,)
    )
    conn.execute(
        "INSERT INTO autofill_lanes (group_id, surface, enabled, cadence_config,"
        "  min_queue_depth, target_queue_depth, reuse_min_age_days)"
        " VALUES (?, 'feed', 0, '{\"fri\":1}', 3, 7, 90)", (gid,)
    )
    conn.commit()

    lanes = collect_all(conn, GENERATED_AT).autofill_lanes

    by_surface = {lane.surface: lane for lane in lanes}
    assert set(by_surface) == {"story", "feed"}

    story = by_surface["story"]
    assert (story.owner_kind, story.owner_id, story.owner_name) == ("channel", cid, "Solo IG")
    assert story.enabled is True
    assert story.cadence_config == '{"mon":1}'
    assert (story.min_queue_depth, story.target_queue_depth) == (2, 4)
    assert story.reuse_min_age_days == 30

    feed = by_surface["feed"]
    assert (feed.owner_kind, feed.owner_id, feed.owner_name) == ("group", gid, "Personal")
    assert feed.enabled is False
    assert feed.reuse_min_age_days == 90


def test_both_lanes_of_one_owner_are_backed_up(conn):
    """The whole point of lanes: one owner runs a feed rotation and a Story rotation on
    independent cadences. A backup that showed only one of them would misreport the
    install just as badly as showing the frozen column did."""
    cid = conn.execute(
        "INSERT INTO channels (platform, account_name, timezone, remote_account_id,"
        "  access_token) VALUES ('instagram','Solo IG','America/Los_Angeles','a','t')"
    ).lastrowid
    for surface, target in (("feed", 7), ("story", 3)):
        conn.execute(
            "INSERT INTO autofill_lanes (channel_id, surface, enabled, target_queue_depth)"
            " VALUES (?,?,1,?)", (cid, surface, target)
        )
    conn.commit()

    lanes = collect_all(conn, GENERATED_AT).autofill_lanes

    assert {(lane.surface, lane.target_queue_depth) for lane in lanes} == {
        ("feed", 7), ("story", 3)
    }


def test_the_superseded_autofill_columns_are_not_exported(conn):
    """Frozen since 0028. Emitting them makes the snapshot state a cadence the worker is
    not running, which is worse than omitting them — the reader has no way to tell."""
    from worker.export.collect import ExportedChannel, ExportedChannelGroup

    frozen = {
        "autofill_enabled", "cadence_config",
        "min_queue_depth", "target_queue_depth", "reuse_min_age_days",
    }
    for cls in (ExportedChannel, ExportedChannelGroup):
        leaked = frozen & set(cls.__dataclass_fields__)
        assert not leaked, f"{cls.__name__} still exports frozen columns: {sorted(leaked)}"
