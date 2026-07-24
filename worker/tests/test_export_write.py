"""Tests for turning an ExportBundle into files on disk."""

from __future__ import annotations

from worker.export.collect import ExportBundle, ExportedPost, PostImage
from worker.export.write import copy_images

GENERATED_AT = "2026-07-24T19:30:00+00:00"


def _bundle(posts):
    return ExportBundle(
        generated_at=GENERATED_AT, posts=posts, sends=[], metrics=[],
        assets=[], channels=[],
    )


def _post(post_id, images):
    return ExportedPost(
        post_id=post_id, caption="Test Post", first_comment=None, post_type="single",
        content_kind="evergreen", content_status="ready", status="draft",
        cooldown_days=None, created_by=None, created_at=None, updated_at=None,
        images=images,
    )


def _image(asset_id, name, storage_path, publish_path=None, published_name=None):
    return PostImage(
        asset_id=asset_id, sort_order=0, export_filename=name,
        published_filename=published_name, storage_path=storage_path,
        publish_path=publish_path,
    )


def test_copy_images_writes_originals_into_the_images_folder(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "a.jpg").write_bytes(b"original-bytes")
    out = tmp_path / "out"

    result = copy_images(
        _bundle([_post(42, [_image(1, "0042_test-post_1.jpg", "a.jpg")])]),
        asset_root=assets,
        out_dir=out,
    )

    assert result.copied == 1
    assert result.missing_asset_ids == set()
    assert (out / "images" / "0042_test-post_1.jpg").read_bytes() == b"original-bytes"


def test_copy_images_writes_conformed_copies_into_a_separate_folder(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "a.jpg").write_bytes(b"original-bytes")
    (assets / "a-pub.jpg").write_bytes(b"cropped-bytes")
    out = tmp_path / "out"

    copy_images(
        _bundle([_post(42, [_image(
            1, "0042_test-post_1.jpg", "a.jpg",
            publish_path="a-pub.jpg", published_name="0042_test-post_1.jpg",
        )])]),
        asset_root=assets,
        out_dir=out,
    )

    assert (out / "images" / "0042_test-post_1.jpg").read_bytes() == b"original-bytes"
    assert (out / "images-published" / "0042_test-post_1.jpg").read_bytes() == b"cropped-bytes"


def test_copy_images_skips_the_published_folder_when_nothing_was_conformed(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "a.jpg").write_bytes(b"x")
    out = tmp_path / "out"

    copy_images(
        _bundle([_post(42, [_image(1, "0042_test-post_1.jpg", "a.jpg")])]),
        asset_root=assets,
        out_dir=out,
    )

    assert not (out / "images-published").exists()


def test_copy_images_records_missing_files_instead_of_raising(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "present.jpg").write_bytes(b"here")
    out = tmp_path / "out"

    result = copy_images(
        _bundle([_post(42, [
            _image(1, "0042_test-post_1.jpg", "present.jpg"),
            _image(2, "0042_test-post_2.jpg", "gone.jpg"),
        ])]),
        asset_root=assets,
        out_dir=out,
    )

    # A partial backup you know is partial beats a crash and no backup.
    assert result.copied == 1
    assert result.missing_asset_ids == {2}
    assert len(result.problems) == 1
    assert "gone.jpg" in result.problems[0]


def test_copy_images_exports_a_shared_asset_once_per_post(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "shared.jpg").write_bytes(b"shared-bytes")
    out = tmp_path / "out"

    result = copy_images(
        _bundle([
            _post(42, [_image(1, "0042_test-post_1.jpg", "shared.jpg")]),
            _post(51, [_image(1, "0051_test-post_1.jpg", "shared.jpg")]),
        ]),
        asset_root=assets,
        out_dir=out,
    )

    assert result.copied == 2
    assert (out / "images" / "0042_test-post_1.jpg").exists()
    assert (out / "images" / "0051_test-post_1.jpg").exists()


def test_copy_images_handles_a_bundle_with_no_images(tmp_path):
    out = tmp_path / "out"

    result = copy_images(_bundle([_post(42, [])]), asset_root=tmp_path, out_dir=out)

    assert result.copied == 0
    assert result.missing_asset_ids == set()


def test_copy_images_missing_conformed_copy_does_not_mark_the_original_missing(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "a.jpg").write_bytes(b"original-bytes")
    out = tmp_path / "out"

    result = copy_images(
        _bundle([_post(42, [_image(
            1, "0042_test-post_1.jpg", "a.jpg",
            publish_path="gone-pub.jpg", published_name="0042_test-post_1.jpg",
        )])]),
        asset_root=assets,
        out_dir=out,
    )

    # The original exported fine — it must never be reported as missing just
    # because the conformed (Instagram-ready) copy wasn't there.
    assert result.copied == 1
    assert result.missing_asset_ids == set()
    assert len(result.problems) == 1
    assert "gone-pub.jpg" in result.problems[0]


def test_copy_images_missing_original_marks_the_asset_missing_even_if_conformed_copy_exists(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "a-pub.jpg").write_bytes(b"cropped-bytes")
    out = tmp_path / "out"

    result = copy_images(
        _bundle([_post(42, [_image(
            1, "0042_test-post_1.jpg", "gone.jpg",
            publish_path="a-pub.jpg", published_name="0042_test-post_1.jpg",
        )])]),
        asset_root=assets,
        out_dir=out,
    )

    assert result.missing_asset_ids == {1}
