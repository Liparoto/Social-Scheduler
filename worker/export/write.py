"""Turn an ExportBundle into the files a human (and a future importer) can use.

Everything here writes only inside the run's own output directory. Nothing in this
module touches the database or the network.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from worker.export.collect import ExportBundle

IMAGES_DIR = "images"
PUBLISHED_DIR = "images-published"


@dataclass
class CopyResult:
    copied: int = 0
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


def _copy_one(src: Path, dest_dir: Path, name: str, result: CopyResult, asset_id: int) -> bool:
    if not src.is_file():
        result.missing_asset_ids.add(asset_id)
        result.problems.append(f"asset {asset_id}: file not found at {src}")
        return False
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest_dir / name)
    except OSError as exc:
        result.problems.append(f"asset {asset_id}: could not copy {src} ({exc})")
        return False
    result.copied += 1
    return True


def copy_images(bundle: ExportBundle, asset_root: Path, out_dir: Path) -> CopyResult:
    """Copy every post's images under their exported names.

    An asset shared by two posts is written once per post, under each post's own
    name — duplication on disk is cheaper than a filename that only makes sense
    with the workbook open.
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
            )
            if image.publish_path and image.published_filename:
                _copy_one(
                    _resolve(asset_root, image.publish_path),
                    out_dir / PUBLISHED_DIR,
                    image.published_filename,
                    result,
                    image.asset_id,
                )
    return result
