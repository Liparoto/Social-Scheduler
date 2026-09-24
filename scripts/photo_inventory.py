#!/usr/bin/env python3
"""Inspect a folder of photos before turning them into posts.

Answers the questions that decide how a batch is grouped, and that are easy to get wrong
by guessing: when was each photo actually taken (in the camera's own timezone, not the
file's modified date), where was it taken, is it portrait or landscape once its rotation
flag is applied, and which photos are the same moment twice.

Optionally writes contact sheets — grids of labelled thumbnails — because looking at 200
photos one at a time is slow and skipping that step is how duplicates and mis-grouped
sets get through.

Usage:
    python3 scripts/photo_inventory.py "/path/to/photos" --json out.json
    python3 scripts/photo_inventory.py "/path/to/photos" --sheets data/import-work/sheets
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".heic"}

# EXIF tag numbers, used directly so no tag-name table is needed.
DATETIME_ORIGINAL = 36867
OFFSET_TIME_ORIGINAL = 36881
ORIENTATION = 274
EXIF_IFD = 0x8769
GPS_IFD = 0x8825

# Orientation values 5-8 mean the camera was turned 90 degrees: the stored pixels are
# sideways and every viewer rotates them on the way in.
SIDEWAYS = {5, 6, 7, 8}


def orientation_of(width: int, height: int) -> str:
    """How this photo reads in a feed: portrait, landscape or square."""
    if width == height:
        return "square"
    return "portrait" if height > width else "landscape"


def parse_shot_time(exif) -> tuple[str | None, str | None]:
    """(capture time, camera's UTC offset) as plain strings, or (None, None).

    Read from the photo rather than the file's timestamps: copying, syncing or exporting
    rewrites file dates, and a batch grouped by file date puts a sunset shot at midnight.
    The offset is kept as the camera recorded it — two cameras on one trip can disagree.
    """
    raw = exif.get(DATETIME_ORIGINAL)
    offset = exif.get(OFFSET_TIME_ORIGINAL)
    if isinstance(offset, str):
        offset = offset.strip() or None
    if not raw or not isinstance(raw, str):
        return None, offset
    # A camera that does not know the date writes 0000:00:00 00:00:00, which would
    # otherwise read as a real timestamp and sort to the front of the batch. Parsing it
    # for real is what tells the two apart.
    try:
        taken = datetime.strptime(raw.strip(), "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None, offset
    return taken.isoformat(), offset


def _to_degrees(value) -> float | None:
    """EXIF stores a coordinate as degrees, minutes, seconds. None if it is malformed.

    Returns rather than raises: some exports write a short or non-numeric coordinate, and
    one such photo must not take down the scan of the whole folder.
    """
    try:
        d, m, s = (float(part) for part in value)
    except (TypeError, ValueError):
        return None
    return d + m / 60 + s / 3600


def gps_from_exif(gps) -> tuple[float, float] | None:
    """(latitude, longitude) in signed decimal degrees, or None when absent.

    The reference letters carry the sign: EXIF stores 33°52'S as a positive 33.87 plus
    an 'S'. Dropping them puts Bali in Russia.
    """
    if not gps:
        return None
    lat, lon = gps.get(2), gps.get(4)
    if not lat or not lon:
        return None
    latitude = _to_degrees(lat)
    longitude = _to_degrees(lon)
    if latitude is None or longitude is None:
        return None
    if str(gps.get(1, "N")).upper().startswith("S"):
        latitude = -latitude
    if str(gps.get(3, "E")).upper().startswith("W"):
        longitude = -longitude
    return latitude, longitude


def _exif_of(img) -> tuple[dict, dict]:
    """(tags, gps) — the Exif sub-IFD merged over IFD0, plus the GPS block.

    Cameras write capture time into the Exif sub-IFD, while some editors leave it at the
    top level; reading only one place finds nothing on half the photos in a folder.
    """
    exif = img.getexif()
    tags = dict(exif)
    try:
        tags.update(dict(exif.get_ifd(EXIF_IFD)))
    except Exception:
        pass
    try:
        gps = dict(exif.get_ifd(GPS_IFD))
    except Exception:
        gps = {}
    return tags, gps


# Below this much greyscale variation there is no pattern left to compare: a photo of
# open sky, a white wall or a black frame reduces to the same near-empty hash as every
# other flat photo, so comparing them reports duplicates that are not duplicates.
MIN_DETAIL = 8.0


def signature(path: Path, size: int = 8) -> tuple[int, float]:
    """(perceptual hash, how much detail the photo has).

    The hash compares what a photo LOOKS like, so a re-export, a resize or a "sneak peek"
    copy of a frame hashes almost the same as the original, where a content hash would not.
    The detail figure says whether that hash means anything at all.
    """
    from PIL import Image, ImageStat

    with Image.open(path) as img:
        grey = img.convert("L")
        detail = ImageStat.Stat(grey).stddev[0]
        small = grey.resize((size + 1, size), Image.LANCZOS)
        # tobytes() on a greyscale image is one byte per pixel, row by row. Used instead of
        # getdata(), which Pillow 12 deprecates, and get_flattened_data(), which older
        # Pillow versions do not have — this spelling works on both.
        pixels = small.tobytes()
    bits = 0
    for row in range(size):
        for col in range(size):
            left = pixels[row * (size + 1) + col]
            right = pixels[row * (size + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits, detail


def dhash(path: Path, size: int = 8) -> int:
    """Just the perceptual hash, for when the detail figure is not needed."""
    return signature(path, size)[0]


def group_near_duplicates(hashes: dict[str, int], threshold: int = 6) -> list[list[str]]:
    """Groups of photos that look like the same moment. Only real groups are returned.

    `threshold` is how many of the 64 bits may differ. Around 6 catches re-exports and
    burst frames of one pose without collapsing genuinely different shots.
    """
    names = list(hashes)
    seen: set[str] = set()
    groups: list[list[str]] = []
    for i, name in enumerate(names):
        if name in seen:
            continue
        group = [name]
        for other in names[i + 1:]:
            if other in seen:
                continue
            if bin(hashes[name] ^ hashes[other]).count("1") <= threshold:
                group.append(other)
                seen.add(other)
        if len(group) > 1:
            seen.add(name)
            groups.append(group)
    return groups


def inspect_photo(path: Path) -> dict:
    """Everything about one photo that affects how it should be posted."""
    from PIL import Image, ImageOps

    with Image.open(path) as img:
        tags, gps = _exif_of(img)
        upright = ImageOps.exif_transpose(img)
        width, height = upright.size

    shot_at, offset = parse_shot_time(tags)
    coords = gps_from_exif(gps)
    return {
        "file": path.name,
        "width": width,
        "height": height,
        "orientation": orientation_of(width, height),
        "rotated": int(tags.get(ORIENTATION, 1) or 1) in SIDEWAYS,
        "shot_at": shot_at,
        "utc_offset": offset,
        "gps": list(coords) if coords else None,
        "megabytes": round(path.stat().st_size / 1_000_000, 2),
    }


def photo_files(folder: Path) -> list[str]:
    """Photo filenames in the folder, sorted, ignoring everything else."""
    return sorted(
        p.name for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in PHOTO_SUFFIXES and not p.name.startswith(".")
    )


def inspect_folder(folder: Path, duplicate_threshold: int = 6) -> dict:
    """The whole folder: one record per photo, plus the near-duplicate groups."""
    names = photo_files(folder)
    photos = [inspect_photo(folder / name) for name in names]

    hashes: dict[str, int] = {}
    too_plain: list[str] = []
    for name in names:
        bits, detail = signature(folder / name)
        if detail < MIN_DETAIL:
            too_plain.append(name)
        else:
            hashes[name] = bits

    return {
        "folder": str(folder),
        "count": len(photos),
        "photos": photos,
        "duplicate_groups": group_near_duplicates(hashes, duplicate_threshold),
        # Named rather than silently dropped: "I could not compare these six" is useful,
        # and pretending they were checked is not.
        "too_plain_to_compare": too_plain,
    }


def contact_sheets(
    folder: Path, names: list[str], out_dir: Path, per_sheet: int = 24,
    cols: int = 6, thumb: int = 240,
) -> list[Path]:
    """Write grids of labelled thumbnails; returns the files written.

    The label under each thumbnail is the filename, which is how a reviewer and an AI refer
    to the same photo — an unlabelled sheet cannot be acted on.
    """
    from PIL import Image, ImageDraw, ImageOps

    out_dir.mkdir(parents=True, exist_ok=True)
    label_h = 18
    cell_w, cell_h = thumb, thumb + label_h
    written: list[Path] = []

    for sheet_no, start in enumerate(range(0, len(names), per_sheet), start=1):
        chunk = names[start:start + per_sheet]
        rows = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), (250, 250, 248))
        draw = ImageDraw.Draw(sheet)
        for i, name in enumerate(chunk):
            with Image.open(folder / name) as img:
                small = ImageOps.contain(ImageOps.exif_transpose(img).convert("RGB"),
                                         (thumb, thumb))
            x = (i % cols) * cell_w
            y = (i // cols) * cell_h
            sheet.paste(small, (x + (thumb - small.width) // 2,
                                y + (thumb - small.height) // 2))
            draw.text((x + 4, y + thumb + 3), name, fill=(60, 60, 58))
        path = out_dir / f"sheet-{sheet_no:02d}.jpg"
        sheet.save(path, "JPEG", quality=80)
        written.append(path)
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("folder", type=Path, help="Folder of photos to inspect.")
    ap.add_argument("--json", type=Path, default=None, help="Write the full report here.")
    ap.add_argument("--sheets", type=Path, default=None, help="Write contact sheets here.")
    ap.add_argument("--per-sheet", type=int, default=24)
    ap.add_argument("--threshold", type=int, default=6,
                    help="Bits that may differ before two photos count as the same moment.")
    args = ap.parse_args()

    if not args.folder.is_dir():
        sys.exit(f"{args.folder}: not a folder")

    report = inspect_folder(args.folder, args.threshold)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"{report['count']} photos in {args.folder}")
    shapes: dict[str, int] = {}
    for photo in report["photos"]:
        shapes[photo["orientation"]] = shapes.get(photo["orientation"], 0) + 1
    print("  " + ", ".join(f"{n} {shape}" for shape, n in sorted(shapes.items())))

    dated = [p for p in report["photos"] if p["shot_at"]]
    if dated:
        times = sorted(p["shot_at"] for p in dated)
        offsets = sorted({p["utc_offset"] for p in dated if p["utc_offset"]})
        print(f"  taken {times[0]} .. {times[-1]}"
              + (f" (offsets {', '.join(offsets)})" if offsets else ""))
    if len(dated) != report["count"]:
        print(f"  {report['count'] - len(dated)} photos have no capture time")

    for group in report["duplicate_groups"]:
        print("  same moment: " + ", ".join(group))
    if report["too_plain_to_compare"]:
        print(f"  {len(report['too_plain_to_compare'])} photos too plain to compare "
              "for duplicates")

    if args.sheets:
        written = contact_sheets(args.folder, [p["file"] for p in report["photos"]],
                                 args.sheets, per_sheet=args.per_sheet)
        print(f"  {len(written)} contact sheet(s) in {args.sheets}")
    if args.json:
        print(f"  report {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
