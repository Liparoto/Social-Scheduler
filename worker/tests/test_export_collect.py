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
