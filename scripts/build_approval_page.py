#!/usr/bin/env python3
"""Turn a batch plan into a visual approval page, an import manifest and a tag batch.

One plan file is the source of truth for a batch. Everything a reviewer sees and
everything the importer creates is generated from it, so the page somebody approves and
the posts that actually land in the library cannot drift apart.

Plan format (JSON):

    {
      "batch": "wedding-day",            # short slug, used in filenames
      "label": "Wedding Day",            # shown on the page
      "photos_dir": "/path/to/photos",
      "round": 1,                        # bump on every rebuild after feedback
      "ref_prefix": "W",                 # optional; post refs become W-01, W-02, ...
      "credit": "📸 @photographer",      # optional; appended to every caption
      "posts": [
        {
          "files": ["M0091.jpg", "M0063.jpg"],   # carousel order IS this order
          "caption": "The body of the caption",
          "hashtags": ["#GroomsTux", "#BlackTie"],
          "tags": ["Wedding", "Getting Ready"],  # library topic tags, not hashtags
          "time_of_day": "anytime",
          "green_periods": [],                   # seasonal RESTRICTION; usually empty
          "note": "optional note to the reviewer",
          "approved": true                       # owner already OK'd it; page marks it done
        }
      ],
      "excluded": {"IMG_1.jpg": "near-duplicate of IMG_2.jpg"}
    }

Usage:
    # build the page + manifest (add --previous to badge what changed since last round)
    python3 scripts/build_approval_page.py plan.json --out-dir data/import-work/wedding
    python3 scripts/build_approval_page.py plan.json --out-dir OUT --previous plan-r1.json

    # after the import, map the created post ids back onto the plan
    python3 scripts/build_approval_page.py plan.json --tags-out tags.json \
        --runlog data/import-work/wedding/manifest.json.runlog.jsonl
"""

from __future__ import annotations

import argparse
import base64
import html
import io
import json
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TIME_BANDS = {"morning", "afternoon", "evening", "anytime"}
# Instagram publishes at most 10 slides in a carousel. Nothing on the draft path enforces
# it, so an 11-slide post imports cleanly and then fails when the worker tries to publish.
MAX_CAROUSEL = 10
# What import_manifest.py can actually upload. A .heic straight off a phone is rejected
# mid-import, after some of the batch is already in — cheaper to catch in the plan.
UPLOADABLE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
# What counts as "a photo in this folder" when checking that nothing was silently dropped.
# Deliberately wider than what the importer accepts: a folder of iPhone .heic files that
# ended up in no post is exactly what the owner needs told about.
PHOTO_SUFFIXES = UPLOADABLE_SUFFIXES | {".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp"}


def compose_caption(post: dict, credit: str | None) -> str:
    """The exact text that will be posted: body, then credit, then hashtags.

    Each part is its own paragraph. Built in one place so the approval page and the
    import manifest can never show the reviewer one caption and publish another.
    """
    parts = [(post.get("caption") or "").strip()]
    if credit:
        parts.append(credit.strip())
    hashtags = post.get("hashtags") or []
    if hashtags:
        parts.append(" ".join(hashtags))
    return "\n\n".join(p for p in parts if p)


def assign_refs(plan: dict) -> None:
    """Give every post a stable label ("W-01") for the page and for talking in chat.

    Refs are how a reviewer says "change P-12", so they are assigned in plan order and a
    hand-written ref is never overwritten.
    """
    prefix = plan.get("ref_prefix", "P")
    for i, post in enumerate(plan["posts"], start=1):
        post.setdefault("ref", f"{prefix}-{i:02d}")


def manifest_from_plan(plan: dict) -> dict:
    """The manifest scripts/import_manifest.py consumes."""
    posts = []
    for post in plan["posts"]:
        files = list(post["files"])
        posts.append({
            "type": "carousel" if len(files) > 1 else "single",
            "files": files,
            "caption": compose_caption(post, plan.get("credit")),
        })
    return {"images_dir": plan["photos_dir"], "posts": posts}


