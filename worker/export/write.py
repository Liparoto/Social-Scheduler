"""Turn an ExportBundle into the files a human (and a future importer) can use.

Everything here writes only inside the run's own output directory. Nothing in this
module touches the database or the network.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field, asdict
from pathlib import Path

from worker.export.collect import ExportBundle

IMAGES_DIR = "images"
PUBLISHED_DIR = "images-published"


@dataclass
class CopyResult:
    copied: int = 0
    # Means exactly one thing: the asset's ORIGINAL (storage_path) could not be
    # exported. A missing/unreadable CONFORMED copy is recorded in `problems`
    # only — never here — since the irreplaceable source still exported fine.
    missing_asset_ids: set[int] = field(default_factory=set)
    problems: list[str] = field(default_factory=list)


def _resolve(asset_root: Path, stored_path: str) -> Path:
    """Where an asset row's file actually lives.

    storage_path holds a bare content-hash filename relative to the asset store
    (verified against the live database). Absolute paths are tolerated in case an
    install ever stores them that way.
    """
    candidate = Path(stored_path)
    return candidate if candidate.is_absolute() else asset_root / candidate


def _copy_one(
    src: Path, dest_dir: Path, name: str, result: CopyResult, asset_id: int, *, is_original: bool
) -> bool:
    kind = "original" if is_original else "conformed copy"
    if not src.is_file():
        if is_original:
            result.missing_asset_ids.add(asset_id)
        result.problems.append(f"asset {asset_id}: {kind} not found at {src}")
        return False
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest_dir / name)
    except OSError as exc:
        if is_original:
            result.missing_asset_ids.add(asset_id)
        result.problems.append(f"asset {asset_id}: could not copy {kind} {src} ({exc})")
        return False
    result.copied += 1
    return True


def copy_images(bundle: ExportBundle, asset_root: Path, out_dir: Path) -> CopyResult:
    """Copy every post's images under their exported names.

    An asset shared by two posts is written once per post, under each post's own
    name — duplication on disk is cheaper than a filename that only makes sense
    with the workbook open.

    `missing_asset_ids` reflects only the ORIGINAL file (storage_path). A missing
    or unreadable CONFORMED copy (publish_path) is noted in `problems` but never
    added there — the irreplaceable source still exported fine.
    """
    result = CopyResult()
    for post in bundle.posts:
        for image in post.images:
            _copy_one(
                _resolve(asset_root, image.storage_path),
                out_dir / IMAGES_DIR,
                image.export_filename,
                result,
                image.asset_id,
                is_original=True,
            )
            if image.publish_path and image.published_filename:
                _copy_one(
                    _resolve(asset_root, image.publish_path),
                    out_dir / PUBLISHED_DIR,
                    image.published_filename,
                    result,
                    image.asset_id,
                    is_original=False,
                )
    return result


# Bump when the JSON shape changes incompatibly, so a future importer can branch.
JSON_FORMAT_VERSION = 1


def write_json(bundle: ExportBundle, out_dir: Path) -> Path:
    """Full-fidelity machine-readable dump, for a future re-import.

    Nested rather than flat: a post CONTAINS its images, which a spreadsheet cannot
    express. Secrets are absent because collect.py never read them — this is not a
    raw table dump.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "format_version": JSON_FORMAT_VERSION,
        "generated_at": bundle.generated_at,
        "posts": [asdict(p) for p in bundle.posts],
        "sends": [asdict(s) for s in bundle.sends],
        "metrics": [asdict(m) for m in bundle.metrics],
        "assets": [asdict(a) for a in bundle.assets],
        "channels": [asdict(c) for c in bundle.channels],
    }
    path = out_dir / "export.json"
    # ensure_ascii=False keeps captions readable if someone opens this in a text editor.
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return path
