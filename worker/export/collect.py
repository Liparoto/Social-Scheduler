"""Read-only extraction of the install's content into plain dataclasses.

Pure by design: give it a connection, get back an ExportBundle. No filesystem
writes and no network, so the hard parts — the relational reads and the rollups —
are testable without touching disk.
"""

from __future__ import annotations

import re
import unicodedata

_NON_ALNUM = re.compile(r"[^a-zA-Z0-9]+")


def slugify(text: str | None, max_length: int = 40) -> str:
    """Filename-safe ASCII slug. Emoji-only and empty captions become 'untitled'.

    Google Drive and non-ASCII filenames get along badly, so we strip rather than
    percent-encode: a human reading the folder matters more than round-tripping.
    """
    if not text:
        return "untitled"
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_text = decomposed.encode("ascii", "ignore").decode("ascii")
    slug = _NON_ALNUM.sub("-", ascii_text).strip("-").lower()
    return slug[:max_length].strip("-") or "untitled"
