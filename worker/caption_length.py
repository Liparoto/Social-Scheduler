"""How long is a caption, in the units the target platform actually counts?

Python's built-in len() counts CODE POINTS. Every platform this app enforces a limit for
counts UTF-16 CODE UNITS, in which any character outside the Basic Multilingual Plane —
every emoji — counts 2, and a ZWJ sequence counts the sum of its parts plus its joiners.

That gap was a real bug, not a theoretical one. The dashboard (JavaScript, natively UTF-16)
and this worker disagreed by 3 on a caption as ordinary as "Great day! 😀🎉🔺" — 14 here,
17 there. The worker is the authoritative gate (see dashboard/lib/platforms.ts's header), so
it was the side letting an over-length caption through to be refused by the platform at send
time: a post that reads "scheduled" and then dies terminally. CLAUDE.md requires failed
publishes to be visibly failed; under-counting made them fail LATE instead of never starting.

Per-platform units, researched rather than assumed:

  - Telegram   UTF-16 code units. VERIFIED — its entities spec is explicit that BMP
               characters count 1 and everything else counts 2.
  - Discord    UTF-16 code units. VERIFIED — an emoji costs 2 and a ZWJ family costs 7+,
               consistent with its JavaScript origins.
  - Threads    UNKNOWN. Meta documents "500 characters" without ever defining the unit, and
               third-party trackers actively contradict each other (1 vs 2 per emoji).
               UTF-16 is chosen because it is the STRICTER of the two candidates: counting
               high can only warn early, while counting low lets a caption through that dies
               terminally on publish. This is a SAFE DEFAULT, not something Meta confirmed.
               If it is ever confirmed, update the table in
               docs/superpowers/specs/2026-08-07-emoji-picker-design.md.
  - Instagram
    / Facebook No limit is enforced by this app (their captionChars maps are empty).

Mirrored by dashboard/lib/caption-length.ts, whose tests pin the same strings to the same
numbers. If you change one, change both.
"""

from __future__ import annotations


def caption_length(text: str) -> int:
    """The caption's length in UTF-16 code units — what the platforms count."""
    # Encoding to UTF-16 and halving the byte count is the direct definition of "how many
    # UTF-16 code units is this". 'utf-16-le' rather than plain 'utf-16' on purpose: the
    # plain codec prepends a 2-byte byte-order mark, which would add one phantom character
    # to every caption ever measured.
    return len(text.encode("utf-16-le")) // 2
