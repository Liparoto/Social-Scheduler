"""Put `scripts/` on the import path so the review-prep helpers can be imported.

The scripts are run as files (`python3 scripts/build_approval_page.py`), not installed as
a package, so there is no `scripts.` module path to import. Adding the directory itself
keeps the scripts runnable as scripts while still letting tests exercise their functions
directly — no `__init__.py`, no packaging, no change to how they are invoked.
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
