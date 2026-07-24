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