def hashtag_frequency(plan: dict) -> Counter:
    """How often each hashtag is used across the batch, case-insensitively.

    Reused tags are fine and expected in a themed set — this is here so the page can show
    the reviewer which ones are carrying most of the batch, not to forbid anything.

    Counted case-insensitively but reported under the spelling first used, so #SantaYnez
    and #santaynez are one row on the page rather than two.
    """
    spelling: dict[str, str] = {}
    counts: Counter = Counter()
    for post in plan["posts"]:
        for tag in post.get("hashtags", []):
            display = spelling.setdefault(tag.lower(), tag)
            counts[display] += 1
    return counts


def validate(plan: dict, check_files: bool = False) -> list[str]:
    """Everything wrong with this plan, as plain sentences. Empty list means it is sound.

    Reported all at once rather than raising on the first one: a reviewer fixing a plan
    wants the whole list, not one problem per run.
    """
    problems: list[str] = []
    posts = plan["posts"]

    seen: dict[str, int] = {}
    for i, post in enumerate(posts, start=1):
        label = post.get("ref") or f"post {i}"

        files = post.get("files") or []
        if not files:
            problems.append(f"{label}: no photos")
        if len(files) > MAX_CAROUSEL:
            problems.append(
                f"{label}: {len(files)} photos — a carousel holds at most {MAX_CAROUSEL}"
            )
        for name in files:
            if Path(name).suffix.lower() not in UPLOADABLE_SUFFIXES:
                problems.append(
                    f"{label}: {name} is not a type the importer can upload "
                    f"({', '.join(sorted(UPLOADABLE_SUFFIXES))})"
                )
            if name in seen:
                problems.append(
                    f"{label}: {name} is used twice — also in post {seen[name]}"
                )
            else:
                seen[name] = i

        if not (post.get("caption") or "").strip():
            problems.append(f"{label}: caption is empty")

        band = post.get("time_of_day")
        if band is not None and band not in TIME_BANDS:
            problems.append(
                f"{label}: {band!r} is not a time of day "
                f"({', '.join(sorted(TIME_BANDS))})"
            )

    # Two posts carrying an identical hashtag set read as duplicates to the platforms and
    # to anyone scrolling the account, even when the photos differ.
    sets: dict[frozenset[str], str] = {}
    for i, post in enumerate(posts, start=1):
        label = post.get("ref") or f"post {i}"
        key = frozenset(t.lower() for t in post.get("hashtags", []))
        if not key:
            continue
        if key in sets:
            problems.append(f"{label}: same hashtags as {sets[key]}")
        else:
            sets[key] = label

    if check_files:
        folder = Path(plan["photos_dir"])
        for i, post in enumerate(posts, start=1):
            label = post.get("ref") or f"post {i}"
            for name in post.get("files") or []:
                if not (folder / name).exists():
                    problems.append(f"{label}: {name} is not in {folder}")

    return problems


def orientation_map(photos_dir: Path, names: list[str]) -> dict[str, str]:
    """filename -> portrait / landscape / square, after the rotation flag is applied.

    Reads the header only: the point is the shape a viewer will see, and decoding 200
    photos to learn it would cost seconds for nothing.
    """
    from PIL import Image

    shapes: dict[str, str] = {}
    for name in names:
        path = photos_dir / name
        if not path.exists():
            continue
        with Image.open(path) as img:
            width, height = img.size
            if int(img.getexif().get(274, 1) or 1) in {5, 6, 7, 8}:
                width, height = height, width
        shapes[name] = ("square" if width == height
                        else "portrait" if height > width else "landscape")
    return shapes


def unaccounted_photos(plan: dict, folder_files: list[str]) -> list[str]:
    """Photos in the folder that are in no post and not listed as deliberately left out."""
    used = {n for post in plan["posts"] for n in post.get("files") or []}
    excluded = set(plan.get("excluded") or {})
    return [n for n in folder_files if n not in used and n not in excluded]


