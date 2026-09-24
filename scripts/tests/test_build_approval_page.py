"""Tests for the approval-page builder.

These cover the parts that can silently corrupt a batch: how a plan becomes the import
manifest, how photos and captions are checked before anyone reviews them, how one round
is compared against the last, and how imported post ids are matched back to the plan.
"""

from __future__ import annotations

import pytest

import build_approval_page as bap


def plan(**overrides):
    """A minimal valid plan, overridable per test."""
    base = {
        "batch": "test-batch",
        "label": "Test Batch",
        "photos_dir": "/photos",
        "round": 1,
        "posts": [
            {"files": ["a.jpg"], "caption": "First body", "hashtags": ["#One", "#Two"]},
        ],
    }
    base.update(overrides)
    return base


def test_single_photo_post_becomes_a_single_in_the_manifest():
    m = bap.manifest_from_plan(plan())
    assert m["posts"][0]["type"] == "single"
    assert m["posts"][0]["files"] == ["a.jpg"]


def test_several_photos_become_one_carousel_in_the_manifest():
    m = bap.manifest_from_plan(plan(posts=[
        {"files": ["a.jpg", "b.jpg", "c.jpg"], "caption": "Body", "hashtags": ["#X"]},
    ]))
    assert m["posts"][0]["type"] == "carousel"
    assert m["posts"][0]["files"] == ["a.jpg", "b.jpg", "c.jpg"]


def test_manifest_carries_the_photos_dir_the_importer_uploads_from():
    m = bap.manifest_from_plan(plan(photos_dir="/somewhere/else"))
    assert m["images_dir"] == "/somewhere/else"


def test_hashtags_are_appended_below_the_caption_body():
    caption = bap.compose_caption(
        {"caption": "A body", "hashtags": ["#One", "#Two"]}, credit=None
    )
    assert caption == "A body\n\n#One #Two"


def test_credit_sits_between_the_body_and_the_hashtags():
    caption = bap.compose_caption(
        {"caption": "A body", "hashtags": ["#One"]}, credit="📸 @someone"
    )
    assert caption == "A body\n\n📸 @someone\n\n#One"


def test_a_post_with_no_hashtags_keeps_a_clean_caption():
    caption = bap.compose_caption({"caption": "A body", "hashtags": []}, credit=None)
    assert caption == "A body"


