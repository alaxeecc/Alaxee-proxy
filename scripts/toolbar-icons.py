#!/usr/bin/env python3
"""Draw the four toolbar icons.

Why these are drawn rather than copied
--------------------------------------
Until now icons/status/*.png were the brand kit's own artwork, copied verbatim. That
is right for the places the artwork is seen at size - the 34px mark in the popup
header and the 128/1024px store listings - and those still use it.

At 16px it does not work and no amount of recolouring fixes it: the kit icons are
gradient illustrations with soft edges, so at 16px they resolve to a pale pink
smudge, and two of the four measured 0.0097 apart in OKLab. Measured across light
and dark toolbars, none of the brand colours reaches 3:1 against both - the best is
2.91 - so a tinted glyph cannot work in two themes either.

What is drawn here is a 16px icon: flat shapes with a contrast floor, four mutually
exclusive silhouettes, and a white outline thick enough to separate the shape from
whatever the toolbar background is.

    proxy    filled disc      the normal state: solid, nothing unusual
    direct   hollow ring      empty inside - the connection is not going anywhere
    forced   filled triangle  a warning shape; nothing else is triangular
    unknown  dashed ring      broken, not merely empty

Colour carries the route (matching the popup tokens); shape carries it too, so the
icons survive greyscale and colour-blindness.

Usage:
    python3 scripts/toolbar-icons.py            # write icons/status/*.png
    python3 scripts/toolbar-icons.py --check    # verify size and palette
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import zlib
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "icons" / "status"

SIZES = (16, 32)
ROUTES = ("proxy", "direct", "forced", "unknown")

# Route colours, identical to the popup's tokens so a state is the same colour in
# both places. Each pair (fill, ink) is chosen to clear 4.5:1 against the white
# outline, which is what actually separates the glyph from any toolbar.
FILL = {
    "proxy": (0xB5, 0x45, 0x7A),    # --accent
    "direct": (0x1F, 0x6B, 0x5F),   # --route-direct
    "forced": (0x8F, 0x57, 0x13),   # --route-forced
    "unknown": (0x7C, 0x68, 0x73),  # --muted
}
OUTLINE = (0xFF, 0xFF, 0xFF, 255)

# Supersampling factor. A 16px triangle drawn directly is three grey rows; drawn at
# 8x and reduced, its edges land on real pixel boundaries.
SS = 8


def draw(route: str, size: int) -> Image.Image:
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    fill = (*FILL[route], 255)
    # Geometry in fractions of the icon, so 16 and 32 stay identical in proportion.
    # The shape fills most of the tile: at 16px a small glyph surrounded by padding
    # reads as a speck.
    margin = 0.13 * n
    ring = max(1, round(0.055 * n))          # white outline thickness
    stroke = max(1, round(0.115 * n))        # ring thickness for direct/unknown
    box = (margin, margin, n - margin, n - margin)

    if route == "proxy":
        # Solid disc, white rim.
        d.ellipse((box[0] - ring, box[1] - ring, box[2] + ring, box[3] + ring), fill=OUTLINE)
        d.ellipse(box, fill=fill)
    elif route == "direct":
        # Hollow ring: the hole is the information. Drawn as outline + inner erase
        # rather than two ellipses, so the white rim and the colour band are
        # separate and both survive downsampling.
        d.ellipse((box[0] - ring, box[1] - ring, box[2] + ring, box[3] + ring), fill=OUTLINE)
        d.ellipse(box, outline=fill, width=stroke)
    elif route == "forced":
        # Upward triangle, white rim under it. The rim is the inner triangle grown
        # by a fixed offset rather than tipped by `ring`: at the apex a triangle's
        # width goes to zero, so offsetting every vertex by the same distance leaves
        # no rim at all there and the point renders as a bare shard.
        cx = n / 2
        # The triangle is the largest that fits with its rim: the apex rim reaches
        # rim*1.6 above the point, so the point sits that far down from the tile top.
        # Sized as fractions of the tile rather than of the margins, because the
        # margins were tuned for a disc and leave a triangle too small to read.
        # A triangle of the same width as a disc covers about half its area, so it
        # reads as smaller at the same bounding box. Drawn deliberately larger to
        # compensate: the base is nearly the full width, and the apex rim is allowed
        # to sit about 1px from the top.
        # Sized against the disc, not against the margins: a triangle of the same
        # bounds covers about half a disc's area, so it has to be drawn larger to
        # read as equally important. Measured, the first attempt landed at 47 ink
        # pixels against the disc's 112 - a speck next to a circle.
        rim = ring * 1.55
        top = 0.145 * n
        bottom = 0.775 * n
        height = bottom - top
        # Capped by the width available inside the rim, which is what actually runs
        # out first at this height.
        half = min(height * 1.02, n / 2 - margin - ring * 0.6)
        outer = [(cx, top - rim * 1.6),
                 (cx + half + rim, bottom + rim),
                 (cx - half - rim, bottom + rim)]
        inner = [(cx, top), (cx + half, bottom), (cx - half, bottom)]
        d.polygon(outer, fill=OUTLINE)
        d.polygon(inner, fill=fill)
    else:  # unknown
        # Dashed ring. Six segments, not eight: at 16px eight segments average back
        # into a solid ring and the state becomes indistinguishable from direct.
        segments = 6
        cx = cy = n / 2
        r_outer = (n / 2) - margin
        r_inner = r_outer - stroke
        d.ellipse((cx - r_outer - ring, cy - r_outer - ring, cx + r_outer + ring, cy + r_outer + ring), fill=OUTLINE)
        for i in range(segments):
            a0 = (i * 360 / segments) + 6
            a1 = ((i + 1) * 360 / segments) - 6
            d.arc((cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer),
                  a0, a1, fill=fill, width=int(r_outer - r_inner))

    return img.resize((size, size), Image.LANCZOS)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        problems = 0
        for route in ROUTES:
            for size in SIZES:
                path = OUT / f"{route}{size}.png"
                if not path.exists():
                    print(f"missing {path.name}")
                    problems += 1
        if problems:
            return 1
        print("all toolbar icons present")
        return 0

    OUT.mkdir(parents=True, exist_ok=True)
    for route in ROUTES:
        for size in SIZES:
            path = OUT / f"{route}{size}.png"
            draw(route, size).save(path)
            print(f"{path.relative_to(ROOT)}  {size}x{size}  {path.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