def warnings(plan: dict, shapes: dict[str, str], folder_files: list[str]) -> list[str]:
    notes = [
        f"{p.get('ref', '?')}: was approved, but changed since — shown as needing review again"
        for p in plan["posts"] if p.get("approval_dropped")
    ]
    return notes + _shape_and_folder_warnings(plan, shapes, folder_files)


def _shape_and_folder_warnings(
    plan: dict, shapes: dict[str, str], folder_files: list[str]
) -> list[str]:
    """Things worth a second look that should not stop the build.

    Separate from validate(): these are judgement calls the owner may well have made on
    purpose, and blocking on them would push people into working around the tool while
    drafting. They are printed loudly and, where the owner needs to see them, shown on
    the page itself.
    """
    notes: list[str] = []

    stray = unaccounted_photos(plan, folder_files)
    if stray:
        shown = ", ".join(stray[:8]) + ("…" if len(stray) > 8 else "")
        notes.append(
            f"{len(stray)} photo(s) in the folder are in no post and not listed as left "
            f"out: {shown}"
        )

    # Instagram crops every slide of a carousel to the first slide's shape, so a landscape
    # photo behind a portrait cover loses its sides.
    for i, post in enumerate(plan["posts"], start=1):
        label = post.get("ref") or f"post {i}"
        found = {shapes[n] for n in post.get("files") or [] if n in shapes}
        if len(found) > 1:
            notes.append(
                f"{label}: mixes {' and '.join(sorted(found))} in one carousel — every "
                "slide gets cropped to the first one's shape"
            )

    # One tag on most of the batch makes the whole set look like a single repeated post.
    total = len(plan["posts"])
    if total >= 3:
        for tag, count in hashtag_frequency(plan).most_common():
            if count > total / 2:
                notes.append(
                    f"{tag} is on {count} of {total} posts — spread the batch wider"
                )

    return notes


# A different colour per round, so a reviewer can tell this round's edits from the ones
# they asked for two rounds ago. Deliberately readable on both the light and dark page.
HIGHLIGHTS = ["#f0b429", "#4fb0c6", "#c46bd6", "#6bd68f", "#ef7d57"]
HIGHLIGHT_COUNT = len(HIGHLIGHTS)


def round_highlight(round_no: int) -> str:
    """The highlight colour for edits made in this round."""
    return HIGHLIGHTS[(round_no - 1) % HIGHLIGHT_COUNT]


def diff_against_previous(plan: dict, previous: dict) -> None:
    """Annotate each post with where it came from and what changed since last round.

    Derived from the previous plan rather than written by hand: a human (or an AI) keeping
    "this was post 12" labels up to date by hand gets them wrong, and a wrong label sends
    the reviewer's edit to the wrong post.
    """
    prev_ref_of: dict[str, str] = {}
    prev_by_ref: dict[str, dict] = {}
    for i, post in enumerate(previous["posts"], start=1):
        ref = post.get("ref") or f"{previous.get('ref_prefix', 'P')}-{i:02d}"
        prev_by_ref[ref] = post
        for name in post.get("files") or []:
            prev_ref_of[name] = ref

    order = list(prev_by_ref)
    for post in plan["posts"]:
        refs: list[str] = []
        for name in post.get("files") or []:
            ref = prev_ref_of.get(name)
            if ref and ref not in refs:
                refs.append(ref)
        refs.sort(key=order.index)

        post["is_new"] = not refs
        approved_before = bool(post.get("approved"))
        post["was_label"] = "new post" if not refs else "was " + " + ".join(refs)

        # Caption and hashtag comparisons only mean something when the post has exactly
        # one ancestor. Merged or split posts are flagged as changed photos instead —
        # claiming "caption changed" against one of two ancestors would be arbitrary.
        source = prev_by_ref[refs[0]] if len(refs) == 1 else None
        if source is None:
            post["files_changed"] = not post["is_new"]
            post["caption_changed"] = False
            post["hashtags_changed"] = False
            _revoke_if_changed(post, approved_before)
            continue

        post["files_changed"] = list(source.get("files") or []) != list(post.get("files") or [])
        post["caption_changed"] = (
            (source.get("caption") or "").strip() != (post.get("caption") or "").strip()
        )
        post["hashtags_changed"] = (
            list(source.get("hashtags") or []) != list(post.get("hashtags") or [])
        )
        _revoke_if_changed(post, approved_before)


