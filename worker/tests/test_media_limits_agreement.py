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
    got = sorted(v.kind for v in media_limits.check(case["platform"], case["surface"], case["asset"]))
    assert got == sorted(case["expect"])
