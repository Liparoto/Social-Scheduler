#!/usr/bin/env python3
"""Import a manifest of image posts into the dashboard as Draft posts.

Reads a manifest describing posts (one or more images each, plus an optional
caption), uploads every image through the dashboard's own upload route, then
creates one Draft post per manifest entry.

This talks to the LOCAL dashboard over HTTP rather than writing SQLite directly,
so uploads get the same hashing, dedup, conform-to-spec and thumbnailing every
other import path gets, and posts get the same validation the composer gets.

Manifest format (JSON):

    {
      "images_dir": "/absolute/path/to/images",
      "posts": [
        {"type": "carousel", "files": ["a.jpg", "b.jpg"], "caption": "hi"},
        {"type": "single",   "files": ["c.jpg"],          "caption": ""}
      ]
    }

Everything lands as content_status=draft, so nothing can auto-publish. Re-running
is safe: images dedup by content hash server-side, and posts already recorded in
the run log are skipped.

Usage:
    .venv/bin/python scripts/import_manifest.py --manifest path/to/manifest.json --dry-run
    .venv/bin/python scripts/import_manifest.py --manifest path/to/manifest.json --channels 1,2
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

import requests

DEFAULT_BASE_URL = "http://localhost:3939"
TIMEOUT = 120  # image conform + thumbnail on a large JPEG is not instant

MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}


def post_key(entry: dict[str, Any]) -> str:
    """Stable identity for a manifest entry, so re-runs can skip what's done."""
    return "|".join(entry["files"])


