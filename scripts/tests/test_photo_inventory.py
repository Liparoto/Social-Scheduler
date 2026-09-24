"""Tests for the photo inspector.

The risky parts are the ones that quietly produce a wrong answer rather than an error:
a capture time read as midnight because the timezone was ignored, a sideways photo
reported as landscape, and two shots of the same moment surviving as two posts.
"""

from __future__ import annotations

import photo_inventory as pi


def write_jpeg(path, size=(400, 500), shot_at=None, offset=None, orientation=None,
               colour=(180, 60, 60)):
    from PIL import Image

    img = Image.new("RGB", size, colour)
    exif = img.getexif()
    if shot_at:
        exif[36867] = shot_at        # DateTimeOriginal
    if offset:
        exif[36881] = offset         # OffsetTimeOriginal
    if orientation:
        exif[274] = orientation      # Orientation
    # Pillow rejects exif=None outright, so a photo with no EXIF is saved without the
    # keyword at all — which is also what a stripped export really looks like.
    if len(exif):
        img.save(path, "JPEG", exif=exif)
    else:
        img.save(path, "JPEG")
    return path


def write_textured(path, shift=0, size=(400, 400)):
    """A photo-like image with enough variation for a perceptual hash to mean something."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", size, (30, 30, 30))
    d = ImageDraw.Draw(img)
    for i in range(8):
        d.rectangle([20 + i * 40 + shift, 30, 45 + i * 40 + shift, size[1] - 30],
                    fill=(220, 200 - i * 10, 60))
    img.save(path, "JPEG")
    return path


# -- shape ------------------------------------------------------------------------

def test_a_tall_photo_is_portrait():
    assert pi.orientation_of(1000, 1500) == "portrait"


def test_a_wide_photo_is_landscape():
    assert pi.orientation_of(1500, 1000) == "landscape"


def test_a_square_photo_is_square():
    assert pi.orientation_of(1000, 1000) == "square"


def test_a_sideways_photo_reports_the_dimensions_it_will_be_seen_at(tmp_path):
    """EXIF orientation 6 rotates the photo — the stored width is not the real width."""
    write_jpeg(tmp_path / "a.jpg", size=(400, 500), orientation=6)
    info = pi.inspect_photo(tmp_path / "a.jpg")
    assert (info["width"], info["height"]) == (500, 400)
    assert info["orientation"] == "landscape"


# -- when the photo was taken -----------------------------------------------------

def test_the_capture_time_is_read_from_the_photo_not_the_file_date(tmp_path):
    write_jpeg(tmp_path / "a.jpg", shot_at="2026:09:14 18:32:10")
    assert pi.inspect_photo(tmp_path / "a.jpg")["shot_at"] == "2026-09-14T18:32:10"


def test_the_cameras_own_utc_offset_is_kept(tmp_path):
    write_jpeg(tmp_path / "a.jpg", shot_at="2026:09:14 18:32:10", offset="+08:00")
    assert pi.inspect_photo(tmp_path / "a.jpg")["utc_offset"] == "+08:00"


def test_a_photo_with_no_capture_time_says_so_rather_than_guessing(tmp_path):
    write_jpeg(tmp_path / "a.jpg")
    info = pi.inspect_photo(tmp_path / "a.jpg")
    assert info["shot_at"] is None
    assert info["utc_offset"] is None


# -- where it was taken -----------------------------------------------------------

def test_southern_and_western_coordinates_come_back_negative():
    gps = {1: "S", 2: (33.0, 52.0, 0.0), 3: "W", 4: (151.0, 12.0, 0.0)}
    lat, lon = pi.gps_from_exif(gps)
    assert round(lat, 4) == -33.8667
    assert round(lon, 4) == -151.2


def test_northern_and_eastern_coordinates_stay_positive():
    gps = {1: "N", 2: (34.0, 30.0, 0.0), 3: "E", 4: (119.0, 45.0, 0.0)}
    lat, lon = pi.gps_from_exif(gps)
    assert round(lat, 4) == 34.5
    assert round(lon, 4) == 119.75


def test_a_photo_with_no_location_has_none():
    assert pi.gps_from_exif({}) is None


# -- near-duplicates --------------------------------------------------------------

def test_the_same_photo_twice_hashes_the_same(tmp_path):
    write_textured(tmp_path / "a.jpg")
    write_textured(tmp_path / "b.jpg")
    assert pi.dhash(tmp_path / "a.jpg") == pi.dhash(tmp_path / "b.jpg")


def test_two_copies_of_one_moment_are_grouped_together():
    inverted = ((1 << 64) - 1) ^ 0b1010101010  # 64-bit complement, not Python's negative ~
    hashes = {"full.jpg": 0b1010101010, "sneakpeek.jpg": 0b1010101010, "other.jpg": inverted}
    groups = pi.group_near_duplicates(hashes, threshold=6)
    assert ["full.jpg", "sneakpeek.jpg"] in [sorted(g) for g in groups]


def test_unrelated_photos_are_left_alone():
    hashes = {"a.jpg": 0, "b.jpg": (1 << 64) - 1}
    assert pi.group_near_duplicates(hashes, threshold=6) == []


# -- the folder -------------------------------------------------------------------

def test_every_photo_in_the_folder_is_listed(tmp_path):
    write_jpeg(tmp_path / "a.jpg")
    write_jpeg(tmp_path / "b.jpg", colour=(0, 200, 0))
    report = pi.inspect_folder(tmp_path)
    assert {p["file"] for p in report["photos"]} == {"a.jpg", "b.jpg"}
    assert report["count"] == 2


def test_files_that_are_not_photos_are_ignored(tmp_path):
    write_jpeg(tmp_path / "a.jpg")
    (tmp_path / ".DS_Store").write_bytes(b"junk")
    (tmp_path / "notes.txt").write_text("hello")
    report = pi.inspect_folder(tmp_path)
    assert {p["file"] for p in report["photos"]} == {"a.jpg"}


def test_the_folder_report_names_the_duplicate_groups(tmp_path):
    write_textured(tmp_path / "a.jpg")
    write_textured(tmp_path / "copy.jpg")
    report = pi.inspect_folder(tmp_path)
    assert [sorted(g) for g in report["duplicate_groups"]] == [["a.jpg", "copy.jpg"]]


def test_a_contact_sheet_is_written_for_each_chunk_of_photos(tmp_path):
    for i in range(5):
        write_jpeg(tmp_path / f"p{i}.jpg", colour=(i * 40, 60, 60))
    out = tmp_path / "sheets"
    written = pi.contact_sheets(tmp_path, sorted(f"p{i}.jpg" for i in range(5)), out,
                               per_sheet=2, cols=2)
    assert len(written) == 3
    assert all(p.exists() for p in written)


def test_photos_with_almost_no_detail_are_not_called_duplicates(tmp_path):
    """A flat image has no pattern to compare, so every flat image hashes alike.

    Left unguarded, a folder with a few sky or wall shots reports them all as the same
    moment, and a report that cries duplicate on everything gets ignored.
    """
    write_jpeg(tmp_path / "sky.jpg", colour=(120, 160, 200))
    write_jpeg(tmp_path / "wall.jpg", colour=(200, 190, 180))
    report = pi.inspect_folder(tmp_path)
    assert report["duplicate_groups"] == []
    assert sorted(report["too_plain_to_compare"]) == ["sky.jpg", "wall.jpg"]


def test_two_similar_detailed_photos_are_still_caught(tmp_path):
    write_textured(tmp_path / "a.jpg", shift=0)
    write_textured(tmp_path / "b.jpg", shift=2)
    report = pi.inspect_folder(tmp_path)
    assert [sorted(g) for g in report["duplicate_groups"]] == [["a.jpg", "b.jpg"]]
    assert report["too_plain_to_compare"] == []


# -- malformed EXIF (found in review) ----------------------------------------------

def test_an_all_zero_capture_date_counts_as_no_capture_date():
    """Cameras that don't know the date write 0000:00:00 00:00:00."""
    assert pi.parse_shot_time({36867: "0000:00:00 00:00:00"}) == (None, None)


def test_an_unparseable_capture_date_counts_as_no_capture_date():
    assert pi.parse_shot_time({36867: "not a date at all"}) == (None, None)


def test_a_real_capture_date_still_comes_through():
    assert pi.parse_shot_time({36867: "2026:09:14 18:32:10"})[0] == "2026-09-14T18:32:10"


def test_malformed_coordinates_report_no_location_instead_of_crashing():
    """One photo with odd GPS must not take the whole folder scan down with it."""
    assert pi.gps_from_exif({1: "N", 2: (34.0, 30.0), 3: "E", 4: (119.0, 45.0, 0.0)}) is None
    assert pi.gps_from_exif({1: "N", 2: "garbage", 3: "E", 4: (119.0, 45.0, 0.0)}) is None
