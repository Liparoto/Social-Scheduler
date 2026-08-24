"""Both languages, one matrix, identical verdicts.

This is the payoff of the shared file. Before it, the composer and the worker could
disagree about whether a send was publishable and nobody found out until it failed.
Here, disagreement is a failing test.
"""

import json
from pathlib import Path

import pytest

from worker import media_limits

MATRIX = Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "media-limits-matrix.json"


def _cases():
    return json.loads(MATRIX.read_text())["cases"]


@pytest.mark.parametrize("case", _cases(), ids=lambda c: f"{c['platform']}/{c['surface']}")
def test_python_matches_the_shared_matrix(case):
    # test_media_limits.py monkeypatches media_limits.RAW_PATH and calls
    # load_limits.cache_clear() to load fixture data in several of its tests, but never
    # clears the cache again afterward. load_limits() is @lru_cache(maxsize=1) - a
    # process-wide cache - so the LAST such test to run (e.g. the empty-platforms-dict
    # case) leaves it holding fixture data rather than the real file, for every test
    # that runs after it in the same process, including this one. Force a fresh read of
    # the real file so this test's outcome does not depend on suite ordering.
    media_limits.load_limits.cache_clear()
    got = sorted(v.kind for v in media_limits.check(case["platform"], case["surface"], case["asset"]))
    assert got == sorted(case["expect"])
