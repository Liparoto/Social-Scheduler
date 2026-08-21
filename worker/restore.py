"""Put a backup folder back: the database, and the image store rebuilt from it.

The mirror of `worker.export`. An export folder holds a scrubbed copy of the database
(`socialscheduler.db`), a machine-readable `export.json`, and every image — but the images
are stored under READABLE names (`0042_spring-sale_1.jpg`), not the content-hash names the
database refers to. So a restore is two jobs, not one: put the database back, and rename
every image back to the name its row expects.

`export.json` is what makes the second job possible. Each post's images record both their
exported filename and their `storage_path`, so the mapping is read from the backup rather
than guessed. Nothing here re-derives a name that the export chose, with one exception noted
at `_unlinked_pairs`.

**Dry run by default.** Nothing is written unless `--apply` is passed — the same contract as
`scripts/repair_scheduled_at_format.py`. This is the most destructive operation in the repo:
it replaces the live database. It refuses to run while the worker is up, and it saves the
current database aside before overwriting it.

**Credentials do not come back.** The exported copy is scrubbed of access tokens by design
(see `worker.export.__main__._scrub_secrets`), because the backup folder is meant to be safe
to keep in Google Drive. After restoring you reconnect each account. That is the intended
trade, and the export's README says so.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from worker import single_instance
from worker.config import Config
from worker.export.__main__ import DB_COPY_NAME
from worker.export.write import (
    IMAGES_DIR,
    JSON_FORMAT_VERSION,
    PUBLISHED_DIR,
    UNLINKED_DIR,
    unlinked_filename,
)

JSON_NAME = "export.json"


class RestoreError(Exception):
    """Something about the backup or the install makes restoring unsafe.

    Always carries a message a non-technical person can act on: this class is what the
    double-clickable wrapper prints, and it is the only failure they will ever see.
    """


@dataclass
class FileRestore:
    """One image to put back: where it is in the backup, where the database expects it."""

    source: Path
    dest_name: str
    kind: str  # "original" | "conformed"

    @property
    def missing(self) -> bool:
        return not self.source.is_file()


@dataclass
class RestorePlan:
    backup_dir: Path
    database_copy: Path
    files: list[FileRestore] = field(default_factory=list)
    generated_at: str | None = None
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def missing_files(self) -> list[FileRestore]:
        return [f for f in self.files if f.missing]


def _load_bundle(backup_dir: Path) -> dict:
    json_path = backup_dir / JSON_NAME
    if not json_path.is_file():
        raise RestoreError(
            f"That folder has no {JSON_NAME}, so the images cannot be matched back to "
            "their posts.\nPick the folder that Export created — the one with "
            f"{JSON_NAME} and {DB_COPY_NAME} directly inside it."
        )
    try:
        bundle = json.loads(json_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise RestoreError(f"Could not read {JSON_NAME}: {exc}") from exc

    version = bundle.get("format_version")
    if version != JSON_FORMAT_VERSION:
        # Refuse rather than guess. A different shape means the filename/path fields this
        # module reads may not mean what it assumes, and a wrong guess here writes images
        # under wrong names into a live asset store.
        raise RestoreError(
            f"This backup was written in format version {version!r}, but this copy of "
            f"SocialScheduler understands version {JSON_FORMAT_VERSION}.\n"
            "Restore it with the version of the app that produced it."
        )
    return bundle


def _unlinked_pairs(bundle: dict, linked_ids: set[int]) -> list[tuple[str, str]]:
    """(exported filename, storage_path) for assets that belong to no post.

    The one place a name is RE-DERIVED rather than read: `copy_images` writes these using
    `unlinked_filename(asset)` and the bundle does not record the result. Importing the very
    same function is what keeps the two sides from drifting — if the naming ever changes,
    both sides change together or the shared function stops compiling.
    """
    pairs: list[tuple[str, str]] = []
    for raw in bundle.get("assets", []):
        if raw["asset_id"] in linked_ids:
            continue
        # unlinked_filename reads only these three fields; a light stand-in keeps this
        # module from depending on the full ExportedAsset dataclass shape.
        stub = _AssetName(
            asset_id=raw["asset_id"],
            storage_path=raw["storage_path"],
            original_filename=raw.get("original_filename"),
        )
        pairs.append((unlinked_filename(stub), raw["storage_path"]))
    return pairs


@dataclass
class _AssetName:
    asset_id: int
    storage_path: str
    original_filename: str | None


def plan_restore(backup_dir: Path, config: Config) -> RestorePlan:
    """Work out exactly what a restore would do, touching nothing.

    Every failure a person can fix — wrong folder, missing database, unreadable JSON — is
    raised here, before a single byte of the live install has been changed.
    """
    if not backup_dir.is_dir():
        raise RestoreError(f"No such folder: {backup_dir}")

    database_copy = backup_dir / DB_COPY_NAME
    if not database_copy.is_file():
        raise RestoreError(
            f"That folder has no {DB_COPY_NAME}, so there is nothing to restore from.\n"
            "Backups made before this feature existed contain a readable record (the\n"
            "spreadsheet and the images) but no restorable database. Run Export again on\n"
            "a working install to produce one."
        )
    # Opening it proves it is a real database before we offer to install it. A truncated
    # or half-copied file fails here rather than after the live one has been replaced.
    try:
        probe = sqlite3.connect(f"file:{database_copy}?mode=ro", uri=True)
        try:
            probe.execute("SELECT COUNT(*) FROM posts").fetchone()
        finally:
            probe.close()
    except sqlite3.Error as exc:
        raise RestoreError(
            f"{DB_COPY_NAME} in that folder is not a readable SocialScheduler database "
            f"({exc}).\nThe backup may be incomplete."
        ) from exc

    bundle = _load_bundle(backup_dir)
    plan = RestorePlan(
        backup_dir=backup_dir,
        database_copy=database_copy,
        generated_at=bundle.get("generated_at"),
    )

    # An asset used by several posts is exported once per post, under each post's own name.
    # Any one of those copies restores it, so the first wins and the rest are skipped —
    # they are byte-identical by construction (same asset row, same source file).
    seen_dest: set[str] = set()
    linked_ids: set[int] = set()

    for post in bundle.get("posts", []):
        for image in post.get("images", []):
            linked_ids.add(image["asset_id"])
            if image["storage_path"] not in seen_dest:
                seen_dest.add(image["storage_path"])
                plan.files.append(
                    FileRestore(
                        source=backup_dir / IMAGES_DIR / image["export_filename"],
                        dest_name=image["storage_path"],
                        kind="original",
                    )
                )
            published = image.get("published_filename")
            publish_path = image.get("publish_path")
            if published and publish_path and publish_path not in seen_dest:
                seen_dest.add(publish_path)
                plan.files.append(
                    FileRestore(
                        source=backup_dir / PUBLISHED_DIR / published,
                        dest_name=publish_path,
                        kind="conformed",
                    )
                )

    for name, storage_path in _unlinked_pairs(bundle, linked_ids):
        if storage_path in seen_dest:
            continue
        seen_dest.add(storage_path)
        plan.files.append(
            FileRestore(
                source=backup_dir / UNLINKED_DIR / name,
                dest_name=storage_path,
                kind="original",
            )
        )

    already = sum(
        1 for f in plan.files if (config.asset_storage_dir / f.dest_name).is_file()
    )
    plan.counts = {
        "posts": len(bundle.get("posts", [])),
        "channels": len(bundle.get("channels", [])),
        "images": len(plan.files),
        "images_missing": len(plan.missing_files),
        "images_already_present": already,
    }
    return plan


def save_current_database(config: Config, now: datetime) -> Path | None:
    """Copy the database being replaced into data/backups, and return where it went.

    Restoring is the one operation that destroys data on purpose, so it keeps a way back.
    Uses the backup API for the same reason the export does: a live WAL database cannot be
    safely copied with the filesystem.

    Returns None when there is no database yet — restoring onto a fresh clone is a normal
    case, not a failure.
    """
    if not config.database_path.exists():
        return None
    dest_dir = config.database_path.parent / "backups"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"pre-restore-{now.strftime('%Y%m%d-%H%M%S')}.db"
    src = sqlite3.connect(f"file:{config.database_path}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(str(dest))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    return dest


def apply_restore(plan: RestorePlan, config: Config, now: datetime) -> dict[str, int]:
    """Do it. Assumes the worker lock is already held by the caller."""
    saved = save_current_database(config, now)

    # Order matters. The database goes in LAST, after the images are on disk, so an
    # interruption partway leaves the old database still pointing at an asset store that
    # only gained files. The reverse order would leave a new database referring to images
    # that never arrived.
    restored = skipped = missing = 0
    config.asset_storage_dir.mkdir(parents=True, exist_ok=True)
    for item in plan.files:
        dest = config.asset_storage_dir / item.dest_name
        if dest.is_file():
            # Filenames are content hashes, so a file already there IS this file. Copying
            # over it would burn time on 1.5 GB of identical bytes.
            skipped += 1
            continue
        if item.missing:
            missing += 1
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item.source, dest)
        restored += 1

    # Stale sidecars are the trap here. A -wal/-shm pair belongs to the database file it
    # was created with; leaving the OLD pair beside a NEWLY copied .db is how a restore
    # produces a corrupt install. They are removed, never copied.
    config.database_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(plan.database_copy, config.database_path)
    for sidecar in ("-wal", "-shm"):
        stale = Path(str(config.database_path) + sidecar)
        if stale.exists():
            stale.unlink()

    return {
        "images_restored": restored,
        "images_skipped": skipped,
        "images_missing": missing,
        "saved_database_to": str(saved) if saved else "",
    }


def _print_plan(plan: RestorePlan, config: Config) -> None:
    print(f"Backup folder: {plan.backup_dir}")
    if plan.generated_at:
        print(f"Created:       {plan.generated_at}")
    print()
    print("This backup holds:")
    print(f"  {plan.counts['posts']} post(s)")
    print(f"  {plan.counts['channels']} channel(s)")
    print(f"  {plan.counts['images']} image file(s)")
    print()
    print("Restoring would:")
    if config.database_path.exists():
        print(f"  - save your CURRENT database into {config.database_path.parent / 'backups'}")
        print(f"  - REPLACE {config.database_path}")
    else:
        print(f"  - create {config.database_path} (there is no database here yet)")
    already = plan.counts["images_already_present"]
    to_copy = plan.counts["images"] - already - plan.counts["images_missing"]
    print(f"  - put {to_copy} image file(s) into {config.asset_storage_dir}")
    if already:
        print(f"  - leave {already} image file(s) alone (already there, same content)")
    if plan.counts["images_missing"]:
        print(
            f"  - SKIP {plan.counts['images_missing']} image file(s) that are missing from"
            " the backup"
        )
    print()
    print("Your accounts will need reconnecting afterwards: backups deliberately")
    print("contain no access tokens, so that they are safe to keep in cloud storage.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m worker.restore",
        description="Restore a SocialScheduler backup folder over this install.",
    )
    parser.add_argument("backup_dir", type=Path, help="the export folder to restore from")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually write. Without this, prints what would happen and stops.",
    )
    args = parser.parse_args(argv)

    config = Config.from_env()

    try:
        plan = plan_restore(args.backup_dir, config)
    except RestoreError as exc:
        print(f"Cannot restore: {exc}")
        return 1

    _print_plan(plan, config)

    if not args.apply:
        print()
        print("DRY RUN — nothing was changed. Re-run with --apply to restore for real.")
        return 0

    # Held for the whole write, not merely checked: a worker that starts halfway through
    # would be reading a database that is being replaced under it. wait_seconds=0 because
    # this is not a handover — if a worker holds the lock, the answer is "stop it first",
    # not "wait a moment".
    lock_path = config.database_path.parent / "run" / "worker.lock"
    try:
        single_instance.acquire(lock_path, wait_seconds=0)
    except single_instance.AlreadyRunning as exc:
        print()
        print(f"Cannot restore: the app is still running ({exc}).")
        print("Double-click 'Stop-SocialScheduler-Mac' first, then try again.")
        return 1

    try:
        result = apply_restore(plan, config, datetime.now(timezone.utc))
    except OSError as exc:
        print(f"Restore failed partway: {exc}")
        print("Your previous database was saved in data/backups before anything changed.")
        return 1
    finally:
        single_instance.release()

    print()
    print("Restored.")
    print(f"  {result['images_restored']} image file(s) copied in")
    if result["images_skipped"]:
        print(f"  {result['images_skipped']} already present, left alone")
    if result["images_missing"]:
        print(f"  {result['images_missing']} missing from the backup and skipped")
    if result["saved_database_to"]:
        print(f"  previous database saved to {result['saved_database_to']}")
    print()
    print("Next: start the app and reconnect each account under Channels.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
