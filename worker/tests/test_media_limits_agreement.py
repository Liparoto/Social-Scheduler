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
    # severity is compared alongside kind (Finding 5, final review): before this, a case
    # like `expect: []` for discord's `varies` entry proved nothing about severity at
    # all, and the varies -> "warn" mapping could be reverted in ONE language with a
    # fully green suite, in the one test whose entire purpose is that the two languages
    # cannot diverge. message is deliberately NOT compared — see _coverage_note.
    got = sorted(
        (v.kind, v.severity)
        for v in media_limits.check(case["platform"], case["surface"], case["asset"])
    )
    expected_severity = case.get("expect_severity", "refuse")
    expect = sorted((kind, expected_severity) for kind in case["expect"])
    assert got == expect