def load_done(log_path: str) -> dict[str, int]:
    """Map of post_key -> post id, from a previous (possibly partial) run."""
    done: dict[str, int] = {}
    if not os.path.exists(log_path):
        return done
    with open(log_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue  # a torn final line from an interrupted run
            if rec.get("post_id"):
                done[rec["key"]] = rec["post_id"]
    return done


def upload_image(session: requests.Session, base_url: str, path: str) -> dict[str, Any]:
    """Upload one image; returns the asset record. Deduped by hash server-side."""
    ext = os.path.splitext(path)[1].lower()
    mime = MIME_BY_EXT.get(ext)
    if not mime:
        raise ValueError(f"Unsupported image type {ext!r} for {path}")
    with open(path, "rb") as fh:
        resp = session.post(
            f"{base_url}/api/assets/upload",
            files={"file": (os.path.basename(path), fh, mime)},
            timeout=TIMEOUT,
        )
    if resp.status_code != 200:
        raise RuntimeError(f"upload failed ({resp.status_code}): {resp.text[:300]}")
    body = resp.json()
    asset = body.get("asset")
    if not asset or "id" not in asset:
        raise RuntimeError(f"upload returned no asset: {str(body)[:300]}")
    return {"id": asset["id"], "deduped": bool(body.get("deduped"))}


def create_draft(
    session: requests.Session,
    base_url: str,
    asset_ids: list[int],
    caption: str,
    channels: list[int],
    kind: str,
    status: str,
    created_by: str,
) -> int:
    payload: dict[str, Any] = {
        "asset_ids": asset_ids,
        "caption": caption,
        "content_kind": kind,
        "content_status": status,
        "created_by": created_by,
    }
    # A caption must ALSO be written as the generic (platform=null) variant, the same way
    # createDraftPostsBulk does it. posts.caption alone still publishes — _select_caption
    # falls back to it — but the edit screen reads variants, so a caption saved only on
    # posts.caption shows up as an empty caption box.
    if caption:
        payload["caption_variants"] = [{"platform": None, "body": caption, "sort_order": 0}]
    if channels:
        payload["target_channel_ids"] = channels
    resp = session.post(f"{base_url}/api/posts/draft", json=payload, timeout=TIMEOUT)
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"draft failed ({resp.status_code}): {resp.text[:300]}")
    return resp.json()["postId"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True, help="Path to the manifest JSON.")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"Dashboard URL (default {DEFAULT_BASE_URL}).")
    ap.add_argument("--channels", default="", help="Comma-separated target channel ids, e.g. 1,2. Empty = untargeted.")
    ap.add_argument("--kind", default="evergreen", choices=["evergreen", "one_time"])
    ap.add_argument("--status", default="draft", choices=["draft", "ready"])
    ap.add_argument("--created-by", default="notes-import", help="Free-text label recorded on each post.")
    ap.add_argument("--log", default="", help="Run log path (default: <manifest>.runlog.jsonl).")
    ap.add_argument("--limit", type=int, default=0, help="Only import the first N posts (0 = all).")
    ap.add_argument("--dry-run", action="store_true", help="Validate and report; upload and create nothing.")
    args = ap.parse_args()

    with open(args.manifest, encoding="utf-8") as fh:
        manifest = json.load(fh)
    images_dir = manifest["images_dir"]
    posts: list[dict[str, Any]] = manifest["posts"]
    if args.limit:
        posts = posts[: args.limit]

    channels = [int(c) for c in args.channels.split(",") if c.strip()]
    log_path = args.log or f"{args.manifest}.runlog.jsonl"
    done = load_done(log_path)

    # Validate every referenced file up front — better to fail before writing anything
    # than to stop halfway with some posts created and some not.
    missing = [
        f for entry in posts for f in entry["files"] if not os.path.isfile(os.path.join(images_dir, f))
    ]
    if missing:
        print(f"ERROR: {len(missing)} file(s) in the manifest are not on disk:", file=sys.stderr)
        for f in missing[:10]:
            print(f"  {f}", file=sys.stderr)
        return 1

    total_images = sum(len(e["files"]) for e in posts)
    todo = [e for e in posts if post_key(e) not in done]
    print(f"manifest : {args.manifest}")
    print(f"images   : {images_dir}")
    print(f"posts    : {len(posts)} ({total_images} images)")
    print(f"already  : {len(posts) - len(todo)} imported in a previous run (skipped)")
    print(f"to do    : {len(todo)}")
    print(f"targets  : {channels or 'none (untargeted)'}   kind={args.kind}  status={args.status}")
    if args.dry_run:
        print("\n-- DRY RUN: nothing will be uploaded or created --")
        for e in todo[:10]:
            cap = (e["caption"] or "").replace("\n", " ")
            cap = (cap[:60] + "...") if len(cap) > 60 else (cap or "(no caption)")
            print(f"  {e['type']:<8} {len(e['files'])}x  {', '.join(e['files'])[:60]:<60} {cap}")
        if len(todo) > 10:
            print(f"  ... and {len(todo) - 10} more")
        return 0

    session = requests.Session()
    # asset ids are cached per path so a file shared between entries uploads once
    asset_cache: dict[str, int] = {}
    created = 0
    failures: list[tuple[str, str]] = []

    with open(log_path, "a", encoding="utf-8") as log:
        for i, entry in enumerate(todo, 1):
            key = post_key(entry)
            label = ", ".join(entry["files"])
            try:
                asset_ids = []
                for name in entry["files"]:
                    if name not in asset_cache:
                        info = upload_image(session, args.base_url, os.path.join(images_dir, name))
                        asset_cache[name] = info["id"]
                    asset_ids.append(asset_cache[name])
                post_id = create_draft(
                    session, args.base_url, asset_ids, entry.get("caption", ""),
                    channels, args.kind, args.status, args.created_by,
                )
                log.write(json.dumps({"key": key, "post_id": post_id, "files": entry["files"]}) + "\n")
                log.flush()  # so an interrupted run is still resumable
                created += 1
                flag = "cap" if entry.get("caption") else "   "
                print(f"[{i}/{len(todo)}] post {post_id:>4} [{flag}] {len(asset_ids)}x {label[:60]}")
            except KeyboardInterrupt:
                print("\ninterrupted — progress is saved, re-run to resume", file=sys.stderr)
                return 130
            except Exception as exc:  # keep going; one bad post shouldn't stop the batch
                failures.append((label, str(exc)))
                print(f"[{i}/{len(todo)}] FAILED {label[:60]}: {exc}", file=sys.stderr)

    print(f"\ncreated {created} post(s); {len(failures)} failure(s)")
    if failures:
        print("failures:", file=sys.stderr)
        for label, err in failures:
            print(f"  {label}: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
