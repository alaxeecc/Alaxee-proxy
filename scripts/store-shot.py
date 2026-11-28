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
from pathlib import Path

try:
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store-assets"

# Partner Center's two accepted sizes. There is no third option.
ACCEPTED = {"1280x800": (1280, 800), "640x480": (640, 480)}

# --bg of the light theme, so the padding is the interface's own colour rather than
# an arbitrary white that clashes with the warm off-white the UI actually uses.
PAD_BG = (0xFA, 0xF6, 0xF4)

# A little breathing room so the capture does not touch the canvas edge, which reads
# as a crop even when it is not.
MARGIN = 24


def fit(src: Image.Image, canvas: tuple[int, int]) -> Image.Image:
    box = (canvas[0] - MARGIN * 2, canvas[1] - MARGIN * 2)
    scale = min(box[0] / src.width, box[1] / src.height)
    w = max(1, round(src.width * scale))
    h = max(1, round(src.height * scale))
    art = src.resize((w, h), Image.LANCZOS)
    out = Image.new("RGB", canvas, PAD_BG)
    out.paste(art, ((canvas[0] - w) // 2, (canvas[1] - h) // 2))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", type=Path, help="raw screenshots")
    ap.add_argument("--size", default="1280x800", choices=sorted(ACCEPTED), help="canvas size")
    ap.add_argument("--out", type=Path, help="output path (single input only)")
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
        shot = fit(src, canvas)
        dest = args.out or (OUT / f"shot-{i}-{args.size}.png")
        if args.out:
            dest.parent.mkdir(parents=True, exist_ok=True)
        shot.save(dest)
        grew = " (upscaled)" if canvas[0] > src.width else ""
        print(f"{path.name}  {src.width}x{src.height} -> {dest}  {canvas[0]}x{canvas[1]}{grew}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
