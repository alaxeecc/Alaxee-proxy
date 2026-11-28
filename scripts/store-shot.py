#!/usr/bin/env python3
"""Fit a raw screenshot onto the canvas Partner Center accepts.

Microsoft accepts exactly two screenshot sizes: 640x480 and 1280x800. A screenshot
of the popup is portrait and a screenshot of the settings page is wider than 16:10,
so neither lands on a valid size by itself. This scales the capture to fit inside
the canvas without changing its aspect ratio, then centres it on the interface
background colour. Nothing is cropped and nothing is stretched.

Usage:
  python3 scripts/store-shot.py capture.png
  python3 scripts/store-shot.py *.png --size 640x480
  python3 scripts/store-shot.py capture.png --out store-assets/shot-1.png

Output defaults to store-assets/shot-<padded>.png, which is ignored by Git.
"""
from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

try:
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store-assets"

# Partner Center's two accepted sizes. There is no third option.
ACCEPTED = {"1280x800": (1280, 800), "640x480": (640, 480)}

# Fallback padding colour: --bg of the light theme. The real padding colour is
# sampled from the capture's own border, because the interface background is a
# subtle gradient - a hardcoded value leaves a visible band where the padding
# starts, which reads as a mistake.
PAD_BG = (0xFA, 0xF6, 0xF4)

# A little breathing room so the capture does not touch the canvas edge, which reads
# as a crop even when it is not.
MARGIN = 24

# How far a pixel may drift from the background colour and still count as background.
# Screenshots pick up a little noise from the compositor.
BG_TOLERANCE = 10

# Fraction of a row or column that must be background before it is treated as margin.
# Not 1.0: a stray antialiased pixel at one end should not pin the crop.
BG_RATIO = 0.98

# With --mode cover --anchor top, how much of the top to preserve before cropping.
# A viewport capture starts with the brand header, and cropping from row 0 cuts it.
COVER_TOP_KEEP = 0.035


def border_colour(img: Image.Image) -> tuple[int, int, int]:
    """The dominant colour around the edge - the page or window background."""
    counts: Counter[tuple[int, int, int]] = Counter()
    w, h = img.size
    for x in range(w):
        counts[img.getpixel((x, 0))] += 1
        counts[img.getpixel((x, h - 1))] += 1
    for y in range(h):
        counts[img.getpixel((0, y))] += 1
        counts[img.getpixel((w - 1, y))] += 1
    return counts.most_common(1)[0][0]


def _uniform(pixels, bg: tuple[int, int, int]) -> bool:
    hits = 0
    total = 0
    for p in pixels:
        total += 1
        if max(abs(p[i] - bg[i]) for i in range(3)) <= BG_TOLERANCE:
            hits += 1
    return total > 0 and hits / total >= BG_RATIO


def trim_margins(img: Image.Image) -> Image.Image:
    """Drop uniform background rows and columns at the edges.

    Two different problems, one rule. A settings capture carries wide empty page
    margins on both sides, which shrink the interface when it is fitted to a
    1280-wide canvas; dropping them makes the small print readable again. A popup
    capture can carry a stray few pixels of window chrome on one edge, which show
    up as a coloured stripe in the listing. Neither is content, and a row that is
    entirely background cannot be.

    The rule only ever removes rows and columns that are uniform background, so it
    cannot cut off part of the interface.
    """
    bg = border_colour(img.convert("RGB"))
    w, h = img.size
    rgb = img.convert("RGB")
    left, right, top, bottom = 0, w - 1, 0, h - 1
    while left < right and _uniform((rgb.getpixel((left, y)) for y in range(h)), bg):
        left += 1
    while right > left and _uniform((rgb.getpixel((right, y)) for y in range(h)), bg):
        right -= 1
    while top < bottom and _uniform((rgb.getpixel((x, top)) for x in range(w)), bg):
        top += 1
    while bottom > top and _uniform((rgb.getpixel((x, bottom)) for x in range(w)), bg):
        bottom -= 1
    if (left, top, right, bottom) == (0, 0, w - 1, h - 1):
        return img
    return img.crop((left, top, right + 1, bottom + 1))


def fit(src: Image.Image, canvas: tuple[int, int], mode: str = "contain",
        anchor: str = "top") -> Image.Image:
    """Place the capture on the canvas.

    contain: fit entirely inside, pad the leftover with the capture's own
             background. Nothing is lost, but a capture that is squarer than the
             16:10 canvas is scaled down to fit the height, so the interface
             shrinks and the text with it.

    cover:   fill the canvas and crop the overflow. The interface stays large, but
             part of a tall capture is lost. Anchoring to the top keeps the header
             and the top cards, which is what a viewport capture would show.
    """
    if mode == "cover":
        scale = max(canvas[0] / src.width, canvas[1] / src.height)
        w = max(1, round(src.width * scale))
        h = max(1, round(src.height * scale))
        art = src.resize((w, h), Image.LANCZOS)
        left = (w - canvas[0]) // 2
        if anchor == "top":
            # Not 0: the header sits on the very first row of a viewport capture,
            # so cropping flush to the top shaves the wordmark. Keeping a slice of
            # the top means the header survives and the crop lands in the content.
            top = min(round(h * COVER_TOP_KEEP), h - canvas[1])
            top = max(0, top)
        else:
            top = (h - canvas[1]) // 2
        return art.crop((left, top, left + canvas[0], top + canvas[1]))

    box = (canvas[0] - MARGIN * 2, canvas[1] - MARGIN * 2)
    scale = min(box[0] / src.width, box[1] / src.height)
    w = max(1, round(src.width * scale))
    h = max(1, round(src.height * scale))
    art = src.resize((w, h), Image.LANCZOS)
    pad = border_colour(src)
    out = Image.new("RGB", canvas, pad)
    out.paste(art, ((canvas[0] - w) // 2, (canvas[1] - h) // 2))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path, help="raw screenshots")
    ap.add_argument("--size", default="1280x800", choices=sorted(ACCEPTED), help="canvas size")
    ap.add_argument("--out", type=Path, help="output path (single input only)")
    ap.add_argument("--no-trim", action="store_true", help="keep uniform background margins")
    ap.add_argument("--mode", default="contain", choices=("contain", "cover"),
                    help="contain fits inside and pads; cover fills and crops")
    ap.add_argument("--anchor", default="center", choices=("top", "center"),
                    help="with --mode cover, which end to keep")
    args = ap.parse_args()

    canvas = ACCEPTED[args.size]
    if args.out and len(args.inputs) > 1:
        sys.exit("--out only makes sense with one input")

    OUT.mkdir(exist_ok=True)
    for i, path in enumerate(args.inputs, 1):
        if not path.exists():
            sys.exit(f"not found: {path}")
        with Image.open(path) as im:
            src = im.convert("RGB")
        original = src.size
        if not args.no_trim:
            src = trim_margins(src)
        shot = fit(src, canvas, mode=args.mode, anchor=args.anchor)
        dest = args.out or (OUT / f"shot-{i}-{args.size}.png")
        if args.out:
            dest.parent.mkdir(parents=True, exist_ok=True)
        shot.save(dest)
        grew = " (upscaled)" if canvas[0] > src.width else ""
        note = ""
        if src.size != original:
            note = f"  trimmed {original[0]-src.width}x{original[1]-src.height}"
        print(f"{path.name}  {original[0]}x{original[1]} -> {dest.name}  {canvas[0]}x{canvas[1]}{note}{grew}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
