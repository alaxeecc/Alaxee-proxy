#!/usr/bin/env python3
"""Render the store images Partner Center asks for, from the brand kit.

Nothing here draws artwork. Every pixel comes from the kit's own PNGs, scaled
proportionally and composited onto the kit's own background colour. That is the
whole point: an earlier round hand-drew replacement icons and was rejected
because they no longer matched the brand.

Outputs, all into store-assets/:

  logo-300.png     Extension logo, 1:1, 300x300 (Partner Center recommends 300,
                   requires at least 128).
  tile-440x280.png Small promotional tile, exactly 440x280.

Screenshots are not produced here. They show the live UI and no browser exists in
this build environment; see docs/EDGE-ADDONS-PUBLISHING.md.

Usage:
  python3 scripts/store-assets.py
  python3 scripts/store-assets.py --check    # verify without writing
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "alaxee-kit" / "brand" / "icons" / "png"
OUT = ROOT / "store-assets"

# The day icon on the light surface. Chosen to match icons/icon128.png, which is
# what the manifest ships, so the store logo and the browser's own icon agree.
SOURCE_1024 = KIT / "icon-day-1024.png"
SOURCE_128 = KIT / "icon-day-128.png"

# --bg from the light theme. The tile is a solid plate so the icon does not sit
# on transparency, which renders unpredictably against the store's own backdrop.
TILE_BG = (0xFA, 0xF6, 0xF4)

LOGO_SIZE = 300
TILE_SIZE = (440, 280)


def load_source(minimum: int) -> Image.Image:
    """Prefer the 1024px master so no render is ever upscaled."""
    for path in (SOURCE_1024, SOURCE_128):
        if path.exists():
            img = Image.open(path).convert("RGBA")
            if min(img.size) >= minimum:
                return img
    sys.exit(
        f"no brand icon at least {minimum}px in {KIT}; "
        "the kit must be present (it is committed at alaxee-kit/)"
    )


def contain(src: Image.Image, box: tuple[int, int]) -> Image.Image:
    """Scale to fit inside box, preserving aspect ratio. Never distorts."""
    scale = min(box[0] / src.width, box[1] / src.height)
    w = max(1, round(src.width * scale))
    h = max(1, round(src.height * scale))
    return src.resize((w, h), Image.LANCZOS)


def render_logo() -> Image.Image:
    src = load_source(LOGO_SIZE)
    canvas = Image.new("RGBA", (LOGO_SIZE, LOGO_SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(contain(src, (LOGO_SIZE, LOGO_SIZE)), (0, 0))
    return canvas


def render_tile() -> Image.Image:
    # Margin keeps the mark off the edges; the store crops tiles in some
    # placements. 64px at the shorter side reads as deliberate spacing.
    src = load_source(TILE_SIZE[1])
    canvas = Image.new("RGBA", TILE_SIZE, TILE_BG + (255,))
    inner = (TILE_SIZE[0] - 128, TILE_SIZE[1] - 64)
    art = contain(src, inner)
    pos = ((TILE_SIZE[0] - art.width) // 2, (TILE_SIZE[1] - art.height) // 2)
    canvas.alpha_composite(art, pos)
    return canvas


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="verify the sources render, write nothing")
    args = ap.parse_args()

    logo = render_logo()
    tile = render_tile()

    if args.check:
        assert logo.size == (LOGO_SIZE, LOGO_SIZE), logo.size
        assert tile.size == TILE_SIZE, tile.size
        print(f"logo ok  {logo.size[0]}x{logo.size[1]}")
        print(f"tile ok  {tile.size[0]}x{tile.size[1]}")
        return 0

    OUT.mkdir(exist_ok=True)
    logo_path = OUT / "logo-300.png"
    tile_path = OUT / "tile-440x280.png"
    logo.save(logo_path)
    tile.save(tile_path)

    for path in (logo_path, tile_path):
        with Image.open(path) as check:
            size = check.size
        print(f"{path.relative_to(ROOT)}  {size[0]}x{size[1]}  {path.stat().st_size:,} bytes")
    print("\nScreenshots are still manual: see docs/EDGE-ADDONS-PUBLISHING.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