def _revoke_if_changed(post: dict, approved_before: bool) -> None:
    """Approval covers what was on the page. A post that changed since must be re-shown,
    so it loses its approval here rather than relying on whoever edited the plan."""
    changed = post.get("is_new") or post.get("files_changed") or post.get(
        "caption_changed") or post.get("hashtags_changed")
    if approved_before and changed:
        post["approved"] = False
        post["approval_dropped"] = True


def post_key(files: list[str]) -> str:
    """Stable identity for a post, matching import_manifest.post_key byte for byte.

    Defined here rather than imported so this script never needs the dashboard's HTTP
    dependencies just to map ids. A test asserts the two formulas agree — if they ever
    drift, every post id would be matched to the wrong post's tags.
    """
    return "|".join(files)


def load_runlog(lines) -> dict[str, int]:
    """post_key -> post id, from the run log import_manifest.py appends to as it goes."""
    ids: dict[str, int] = {}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue  # a torn final line from an interrupted run
        if rec.get("post_id"):
            ids[rec["key"]] = rec["post_id"]
    return ids


def tag_batch(plan: dict, runlog_lines) -> dict:
    """The batch scripts/apply_library_metadata.py consumes, with real post ids.

    Post ids only exist after the import, so they are read back out of the importer's run
    log and matched by the post's photo list. Hand-typing an id range here is how a tag
    lands on somebody else's post.
    """
    ids = load_runlog(runlog_lines)
    rows = []
    for post in plan["posts"]:
        key = post_key(list(post.get("files") or []))
        pid = ids.get(key)
        if pid is None:
            raise ValueError(
                f"{post.get('ref', key)}: no imported post found for {key} — "
                "did the import finish, and is this the right run log?"
            )
        row = {
            "id": pid,
            "caption": compose_caption(post, plan.get("credit")),
            "tags": list(post.get("tags") or []),
        }
        if post.get("time_of_day"):
            row["time_of_day"] = post["time_of_day"]
        # Attaching a green period RESTRICTS a post to that window, so an empty list is
        # written through as "no restriction" rather than guessed at from the photos.
        row["green_periods"] = list(post.get("green_periods") or [])
        rows.append(row)
    return {"posts": rows}