def test_refs_are_numbered_in_plan_order_when_the_plan_omits_them():
    p = plan(posts=[
        {"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]},
        {"files": ["b.jpg"], "caption": "y", "hashtags": ["#B"]},
    ])
    bap.assign_refs(p)
    assert [post["ref"] for post in p["posts"]] == ["P-01", "P-02"]


def test_a_plans_own_ref_prefix_is_used():
    p = plan(ref_prefix="W", posts=[{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    assert p["posts"][0]["ref"] == "W-01"


def test_a_ref_written_by_hand_is_left_alone():
    p = plan(posts=[{"ref": "KEEP-ME", "files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    assert p["posts"][0]["ref"] == "KEEP-ME"


# -- validation -------------------------------------------------------------------

def test_a_valid_plan_reports_no_problems():
    assert bap.validate(plan()) == []


def test_the_same_photo_in_two_posts_is_a_problem():
    problems = bap.validate(plan(posts=[
        {"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]},
        {"files": ["a.jpg"], "caption": "y", "hashtags": ["#B"]},
    ]))
    assert any("a.jpg" in p and "twice" in p for p in problems)


def test_two_posts_sharing_an_identical_hashtag_set_is_a_problem():
    problems = bap.validate(plan(posts=[
        {"files": ["a.jpg"], "caption": "x", "hashtags": ["#A", "#B"]},
        {"files": ["b.jpg"], "caption": "y", "hashtags": ["#b", "#a"]},
    ]))
    assert any("same hashtags" in p for p in problems)


def test_a_post_with_no_photos_is_a_problem():
    problems = bap.validate(plan(posts=[
        {"files": [], "caption": "x", "hashtags": ["#A"]},
    ]))
    assert any("no photos" in p for p in problems)


def test_an_empty_caption_is_a_problem():
    problems = bap.validate(plan(posts=[
        {"files": ["a.jpg"], "caption": "   ", "hashtags": ["#A"]},
    ]))
    assert any("caption" in p for p in problems)


def test_an_unknown_time_of_day_is_a_problem():
    problems = bap.validate(plan(posts=[
        {"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"], "time_of_day": "dusk"},
    ]))
    assert any("dusk" in p for p in problems)


def test_a_photo_missing_from_the_folder_is_a_problem(tmp_path):
    (tmp_path / "a.jpg").write_bytes(b"x")
    problems = bap.validate(plan(photos_dir=str(tmp_path), posts=[
        {"files": ["a.jpg", "gone.jpg"], "caption": "x", "hashtags": ["#A"]},
    ]), check_files=True)
    assert any("gone.jpg" in p for p in problems)


def test_reusing_one_hashtag_across_posts_is_counted_not_forbidden():
    p = plan(posts=[
        {"files": ["a.jpg"], "caption": "x", "hashtags": ["#Shared", "#A"]},
        {"files": ["b.jpg"], "caption": "y", "hashtags": ["#Shared", "#B"]},
    ])
    assert bap.validate(p) == []
    assert bap.hashtag_frequency(p)["#Shared"] == 2


# -- comparing this round against the last ----------------------------------------

def previous_round():
    p = plan(round=1, posts=[
        {"files": ["a.jpg", "b.jpg"], "caption": "Old body", "hashtags": ["#Old"]},
        {"files": ["c.jpg"], "caption": "Second", "hashtags": ["#Second"]},
    ])
    bap.assign_refs(p)
    return p


def annotated(posts):
    p = plan(round=2, posts=posts)
    bap.assign_refs(p)
    bap.diff_against_previous(p, previous_round())
    return p["posts"]


def test_a_post_of_photos_never_seen_before_is_labelled_new():
    post = annotated([{"files": ["z.jpg"], "caption": "x", "hashtags": ["#Z"]}])[0]
    assert post["was_label"] == "new post"
    assert post["is_new"] is True


def test_an_untouched_post_names_its_old_ref_and_is_not_flagged():
    post = annotated([
        {"files": ["a.jpg", "b.jpg"], "caption": "Old body", "hashtags": ["#Old"]},
    ])[0]
    assert post["was_label"] == "was P-01"
    assert post["files_changed"] is False
    assert post["caption_changed"] is False
    assert post["hashtags_changed"] is False


def test_a_post_merged_from_two_old_posts_names_both():
    post = annotated([
        {"files": ["a.jpg", "b.jpg", "c.jpg"], "caption": "x", "hashtags": ["#X"]},
    ])[0]
    assert post["was_label"] == "was P-01 + P-02"
    assert post["files_changed"] is True


def test_reordering_the_photos_counts_as_changed():
    post = annotated([
        {"files": ["b.jpg", "a.jpg"], "caption": "Old body", "hashtags": ["#Old"]},
    ])[0]
    assert post["files_changed"] is True
    assert post["caption_changed"] is False


def test_a_rewritten_caption_is_flagged_without_flagging_the_photos():
    post = annotated([
        {"files": ["a.jpg", "b.jpg"], "caption": "Brand new body", "hashtags": ["#Old"]},
    ])[0]
    assert post["caption_changed"] is True
    assert post["files_changed"] is False


def test_changed_hashtags_are_flagged_on_their_own():
    post = annotated([
        {"files": ["a.jpg", "b.jpg"], "caption": "Old body", "hashtags": ["#Fresh"]},
    ])[0]
    assert post["hashtags_changed"] is True
    assert post["caption_changed"] is False


def test_each_round_gets_its_own_highlight_colour():
    colours = {bap.round_highlight(n) for n in range(1, 6)}
    assert len(colours) == 5
    assert bap.round_highlight(2) == bap.round_highlight(2)


def test_highlight_colours_wrap_around_for_a_long_review():
    assert bap.round_highlight(1) == bap.round_highlight(1 + bap.HIGHLIGHT_COUNT)


# -- matching imported post ids back onto the plan ---------------------------------

def test_the_key_matches_the_importers_own_key_exactly():
    """If these two ever disagree, every post id is matched to the wrong post."""
    import import_manifest

    entry = {"files": ["a.jpg", "b.jpg"], "caption": "x"}
    assert bap.post_key(entry["files"]) == import_manifest.post_key(entry)


def runlog(*records):
    import json
    return [json.dumps(r) for r in records]


def test_each_post_is_matched_to_the_id_the_importer_created():
    p = plan(posts=[
        {"files": ["a.jpg", "b.jpg"], "caption": "First", "hashtags": ["#A"]},
        {"files": ["c.jpg"], "caption": "Second", "hashtags": ["#B"]},
    ])
    bap.assign_refs(p)
    batch = bap.tag_batch(p, runlog(
        {"key": "a.jpg|b.jpg", "post_id": 340, "files": ["a.jpg", "b.jpg"]},
        {"key": "c.jpg", "post_id": 341, "files": ["c.jpg"]},
    ))
    assert [row["id"] for row in batch["posts"]] == [340, 341]


def test_the_matched_caption_is_the_full_composed_one():
    p = plan(credit="📸 @someone", posts=[
        {"files": ["a.jpg"], "caption": "Body", "hashtags": ["#A"]},
    ])
    bap.assign_refs(p)
    batch = bap.tag_batch(p, runlog({"key": "a.jpg", "post_id": 7, "files": ["a.jpg"]}))
    assert batch["posts"][0]["caption"] == "Body\n\n📸 @someone\n\n#A"


def test_topic_tags_and_time_of_day_travel_with_the_post():
    p = plan(posts=[{
        "files": ["a.jpg"], "caption": "Body", "hashtags": ["#A"],
        "tags": ["Wedding", "Getting Ready"], "time_of_day": "morning",
    }])
    bap.assign_refs(p)
    row = bap.tag_batch(p, runlog({"key": "a.jpg", "post_id": 7, "files": ["a.jpg"]}))["posts"][0]
    assert row["tags"] == ["Wedding", "Getting Ready"]
    assert row["time_of_day"] == "morning"


def test_a_post_with_no_seasonal_window_stays_year_round():
    p = plan(posts=[{"files": ["a.jpg"], "caption": "Body", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    row = bap.tag_batch(p, runlog({"key": "a.jpg", "post_id": 7, "files": ["a.jpg"]}))["posts"][0]
    assert row.get("green_periods", []) == []


def test_a_post_the_importer_never_created_is_refused_by_name():
    p = plan(posts=[{"ref": "W-09", "files": ["a.jpg"], "caption": "Body", "hashtags": ["#A"]}])
    with pytest.raises(ValueError, match="W-09"):
        bap.tag_batch(p, runlog())


def test_a_torn_final_runlog_line_is_ignored():
    p = plan(posts=[{"files": ["a.jpg"], "caption": "Body", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    lines = runlog({"key": "a.jpg", "post_id": 7, "files": ["a.jpg"]}) + ['{"key": "b.jpg", "post']
    assert bap.tag_batch(p, lines)["posts"][0]["id"] == 7


# -- the page ----------------------------------------------------------------------

def rendered(posts, previews=None, **plan_kw):
    p = plan(posts=posts, **plan_kw)
    bap.assign_refs(p)
    return bap.render_page(p, previews or {})


def test_the_page_declares_utf8_so_emoji_survive():
    """Served over localhost without this, every emoji renders as mojibake."""
    html = rendered([{"files": ["a.jpg"], "caption": "Cheers 🥂", "hashtags": ["#A"]}])
    assert 'charset="utf-8"' in html.lower()
    assert "🥂" in html


def test_every_caption_body_appears_on_the_page():
    html = rendered([
        {"files": ["a.jpg"], "caption": "The first body", "hashtags": ["#A"]},
        {"files": ["b.jpg"], "caption": "The second body", "hashtags": ["#B"]},
    ])
    assert "The first body" in html
    assert "The second body" in html


def test_markup_inside_a_caption_is_escaped_not_rendered():
    html = rendered([
        {"files": ["a.jpg"], "caption": "Bride & <b>groom</b>", "hashtags": ["#A"]},
    ])
    assert "<b>groom</b>" not in html
    assert "Bride &amp; &lt;b&gt;groom&lt;/b&gt;" in html


def test_each_photo_is_listed_in_carousel_order_with_its_filename():
    html = rendered([
        {"files": ["second.jpg", "first.jpg"], "caption": "x", "hashtags": ["#A"]},
    ])
    assert html.index("second.jpg") < html.index("first.jpg")


def test_a_preview_image_is_embedded_when_one_was_built():
    html = rendered(
        [{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}],
        previews={"a.jpg": "data:image/jpeg;base64,AAAA"},
    )
    assert "data:image/jpeg;base64,AAAA" in html


def test_a_photo_with_no_preview_still_renders_a_card():
    html = rendered([{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}], previews={})
    assert "a.jpg" in html
    assert "no preview" in html.lower()


def test_a_caption_changed_this_round_is_marked_in_this_rounds_colour():
    p = plan(round=3, posts=[{"files": ["a.jpg"], "caption": "New", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    p["posts"][0].update(caption_changed=True, was_label="was P-01", is_new=False,
                         files_changed=False, hashtags_changed=False)
    html = bap.render_page(p, {})
    assert bap.round_highlight(3) in html


def test_an_unchanged_post_is_not_marked():
    p = plan(round=3, posts=[{"files": ["a.jpg"], "caption": "Same", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    p["posts"][0].update(caption_changed=False, was_label="was P-01", is_new=False,
                         files_changed=False, hashtags_changed=False)
    html = bap.render_page(p, {})
    assert bap.round_highlight(3) not in html


def test_where_a_post_came_from_is_shown_when_rounds_were_compared():
    p = plan(posts=[{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    p["posts"][0].update(was_label="was P-04 + P-09", is_new=False, files_changed=True,
                         caption_changed=False, hashtags_changed=False)
    assert "was P-04 + P-09" in bap.render_page(p, {})


def test_left_out_photos_are_listed_with_the_reason():
    html = rendered(
        [{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}],
        excluded={"dupe.jpg": "near-duplicate of a.jpg"},
    )
    assert "dupe.jpg" in html
    assert "near-duplicate of a.jpg" in html


# -- previews (needs Pillow) -------------------------------------------------------

def write_jpeg(path, size=(400, 500), orientation=None):
    from PIL import Image

    img = Image.new("RGB", size, (180, 60, 60))
    if orientation is None:
        img.save(path, "JPEG")
        return path
    exif = img.getexif()
    exif[274] = orientation  # 274 = Orientation
    img.save(path, "JPEG", exif=exif)
    return path


def test_a_preview_is_an_embedded_base64_jpeg(tmp_path):
    write_jpeg(tmp_path / "a.jpg")
    previews = bap.build_previews(tmp_path, ["a.jpg"], max_width=120)
    assert previews["a.jpg"].startswith("data:image/jpeg;base64,")


def test_a_preview_is_downscaled_to_the_requested_width(tmp_path):
    import base64
    import io

    from PIL import Image

    write_jpeg(tmp_path / "a.jpg", size=(1600, 1200))
    uri = bap.build_previews(tmp_path, ["a.jpg"], max_width=200)["a.jpg"]
    raw = base64.b64decode(uri.split(",", 1)[1])
    assert Image.open(io.BytesIO(raw)).width == 200


def test_a_sideways_photo_is_previewed_the_way_it_will_be_seen(tmp_path):
    """EXIF orientation 6 means "rotate 90°" — ignoring it shows portraits on their side."""
    import base64
    import io

    from PIL import Image

    write_jpeg(tmp_path / "a.jpg", size=(400, 500), orientation=6)
    uri = bap.build_previews(tmp_path, ["a.jpg"], max_width=100)["a.jpg"]
    img = Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1])))
    assert img.width > img.height


def test_a_photo_that_is_not_there_is_simply_left_without_a_preview(tmp_path):
    previews = bap.build_previews(tmp_path, ["missing.jpg"], max_width=100)
    assert "missing.jpg" not in previews


def test_the_header_shows_the_folder_name_with_the_full_path_on_hover():
    """A long absolute path wraps to several lines on a phone and tells the reviewer nothing."""
    html = rendered([{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}],
                    photos_dir="/Users/someone/Desktop/P3. Bali")
    assert ">P3. Bali<" in html
    assert 'title="/Users/someone/Desktop/P3. Bali"' in html


def test_a_carousel_over_the_platform_limit_is_a_problem():
    """Instagram takes at most 10 slides; an 11th imports fine and fails at publish time."""
    problems = bap.validate(plan(posts=[
        {"files": [f"p{i}.jpg" for i in range(11)], "caption": "x", "hashtags": ["#A"]},
    ]))
    assert any("10" in p for p in problems)


def test_a_carousel_at_the_limit_is_fine():
    assert bap.validate(plan(posts=[
        {"files": [f"p{i}.jpg" for i in range(10)], "caption": "x", "hashtags": ["#A"]},
    ])) == []


def test_a_file_type_the_importer_cannot_upload_is_a_problem():
    """The importer only sends jpg/jpeg/png/webp; anything else dies mid-import."""
    problems = bap.validate(plan(posts=[
        {"files": ["clip.heic"], "caption": "x", "hashtags": ["#A"]},
    ]))
    assert any("clip.heic" in p for p in problems)


def test_the_supported_types_match_the_importers_own_list():
    import import_manifest

    assert bap.UPLOADABLE_SUFFIXES == set(import_manifest.MIME_BY_EXT)


# -- advisory warnings (don't block the build, but must be seen) -------------------

def test_a_plan_with_nothing_wrong_raises_no_warnings():
    assert bap.warnings(plan(), shapes={}, folder_files=["a.jpg"]) == []


def test_a_photo_in_the_folder_that_is_in_no_post_is_named(tmp_path):
    w = bap.warnings(plan(), shapes={}, folder_files=["a.jpg", "forgotten.jpg"])
    assert any("forgotten.jpg" in m for m in w)


def test_a_photo_left_out_on_purpose_is_not_warned_about():
    p = plan(excluded={"dropped.jpg": "blurry"})
    assert bap.warnings(p, shapes={}, folder_files=["a.jpg", "dropped.jpg"]) == []


def test_a_carousel_mixing_portrait_and_landscape_is_warned_about():
    p = plan(posts=[{"files": ["tall.jpg", "wide.jpg"], "caption": "x", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    w = bap.warnings(p, shapes={"tall.jpg": "portrait", "wide.jpg": "landscape"},
                     folder_files=["tall.jpg", "wide.jpg"])
    assert any("shape" in m for m in w)


def test_a_carousel_of_one_shape_is_not_warned_about():
    p = plan(posts=[{"files": ["a.jpg", "b.jpg"], "caption": "x", "hashtags": ["#A"]}])
    bap.assign_refs(p)
    assert bap.warnings(p, shapes={"a.jpg": "portrait", "b.jpg": "portrait"},
                        folder_files=["a.jpg", "b.jpg"]) == []


def test_one_hashtag_carrying_most_of_the_batch_is_warned_about():
    p = plan(posts=[
        {"files": ["a.jpg"], "caption": "x", "hashtags": ["#Everywhere", "#A"]},
        {"files": ["b.jpg"], "caption": "y", "hashtags": ["#Everywhere", "#B"]},
        {"files": ["c.jpg"], "caption": "z", "hashtags": ["#Everywhere", "#C"]},
        {"files": ["d.jpg"], "caption": "w", "hashtags": ["#Rare", "#D"]},
    ])
    w = bap.warnings(p, shapes={}, folder_files=["a.jpg", "b.jpg", "c.jpg", "d.jpg"])
    assert any("#Everywhere" in m for m in w)


def test_a_tag_used_by_half_the_batch_is_left_alone():
    p = plan(posts=[
        {"files": ["a.jpg"], "caption": "x", "hashtags": ["#Shared", "#A"]},
        {"files": ["b.jpg"], "caption": "y", "hashtags": ["#Shared", "#B"]},
        {"files": ["c.jpg"], "caption": "z", "hashtags": ["#C"]},
        {"files": ["d.jpg"], "caption": "w", "hashtags": ["#D"]},
    ])
    assert bap.warnings(p, shapes={}, folder_files=[f"{c}.jpg" for c in "abcd"]) == []


# -- open questions ----------------------------------------------------------------

def test_a_question_on_a_post_is_shown_prominently():
    html = rendered([
        {"files": ["a.jpg"], "caption": "Placeholder", "hashtags": ["#A"],
         "question": "Who are the two people on the left?"},
    ])
    assert "Who are the two people on the left?" in html
    assert "question" in html.lower()


def test_the_header_counts_the_posts_waiting_on_an_answer():
    html = rendered([
        {"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"], "question": "Where is this?"},
        {"files": ["b.jpg"], "caption": "y", "hashtags": ["#B"]},
    ])
    assert "1 needs an answer" in html


def test_no_question_means_no_banner():
    html = rendered([{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}])
    assert "needs an answer" not in html


# -- where the posts are headed ----------------------------------------------------

def test_the_page_says_where_these_posts_are_going():
    html = rendered([{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}],
                    channels=[1, 2, 4], channels_label="Instagram · Threads · Facebook")
    assert "Instagram · Threads · Facebook" in html


def test_channels_with_no_label_still_show_their_ids():
    html = rendered([{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}],
                    channels=[1, 4])
    assert "1, 4" in html


def test_a_plan_with_no_channels_says_they_are_not_chosen_yet():
    html = rendered([{"files": ["a.jpg"], "caption": "x", "hashtags": ["#A"]}])
    assert "not chosen yet" in html.lower()


# -- unaccounted photos are shown to the owner, not just warned in a terminal -------

def test_photos_in_no_post_are_listed_on_the_page():
    p = plan()
    bap.assign_refs(p)
    html = bap.render_page(p, {}, unaccounted=["stray.jpg"])
    assert "stray.jpg" in html


# -- the command line --------------------------------------------------------------

def run_cli(tmp_path, plan_dict, *args):
    import json
    import subprocess
    import sys
    from pathlib import Path

    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(plan_dict), encoding="utf-8")
    script = Path(__file__).resolve().parents[1] / "build_approval_page.py"
    return subprocess.run(
        [sys.executable, str(script), str(plan_path), "--out-dir", str(tmp_path / "out"), *args],
        capture_output=True, text=True,
    )


def demo_plan(tmp_path):
    write_jpeg(tmp_path / "a.jpg")
    return plan(photos_dir=str(tmp_path), round=1,
                posts=[{"files": ["a.jpg"], "caption": "Body", "hashtags": ["#A"]}])


def test_a_structure_only_run_does_not_overwrite_the_round_snapshot(tmp_path):
    """The snapshot is the record of what the reviewer saw and what round 2 diffs against."""
    p = demo_plan(tmp_path)
    assert run_cli(tmp_path, p).returncode == 0
    snapshot = tmp_path / "out" / "plan-round-1.json"
    original = snapshot.read_text()

    p["posts"][0]["caption"] = "Something I typed while drafting round 2"
    assert run_cli(tmp_path, p, "--no-previews").returncode == 0
    assert snapshot.read_text() == original


def test_the_run_prints_the_import_command_with_the_plans_own_channels(tmp_path):
    p = demo_plan(tmp_path)
    p["channels"] = [1, 2, 4]
    out = run_cli(tmp_path, p).stdout
    assert "--channels 1,2,4" in out


def test_warnings_are_printed_where_they_cannot_be_missed(tmp_path):
    p = demo_plan(tmp_path)
    write_jpeg(tmp_path / "forgotten.jpg")
    out = run_cli(tmp_path, p).stdout
    assert "forgotten.jpg" in out


def test_a_plan_with_real_problems_exits_nonzero(tmp_path):
    p = demo_plan(tmp_path)
    p["posts"][0]["caption"] = "  "
    result = run_cli(tmp_path, p)
    assert result.returncode == 1
    assert "caption" in result.stderr


# -- review findings ---------------------------------------------------------------

def test_a_post_with_no_caption_key_is_reported_not_crashed():
    p = plan(posts=[{"files": ["a.jpg"], "hashtags": ["#A"]}])
    assert any("caption" in m for m in bap.validate(p))
    assert bap.manifest_from_plan(p)["posts"][0]["caption"] == "#A"


def test_photos_the_importer_cannot_upload_still_count_as_unaccounted(tmp_path):
    """40 iPhone .heic files left out of every post must not pass silently."""
    p = demo_plan(tmp_path)
    (tmp_path / "IMG_9.heic").write_bytes(b"not really a heic, but it is in the folder")
    assert "IMG_9.heic" in run_cli(tmp_path, p).stdout


def test_a_rebuild_of_an_already_recorded_round_keeps_the_original_snapshot(tmp_path):
    p = demo_plan(tmp_path)
    assert run_cli(tmp_path, p).returncode == 0
    snapshot = tmp_path / "out" / "plan-round-1.json"
    original = snapshot.read_text()

    p["posts"][0]["caption"] = "Edited after the page was sent"
    result = run_cli(tmp_path, p)
    assert result.returncode == 0
    assert snapshot.read_text() == original
    assert "round" in result.stdout.lower()
