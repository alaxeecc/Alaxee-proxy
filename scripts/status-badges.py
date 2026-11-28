#!/usr/bin/env python3
"""Add a shape badge to the toolbar status icons.

Why this exists
---------------
The four toolbar icons were the brand kit's own artwork recoloured per state. At
16px they failed the only test that matters: proxy and unknown differed by 0.0097
in OKLab, which is about one fifth of the threshold where two colours are
distinguishable, and all four shared the same crescent silhouette. On a toolbar the
icon read as a pink square whichever mode was active, so the extension's state was
invisible - which is the one job the icon has.

The kit is still the artwork. Nothing here redraws it. A badge is composited into
the lower-right corner at a size that survives downsampling to 16px, and each state
gets a distinct shape as well as a distinct colour:

    proxy     solid disc          the normal state, filled
    direct    hollow ring         "off" reads as empty
    forced    filled triangle     a warning shape, unmistakable in outline
    unknown   dashed hollow disc  broken, not merely empty

Colour alone would repeat the original mistake, so every badge differs in shape.
See tests/icons.test.js, which measures the icons at 16px rather than trusting the
drawing code.

Usage:
    python3 scripts/status-badges.py            # write icons/status/*.png
    python3 scripts/status-badges.py --check    # verify, write nothing
"""
from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "alaxee-kit" / "brand" / "icons" / "png"
OUT = ROOT / "icons" / "status"

SIZES = (16, 32)
ROUTES = ("proxy", "direct", "forced", "unknown")

# The kit file each state is built from. Same mapping the shipped icons already
# used, kept so the artwork and the states stay correlated.
SOURCE_OF = {
    "proxy": "icon-day",
    "direct": "icon-night-sleep",
    "forced": "icon-noon",
    "unknown": "icon-morning",
}

# Badge colours. These are the route token colours from the popup, converted to
# opaque values: an icon must not depend on the toolbar's own background, which is
# light in one theme and dark in another. Each is paired with a white outline so it
# separates from whatever artwork sits behind it.
BADGE_FILL = {
    "proxy": (0xB5, 0x45, 0x7A),    # --accent
    "direct": (0x1F, 0x6B, 0x5F),   # --route-direct
    # Not --route-forced: that brown disappears against the pale kit artwork at
    # 16px. This is the same hue pushed brighter and more saturated.
    "forced": (0xC2, 0x5A, 0x0A),
    "unknown": (0x5C, 0x4B, 0x55),  # darker than --muted, for contrast at 16px
}
OUTLINE = (0xFF, 0xFF, 0xFF, 255)

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def load_source(state: str, size: int) -> Image.Image:
    """The kit artwork for a state, at the requested size, falling back down."""
    stem = SOURCE_OF[state]
    for candidate in (size, 128, 256, 512, 1024):
        path = KIT / f"{stem}-{candidate}.png"
        if path.exists() and candidate >= size:
            with Image.open(path) as im:
                src = im.convert("RGBA")
            if candidate != size:
                src = src.resize((size, size), Image.LANCZOS)
            return src
    small = KIT / f"{stem}-small-{size}.png"
    if small.exists():
        with Image.open(small) as im:
            return im.convert("RGBA").resize((size, size), Image.LANCZOS)
    sys.exit(f"no kit artwork for {state} ({stem}) at {size}px under {KIT}")


def draw_badge(size: int, state: str) -> Image.Image:
    """The badge only, on a transparent square of its own.

    Drawn at 4x and downsampled: a 16px triangle drawn directly is three grey rows.
    Supersampling keeps the silhouette readable at the size it ships at. Each state
    gets one clearly different silhouette, because colour alone was what failed:
    an earlier attempt recoloured one crescent four ways and two of the states came
    out 0.0097 apart in OKLab, indistinguishable.
    """
    scale = 4
    n = size * scale
    layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    px = layer.load()

    fill = (*BADGE_FILL[state], 255)
    ccx = 0.695 * n
    ccy = 0.695 * n
    outer = 0.335 * n
    # A thin white rim, not a thick one: at 32px a heavy outline ate the shape it
    # was supposed to separate.
    rim = 0.030 * n

    def coverage(x: int, y: int) -> float:
        """How much of this pixel lies inside the badge outline, 0..1."""
        d = ((x - ccx) ** 2 + (y - ccy) ** 2) ** 0.5
        return max(0.0, min(1.0, (outer + rim - d) / (rim * 2) if d > outer else 1.0))

    if state == "forced":
        # A filled triangle sitting on its base, with a thin light rim. Solid, not
        # an outline: an outlined triangle at 16px reads as a smudge.
        h = outer * 2.15
        w = h * 1.05
        top = ccy - h * 0.52
        for y in range(n):
            fy = (y - top) / h
            if fy < 0 or fy > 1:
                continue
            half = (fy * w) / 2
            for x in range(n):
                if abs(x - ccx) <= half:
                    edge = half - abs(x - ccx) < rim or y - top < rim or top + h - y < rim
                    px[x, y] = OUTLINE if edge else fill
        return layer.resize((size, size), Image.LANCZOS)

    if state == "unknown":
        # A dashed ring. Six dashes rather than eight: at 16px eight segments
        # average back into a solid ring.
        import math
        segments = 6
        for y in range(n):
            for x in range(n):
                d = ((x - ccx) ** 2 + (y - ccy) ** 2) ** 0.5
                if outer - 0.13 * n <= d <= outer + rim:
                    ang = math.atan2(y - ccy, x - ccx) + math.pi
                    if int(ang / (2 * math.pi) * segments * 2) % 2 == 0:
                        px[x, y] = fill if d >= outer - 0.10 * n else OUTLINE
        return layer.resize((size, size), Image.LANCZOS)

    # Discs: proxy filled, direct hollow, both with a thin rim.
    inner = outer * 0.60 if state == "direct" else 0.0
    for y in range(n):
        for x in range(n):
            d = ((x - ccx) ** 2 + (y - ccy) ** 2) ** 0.5
            if state == "direct":
                if outer - rim <= d <= outer + rim:
                    px[x, y] = OUTLINE
                elif inner <= d <= outer - rim:
                    px[x, y] = fill
            else:
                if d <= outer + rim:
                    px[x, y] = fill if d <= outer - rim else OUTLINE
    return layer.resize((size, size), Image.LANCZOS)


def compose(state: str, size: int) -> Image.Image:
    base = load_source(state, size)
    base.alpha_composite(draw_badge(size, state))
    return base


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="verify the shipped icons instead of writing")
    args = ap.parse_args()

    if args.check:
        problems = 0
        for state in ROUTES:
            for size in SIZES:
                path = OUT / f"{state}{size}.png"
                if not path.exists():
                    print(f"missing {path.name}")
                    problems += 1
        print("all status icons present" if not problems else f"{problems} missing")
        return 1 if problems else 0

    OUT.mkdir(parents=True, exist_ok=True)
    for state in ROUTES:
        for size in SIZES:
            img = compose(state, size)
            path = OUT / f"{state}{size}.png"
            img.save(path)
            print(f"{path.relative_to(ROOT)}  {size}x{size}  {path.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