PAGE_CSS = """
:root {
  color-scheme: light dark;
  --bg: #f6f6f4; --card: #ffffff; --ink: #1c1c1a; --muted: #6b6b66;
  --line: #e2e2dd; --accent: #2f6f8f; --chip: #eef1f0;
  --ok: #2e7d4f; --ok-bg: #e3f2e8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14151a; --card: #1c1e25; --ink: #eceef2; --muted: #9aa0ab;
    --line: #2c2f38; --accent: #7fc4e0; --chip: #262a33;
    --ok: #7fd3a0; --ok-bg: #1f3328;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 16px 64px; background: var(--bg); color: var(--ink);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 860px; margin: 0 auto; }
header { padding: 32px 0 20px; border-bottom: 1px solid var(--line); }
h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 14px; }
.counts { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 8px; }
.count {
  background: var(--chip); border-radius: 999px; padding: 4px 12px; font-size: 13px;
}
.legend { margin-top: 14px; font-size: 13px; color: var(--muted); }
.gate {
  margin: 20px 0 0; padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--card); font-size: 14px;
}
.post {
  background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  padding: 18px; margin: 20px 0;
}
.post-head {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin-bottom: 4px;
}
.ref { font-weight: 650; font-size: 17px; }
.was { color: var(--muted); font-size: 13px; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 14px; }
.badge {
  font-size: 12px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid var(--accent); color: var(--accent);
}
.strip {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px; margin-bottom: 16px;
}
.cell { min-width: 0; }
/* Landscape photos keep their shape so the reviewer can tell them apart at a glance. */
.cell.landscape { grid-column: span 2; }
.cell.landscape img { aspect-ratio: auto; }
.cell img {
  width: 100%; aspect-ratio: 4 / 5; object-fit: cover; border-radius: 9px;
  background: var(--chip); display: block;
}
.cell .none {
  width: 100%; aspect-ratio: 4 / 5; border-radius: 9px; background: var(--chip);
  display: flex; align-items: center; justify-content: center;
  color: var(--muted); font-size: 12px;
}
.cell figcaption {
  margin-top: 5px; font-size: 11px; color: var(--muted);
  overflow-wrap: anywhere;
}
.caption { white-space: pre-wrap; margin: 0 0 12px; }
.tags { font-size: 14px; color: var(--accent); overflow-wrap: anywhere; }
.meta { margin-top: 12px; font-size: 13px; color: var(--muted); }
.note {
  margin-top: 12px; font-size: 14px; padding: 9px 12px; border-radius: 9px;
  background: var(--chip);
}
.question {
  margin-top: 12px; font-size: 14px; padding: 9px 12px; border-radius: 9px;
  background: var(--chip); border-left: 3px solid var(--accent);
}
.post.approved { border-left: 4px solid var(--ok); }
.post.approved .strip { opacity: 0.8; }
.status {
  font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
}
.status.ok { background: var(--ok-bg); color: var(--ok); }
.status.todo { background: var(--chip); color: var(--ink); }
.count.ok { background: var(--ok-bg); color: var(--ok); font-weight: 600; }
.excluded { margin: 32px 0 0; padding-top: 20px; border-top: 1px solid var(--line); }
.excluded h2 { font-size: 16px; margin: 0 0 10px; }
.excluded li { font-size: 14px; color: var(--muted); margin-bottom: 5px; }
.freq { margin-top: 10px; font-size: 13px; color: var(--muted); }
"""


def _text(value) -> str:
    """Escape for a text node, leaving quotes readable."""
    return html.escape(str(value), quote=False)


def _attr(value) -> str:
    """Escape for an attribute value."""
    return html.escape(str(value), quote=True)


def _photo_cell(name: str, preview: str | None, index: int, shape: str = "") -> str:
    inner = (
        f'<img src="{_attr(preview)}" alt="{_attr(name)}" loading="lazy">'
        if preview
        else '<div class="none">no preview</div>'
    )
    return (
        f'<figure class="cell {_attr(shape)}">'
        f"{inner}"
        f'<figcaption>{index}. {_text(name)}</figcaption>'
        "</figure>"
    )


