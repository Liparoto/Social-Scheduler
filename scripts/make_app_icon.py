"""Draw the SocialScheduler app icon and write every size the Mac and the dashboard need.

Run from the repo root:  .venv/bin/python scripts/make_app_icon.py

Writes:
  macos/*.app/Contents/Resources/AppIcon.icns
                                  — the two .app bundles the LaunchAgents run, so System
                                    Settings → Login Items shows this icon, not "exec"
  macos/AppIcon-1024.png          — the master, for reference
  dashboard/app/icon.png          — browser tab icon (Next.js picks it up by file name)
  dashboard/app/apple-icon.png    — iOS/Safari "add to home screen" icon

Colors are the dashboard's own tokens (dashboard/app/globals.css): pine-green brand,
signal-orange accent. Drawn at 4x and scaled down so edges stay smooth.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 4096  # supersampled canvas; the master icon is 1024
k = S / 1024  # scale from 1024-design units to canvas pixels

BRAND_TOP = (20, 118, 95)
BRAND_BOTTOM = (10, 68, 55)
ACCENT = (240, 101, 58)
ACCENT_DARK = (201, 74, 34)
WHITE = (255, 255, 255)
CELL = (226, 239, 233)  # brand-weak
CELL_ON = (14, 92, 74)  # brand


def box(x0, y0, x1, y1):
    return [round(x0 * k), round(y0 * k), round(x1 * k), round(y1 * k)]


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # Apple's macOS icon grid: an 824pt rounded square centered in 1024, ~185pt corners.
    tile = box(100, 100, 924, 924)
    radius = round(185 * k)

    # Soft drop shadow under the tile.
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [tile[0], tile[1] + round(12 * k), tile[2], tile[3] + round(12 * k)],
        radius, fill=(0, 0, 0, 90))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(round(14 * k))))

    # Tile: vertical pine-green gradient, clipped to the rounded square.
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(tile[1], tile[3] + 1):
        t = (y - tile[1]) / (tile[3] - tile[1])
        c = tuple(round(a + (b - a) * t) for a, b in zip(BRAND_TOP, BRAND_BOTTOM))
        gd.line([(tile[0], y), (tile[2], y)], fill=c + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(tile, radius, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    # Calendar card.
    card = box(232, 262, 792, 792)
    card_shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(card_shadow).rounded_rectangle(
        [card[0], card[1] + round(10 * k), card[2], card[3] + round(10 * k)],
        round(64 * k), fill=(0, 0, 0, 70))
    img.alpha_composite(card_shadow.filter(ImageFilter.GaussianBlur(round(12 * k))))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(card, round(64 * k), fill=WHITE)

    # Orange header band (top corners rounded, bottom square).
    header = box(232, 262, 792, 392)
    d.rounded_rectangle(header, round(64 * k), fill=ACCENT)
    d.rectangle(box(232, 330, 792, 392), fill=ACCENT)

    # Binder rings.
    for cx in (372, 652):
        d.rounded_rectangle(box(cx - 22, 214, cx + 22, 312), round(22 * k), fill=WHITE)
        d.rounded_rectangle(box(cx - 12, 224, cx + 12, 302), round(12 * k), fill=ACCENT_DARK)

    # 3 x 3 day grid; one "scheduled" day in brand green.
    cell, gap = 100, 28
    x_start = 512 - (3 * cell + 2 * gap) / 2
    y_start = 428
    for row in range(3):
        for col in range(3):
            x0 = x_start + col * (cell + gap)
            y0 = y_start + row * (cell + gap)
            on = (row, col) == (1, 1)
            d.rounded_rectangle(box(x0, y0, x0 + cell, y0 + cell), round(26 * k),
                                fill=CELL_ON if on else CELL)
    # White tick on the scheduled day.
    x0 = x_start + (cell + gap)
    y0 = y_start + (cell + gap)
    d.line([(round((x0 + 26) * k), round((y0 + 53) * k)),
            (round((x0 + 44) * k), round((y0 + 72) * k)),
            (round((x0 + 75) * k), round((y0 + 32) * k))],
           fill=WHITE, width=round(14 * k), joint="curve")

    # "Send" badge: orange disc with a white paper plane, overlapping the card corner.
    cx, cy, r = 752, 752, 118
    ring = box(cx - r - 16, cy - r - 16, cx + r + 16, cy + r + 16)
    d.ellipse(ring, fill=BRAND_BOTTOM)  # gap ring so the badge reads as separate
    d.ellipse(box(cx - r, cy - r, cx + r, cy + r), fill=ACCENT)
    plane = [(cx - 66, cy + 6), (cx + 70, cy - 58), (cx + 18, cy + 72), (cx - 2, cy + 20)]
    d.polygon([(round(x * k), round(y * k)) for x, y in plane], fill=WHITE)
    fold = [(cx - 2, cy + 20), (cx + 70, cy - 58), (cx + 6, cy + 46)]
    d.polygon([(round(x * k), round(y * k)) for x, y in fold], fill=(255, 214, 199))

    return img.resize((1024, 1024), Image.LANCZOS)


def write_icns(master: Image.Image, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            master.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            master.resize((size * 2, size * 2), Image.LANCZOS).save(
                iconset / f"icon_{size}x{size}@2x.png")
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)


def main() -> None:
    master = draw_master()
    for bundle in ("SocialScheduler.app", "SocialScheduler Dashboard.app"):
        write_icns(master, ROOT / "macos" / bundle / "Contents" / "Resources" / "AppIcon.icns")
    master.resize((256, 256), Image.LANCZOS).save(ROOT / "dashboard" / "app" / "icon.png")
    # iOS adds its own rounded mask and wants no transparency: crop to the tile, flatten.
    apple = master.crop((100, 100, 924, 924)).resize((180, 180), Image.LANCZOS)
    flat = Image.new("RGB", apple.size, BRAND_BOTTOM)
    flat.paste(apple, (0, 0), apple)
    flat.save(ROOT / "dashboard" / "app" / "apple-icon.png")
    master.save(ROOT / "macos" / "AppIcon-1024.png")
    print("Wrote both bundle icons, macos/AppIcon-1024.png, dashboard/app/icon.png and apple-icon.png")


if __name__ == "__main__":
    assert shutil.which("iconutil"), "iconutil ships with macOS; run this on a Mac"
    main()
