"""Caption length must be counted the same way the target platform counts it.

The table here is duplicated verbatim in dashboard/lib/caption-length.test.ts. That
duplication is the point: the bug this guards against was the two languages disagreeing,
so both suites pin the same strings to the same numbers.
"""

from __future__ import annotations

import pytest

from worker.caption_length import caption_length

# (string, expected UTF-16 code units)
CASES = [
    ("", 0),
    ("hello", 5),
    ("\U0001f600", 2),  # grinning face — one code point, two UTF-16 units
    ("\U0001f44b\U0001f3fd", 4),  # waving hand + skin-tone modifier
    ("\U0001f468‍\U0001f469‍\U0001f467", 8),  # family: 3 emoji + 2 ZWJ
    ("Great day! \U0001f600\U0001f389\U0001f53a", 17),
    ("café", 4),  # a BMP accent still counts 1
]


@pytest.mark.parametrize("text,expected", CASES)
def test_counts_utf16_code_units(text, expected):
    assert caption_length(text) == expected


def test_differs_from_len_for_astral_characters():
    """The actual bug: Python's len() counts code points, so it under-counts emoji."""
    text = "\U0001f600"
    assert len(text) == 1
    assert caption_length(text) == 2


def test_no_bom_is_counted():
    """'utf-16' (not '-le') would prepend a 2-byte BOM and add a phantom character."""
    assert caption_length("a") == 1
