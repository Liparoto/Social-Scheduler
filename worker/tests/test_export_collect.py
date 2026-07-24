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