def render_page(
    plan: dict,
    previews: dict[str, str],
    unaccounted: list[str] | None = None,
    shapes: dict[str, str] | None = None,
) -> str:
    """The self-contained approval page: one card per post, in plan order.

    Self-contained on purpose (previews embedded, no external CSS or fonts) so it can be
    opened from a plain local web server, mailed to somebody, or kept as the record of what
    was actually approved.
    """
    posts = plan["posts"]
    round_no = plan.get("round", 1)
    edit_colour = round_highlight(round_no)
    # The highlight only exists on the page when something is actually highlighted —
    # a colour key for edits that aren't there just trains the reviewer to ignore it.
    edited = [p for p in posts if p.get("caption_changed") or p.get("hashtags_changed")]

    photo_count = sum(len(p.get("files") or []) for p in posts)
    excluded = plan.get("excluded") or {}
    questions = [p for p in posts if (p.get("question") or "").strip()]
    approved = [p for p in posts if p.get("approved")]

    out: list[str] = []
    out.append("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">")
    out.append('<meta name="viewport" content="width=device-width, initial-scale=1">')
    out.append(f"<title>{_text(plan.get('label', plan.get('batch', 'Batch')))} — review</title>")
    out.append(f"<style>{PAGE_CSS}")
    if edited:
        out.append(
            ".edited { border-left: 3px solid %s; padding-left: 10px; }"
            ".edit-key { color: %s; font-weight: 600; }" % (edit_colour, edit_colour)
        )
    out.append("</style></head><body><div class=\"wrap\">")

    out.append("<header>")
    out.append(f"<h1>{_text(plan.get('label', plan.get('batch', 'Batch')))}</h1>")
    folder = plan.get("photos_dir", "")
    out.append(
        f'<div class="sub">Round {_text(round_no)} · '
        f'<span title="{_attr(folder)}">{_text(Path(folder).name or folder)}</span></div>'
    )
    out.append('<div class="counts">')
    out.append(f'<span class="count">{len(posts)} posts</span>')
    out.append(f'<span class="count">{photo_count} photos</span>')
    if excluded:
        out.append(f'<span class="count">{len(excluded)} left out</span>')
    if plan.get("credit"):
        out.append(f'<span class="count">credit: {_text(plan["credit"])}</span>')
    if approved:
        out.append(
            f'<span class="count ok">✓ {len(approved)} approved · '
            f'{len(posts) - len(approved)} to review</span>'
        )
    if questions:
        out.append(f'<span class="count">{len(questions)} needs an answer</span>')
    # Where these are headed is part of what is being approved, not a flag typed later.
    channels = plan.get("channels") or []
    label = plan.get("channels_label")
    if label:
        destination = str(label)
    elif channels:
        destination = "channels " + ", ".join(str(c) for c in channels)
    else:
        destination = "channels not chosen yet"
    out.append(f'<span class="count">→ {_text(destination)}</span>')
    out.append("</div>")
    if edited:
        out.append(
            '<div class="legend">Captions and hashtags you asked me to change this round '
            f'are marked <span class="edit-key">in this colour</span> '
            f"({len(edited)} of them).</div>"
        )
    out.append(
        '<div class="gate">Nothing has been imported yet. Reply with edits, or say the '
        "word and these go into the library.</div>"
    )
    out.append("</header>")

    for post in posts:
        is_approved = bool(post.get("approved"))
        out.append(f'<article class="post{" approved" if is_approved else ""}">')
        out.append('<div class="post-head">')
        out.append(f'<span class="ref">{_text(post.get("ref", ""))}</span>')
        # Only labelled once something is approved — on a fresh batch every post needs
        # review, and a "needs review" tag on all of them says nothing.
        if is_approved:
            out.append('<span class="status ok">✓ Approved — no need to look again</span>')
        elif approved or post.get("approval_dropped"):
            label = ("Changed since you approved it — please re-check"
                     if post.get("approval_dropped") else "Needs your review")
            out.append(f'<span class="status todo">{_text(label)}</span>')
        if post.get("was_label"):
            out.append(f'<span class="was">{_text(post["was_label"])}</span>')
        out.append("</div>")

        badges = []
        if post.get("files_changed"):
            badges.append("photos changed")
        if post.get("caption_changed"):
            badges.append("new caption")
        if post.get("hashtags_changed"):
            badges.append("new hashtags")
        if badges:
            out.append('<div class="badges">')
            out.extend(f'<span class="badge">{_text(b)}</span>' for b in badges)
            out.append("</div>")

        out.append('<div class="strip">')
        for i, name in enumerate(post.get("files") or [], start=1):
            out.append(_photo_cell(name, previews.get(name), i, (shapes or {}).get(name, "")))
        out.append("</div>")

        caption_class = "caption edited" if post.get("caption_changed") else "caption"
        out.append(f'<p class="{caption_class}">{_text(post.get("caption", ""))}</p>')

        hashtags = post.get("hashtags") or []
        if hashtags:
            tag_class = "tags edited" if post.get("hashtags_changed") else "tags"
            out.append(f'<div class="{tag_class}">{_text(" ".join(hashtags))}</div>')

        meta = []
        if post.get("tags"):
            meta.append("library tags: " + ", ".join(post["tags"]))
        if post.get("time_of_day"):
            meta.append("time of day: " + post["time_of_day"])
        if post.get("green_periods"):
            meta.append("only posts during: " + ", ".join(post["green_periods"]))
        if meta:
            out.append(f'<div class="meta">{_text(" · ".join(meta))}</div>')

        if post.get("question"):
            out.append(
                f'<div class="question"><strong>Question for you:</strong> '
                f'{_text(post["question"])}</div>'
            )
        if post.get("note"):
            out.append(f'<div class="note">{_text(post["note"])}</div>')
        out.append("</article>")

    if unaccounted:
        out.append('<section class="excluded"><h2>Not in any post</h2>')
        out.append(
            '<div class="freq">These are in the folder but in no post above, and no reason '
            "was recorded. Say whether they should be used or dropped.</div><ul>"
        )
        for name in unaccounted:
            out.append(f"<li><strong>{_text(name)}</strong></li>")
        out.append("</ul></section>")

    if excluded:
        out.append('<section class="excluded"><h2>Left out of this batch</h2><ul>')
        for name, reason in excluded.items():
            out.append(f"<li><strong>{_text(name)}</strong> — {_text(reason)}</li>")
        out.append("</ul></section>")

    repeated = [(t, n) for t, n in hashtag_frequency(plan).most_common() if n > 1]
    if repeated:
        out.append('<section class="excluded"><h2>Hashtags used more than once</h2>')
        out.append(
            '<div class="freq">'
            + _text(", ".join(f"{t} ×{n}" for t, n in repeated))
            + "</div></section>"
        )

    out.append("</div></body></html>")
    return "\n".join(out)


def build_previews(
    photos_dir: Path, names: list[str], max_width: int = 520, quality: int = 72
) -> dict[str, str]:
    """Small embedded previews, keyed by filename. Missing photos are simply skipped.

    Downscaled hard: a page of 200 full-size photos is hundreds of megabytes and will not
    open. EXIF orientation is applied first, so a portrait shot from a phone appears the
    way the reviewer will see it rather than on its side.
    """
    from PIL import Image, ImageOps

    previews: dict[str, str] = {}
    for name in names:
        path = photos_dir / name
        if not path.exists():
            continue
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGB")
            if img.width > max_width:
                height = round(img.height * max_width / img.width)
                img = img.resize((max_width, height), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=quality, optimize=True)
        encoded = base64.b64encode(buf.getvalue()).decode("ascii")
        previews[name] = f"data:image/jpeg;base64,{encoded}"
    return previews


def load_plan(path: Path) -> dict:
    plan = json.loads(path.read_text(encoding="utf-8"))
    for field in ("batch", "photos_dir", "posts"):
        if field not in plan:
            sys.exit(f"{path}: plan is missing {field!r}")
    if not plan["posts"]:
        sys.exit(f"{path}: plan has no posts")
    return plan


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Build the approval page, import manifest and tag batch for a photo batch.",
    )
    ap.add_argument("plan", type=Path, help="Batch plan JSON.")
    ap.add_argument(
        "--out-dir", type=Path, default=None,
        help="Where to write outputs (default: data/import-work/<batch>).",
    )
    ap.add_argument(
        "--previous", type=Path, default=None,
        help="Last round's plan, to badge what changed since then.",
    )
    ap.add_argument("--preview-width", type=int, default=520)
    ap.add_argument(
        "--no-previews", action="store_true",
        help="Skip the embedded photos (fast, but not reviewable — for checking structure).",
    )
    ap.add_argument(
        "--tags-out", type=Path, default=None,
        help="Write the metadata batch for apply_library_metadata.py here (needs --runlog).",
    )
    ap.add_argument("--runlog", type=Path, default=None, help="The importer's run log.")
    args = ap.parse_args()

    plan = load_plan(args.plan)
    assign_refs(plan)
    photos_dir = Path(plan["photos_dir"])

    problems = validate(plan, check_files=photos_dir.is_dir())
    if problems:
        print("Refusing to build — fix the plan first:", file=sys.stderr)
        for p in problems:
            print(f"  {p}", file=sys.stderr)
        return 1

    # After the import: map the created post ids back onto the plan and stop.
    if args.tags_out:
        if not args.runlog:
            sys.exit("--tags-out needs --runlog (the importer writes one per manifest)")
        batch = tag_batch(plan, args.runlog.read_text(encoding="utf-8").splitlines())
        args.tags_out.parent.mkdir(parents=True, exist_ok=True)
        args.tags_out.write_text(json.dumps(batch, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote {args.tags_out} — {len(batch['posts'])} posts.")
        return 0

    if args.previous:
        diff_against_previous(plan, load_plan(args.previous))

    out_dir = args.out_dir or REPO_ROOT / "data" / "import-work" / plan["batch"]
    out_dir.mkdir(parents=True, exist_ok=True)

    names = [n for post in plan["posts"] for n in post["files"]]
    previews = {} if args.no_previews else build_previews(
        photos_dir, names, max_width=args.preview_width
    )

    folder_files = (
        sorted(f.name for f in photos_dir.iterdir()
               if f.is_file() and f.suffix.lower() in PHOTO_SUFFIXES
               and not f.name.startswith("."))
        if photos_dir.is_dir() else []
    )
    shapes = orientation_map(photos_dir, names) if photos_dir.is_dir() else {}
    stray = unaccounted_photos(plan, folder_files)

    page = out_dir / "approval.html"
    page.write_text(render_page(plan, previews, unaccounted=stray, shapes=shapes), encoding="utf-8")

    manifest = out_dir / "manifest.json"
    manifest.write_text(
        json.dumps(manifest_from_plan(plan), indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Keep this round's plan beside the page: it is what the NEXT round diffs against, and
    # the record of exactly what was on the page the reviewer saw. A previews-less run is a
    # draft check, not something anyone saw, so it must never overwrite that record.
    snapshot = out_dir / f"plan-round-{plan.get('round', 1)}.json"
    snapshot_text = json.dumps(plan, indent=2, ensure_ascii=False)
    if snapshot.exists() and snapshot.read_text(encoding="utf-8") != snapshot_text:
        # Never overwrite a recorded round: that file is the evidence of what the owner was
        # shown, and the next round's diff is taken against it. A changed rebuild of the
        # same round is a new round.
        print(f"  kept      {snapshot} — it already records round "
              f"{plan.get('round', 1)}; bump \"round\" in the plan to record this rebuild")
    else:
        snapshot.write_text(snapshot_text, encoding="utf-8")
        print(f"  snapshot  {snapshot}")

    photo_count = sum(len(p["files"]) for p in plan["posts"])
    size_mb = page.stat().st_size / 1_000_000
    print(f"{len(plan['posts'])} posts · {photo_count} photos · page {size_mb:.1f} MB")
    print(f"  page      {page}")
    print(f"  manifest  {manifest}")
    if not previews and not args.no_previews:
        print("  WARNING: no previews were built — is the photo folder right?")

    for note in warnings(plan, shapes, folder_files):
        print(f"  CHECK: {note}")

    channels = ",".join(str(c) for c in plan.get("channels") or [])
    print("\nAfter the owner approves (never before):")
    print(f"  .venv/bin/python scripts/import_manifest.py --manifest {manifest} \\")
    print(f"      --channels {channels or '<ids>'} --kind evergreen --status ready \\")
    print(f"      --created-by {plan['batch']} --dry-run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
