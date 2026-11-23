#!/usr/bin/env python3
"""Render the four XEE toolbar state icons to PNG without any dependency.

Why this exists
---------------
The toolbar icons used to exist in three independent forms: ~193 lines of
OffscreenCanvas drawing in background.js, an inline SVG in popup.html, and eight
committed PNGs. The PNGs could not be regenerated from anything, so a broken file
had no source of truth to fall back on - and three of them were in fact corrupt
(proxy16 had a bad palette CRC, and two 32px files were truncated).

This script is the source of truth for the PNGs. It draws the same geometry as
the popup SVG using only the Python standard library: no Pillow, no cairo, no
npm dependency, consistent with the project's zero-dependency rule.

Geometry note: shapes are defined in the 48x48 coordinate space used by the
popup SVG so both stay recognisably the same mark.

Usage:
    python3 scripts/render-icons.py            # write icons/status/*.png
    python3 scripts/render-icons.py --check    # verify committed icons match
"""
from __future__ import annotations

import argparse
import math
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "icons" / "status"

SIZES = (16, 32)
# Matches the toolbar action button, which is 16 DIP in Chromium.
DESIGN = 48.0

Rgb = tuple[int, int, int]
Rgba = tuple[int, int, int, int]

# Gradient stops shared with popup.css / popup.html so both surfaces agree.
ORBIT_STOPS = ((0.0, (0x8D, 0x8C, 0xFF)), (0.55, (0xF2, 0xBC, 0x9B)), (1.0, (0x8A, 0xE8, 0xFF)))
FLOW_STOPS = ((0.0, (0x8D, 0x8C, 0xFF)), (0.48, (0xD9, 0x9C, 0xFF)), (1.0, (0x69, 0xDD, 0xF2)))
XEE_STOPS = ((0.0, (0xFF, 0xD8, 0x8A)), (0.48, (0xD9, 0x9C, 0xFF)), (1.0, (0x69, 0xDD, 0xF2)))

NODE_BLUE = (0xB9, 0xB2, 0xFF)
NODE_PINK = (0xE8, 0xB6, 0xD9)
NODE_CYAN = (0x8A, 0xE8, 0xFF)
GLINT = (0xFF, 0xE5, 0xB6)
WARN = (0xFF, 0xD1, 0x8C)


# --------------------------------------------------------------------------- #
# Minimal canvas: supersampled RGBA raster with alpha compositing              #
# --------------------------------------------------------------------------- #
class Canvas:
    """Accumulates coverage per pixel at SUPERSAMPLE resolution, then downsamples."""

    SUPERSAMPLE = 4

    def __init__(self, size: int) -> None:
        self.size = size
        self.width = size * self.SUPERSAMPLE
        self.height = self.width
        self.buffer = [[0.0, 0.0, 0.0, 0.0] for _ in range(self.width * self.height)]

    # -- coordinate mapping -------------------------------------------------- #
    # Set by fit(): the design-space centre and the device-space scale that maps
    # the drawing's actual bounds onto the canvas with a small margin.
    _origin_x = DESIGN / 2
    _origin_y = DESIGN / 2
    _factor = 1.0

    def fit(self, bounds: tuple[float, float, float, float], margin: float = 0.06) -> None:
        """Centres the drawing's bounding box and scales it to fill the canvas.

        Computing the fit from real bounds rather than a hand-tuned constant is
        what stops edge artwork from being clipped; every earlier attempt to pick
        the constant by eye cut off rings and arrow heads at 16px.
        """
        min_x, min_y, max_x, max_y = bounds
        span = max(max_x - min_x, max_y - min_y)
        usable = self.width * (1.0 - 2 * margin)
        self._factor = usable / span
        self._origin_x = (min_x + max_x) / 2
        self._origin_y = (min_y + max_y) / 2

    def to_device(self, x: float, y: float) -> tuple[float, float]:
        return (
            (x - self._origin_x) * self._factor + self.width / 2,
            (y - self._origin_y) * self._factor + self.height / 2,
        )

    # -- painting ------------------------------------------------------------ #
    def blend(self, px: int, py: int, colour: Rgb, alpha: float) -> None:
        if alpha <= 0 or px < 0 or py < 0 or px >= self.width or py >= self.width:
            return
        alpha = min(1.0, alpha)
        slot = self.buffer[py * self.width + px]
        r, g, b, a = slot
        out_a = alpha + a * (1.0 - alpha)
        if out_a <= 0:
            return
        slot[0] = (colour[0] * alpha + r * a * (1.0 - alpha)) / out_a
        slot[1] = (colour[1] * alpha + g * a * (1.0 - alpha)) / out_a
        slot[2] = (colour[2] * alpha + b * a * (1.0 - alpha)) / out_a
        slot[3] = out_a

    def stamp(self, cx: float, cy: float, radius: float, colour_at) -> None:
        """Paints a disc of device-space radius, colour may vary by position."""
        min_x = max(0, int(cx - radius - 1))
        max_x = min(self.width - 1, int(cx + radius + 1))
        min_y = max(0, int(cy - radius - 1))
        max_y = min(self.height - 1, int(cy + radius + 1))
        for py in range(min_y, max_y + 1):
            for px in range(min_x, max_x + 1):
                distance = math.hypot(px + 0.5 - cx, py + 0.5 - cy)
                coverage = clamp(radius + 0.5 - distance)
                if coverage <= 0:
                    continue
                self.blend(px, py, colour_at(px + 0.5, py + 0.5), coverage)

    # -- geometry ------------------------------------------------------------ #
    def stroke(self, points: list[tuple[float, float]], width: float, colour_at) -> None:
        """Strokes a polyline with round caps and joins."""
        radius = width / 2
        device = [self.to_device(x, y) for x, y in points]
        for (x0, y0), (x1, y1) in zip(device, device[1:]):
            length = math.hypot(x1 - x0, y1 - y0)
            steps = max(1, int(length * 2))
            for step in range(steps + 1):
                t = step / steps
                self.stamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, colour_at)
        for x, y in (device[0], device[-1]):
            self.stamp(x, y, radius, colour_at)

    def circle_outline(self, cx: float, cy: float, r: float, width: float, colour_at) -> None:
        points = [
            (cx + r * math.cos(2 * math.pi * i / 96), cy + r * math.sin(2 * math.pi * i / 96))
            for i in range(97)
        ]
        self.stroke(points, width, colour_at)

    def fill_disc(self, cx: float, cy: float, r: float, colour: Rgb) -> None:
        dx, dy = self.to_device(cx, cy)
        self.stamp(dx, dy, r * self._factor, lambda _x, _y: colour)

    def fill_diamond(self, cx: float, cy: float, r: float, colour: Rgb) -> None:
        """Fills a rotated square; used for the unknown-state warning marker."""
        device = [self.to_device(cx + dx, cy + dy) for dx, dy in ((0, -r), (r, 0), (0, r), (-r, 0))]
        min_x = max(0, int(min(p[0] for p in device)) - 1)
        max_x = min(self.width - 1, int(max(p[0] for p in device)) + 1)
        min_y = max(0, int(min(p[1] for p in device)) - 1)
        max_y = min(self.height - 1, int(max(p[1] for p in device)) + 1)
        # L1 distance test against the diamond's half-extents.
        rx = abs(device[1][0] - device[0][0]) or 1.0
        ry = abs(device[2][1] - device[1][1]) or 1.0
        for py in range(min_y, max_y + 1):
            for px in range(min_x, max_x + 1):
                if abs(px + 0.5 - device[0][0]) / rx + abs(py + 0.5 - device[1][1]) / ry <= 1.0:
                    self.blend(px, py, colour, 1.0)

    # -- output -------------------------------------------------------------- #
    def to_rgba(self) -> list[Rgba]:
        factor = self.SUPERSAMPLE
        out: list[Rgba] = []
        for y in range(self.size):
            for x in range(self.size):
                r = g = b = a = 0.0
                for sy in range(factor):
                    for sx in range(factor):
                        slot = self.buffer[(y * factor + sy) * self.width + (x * factor + sx)]
                        w = slot[3]
                        r += slot[0] * w
                        g += slot[1] * w
                        b += slot[2] * w
                        a += w
                total = factor * factor
                if a <= 0:
                    out.append((0, 0, 0, 0))
                else:
                    out.append((round(r / a), round(g / a), round(b / a), round(255 * a / total)))
        return out


def clamp(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def gradient(stops, t: float) -> Rgb:
    t = clamp(t)
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if t <= p1:
            span = p1 - p0
            k = 0.0 if span == 0 else (t - p0) / span
            return (
                round(c0[0] + (c1[0] - c0[0]) * k),
                round(c0[1] + (c1[1] - c0[1]) * k),
                round(c0[2] + (c1[2] - c0[2]) * k),
            )
    return stops[-1][1]


def linear(stops, x0: float, y0: float, x1: float, y1: float, order: str = "x"):
    """Maps device coordinates onto a 0..1 ramp along the SVG gradient vector."""
    def colour_at(dx: float, dy: float) -> Rgb:
        if order == "diag":
            t = ((dx + dy) / 2 - x0) / ((x1 + y1) / 2 - x0)
        else:
            t = (dx - x0) / (x1 - x0)
        return gradient(stops, t)
    return colour_at


# --------------------------------------------------------------------------- #
# The state silhouettes                                                   #
# --------------------------------------------------------------------------- #
def route_bounds(route: str) -> tuple[float, float, float, float]:
    """Bounding box of the route silhouette, including half its stroke width.

    The central X is intentionally excluded: it is the constant part of the mark
    and should keep its size relative to the silhouette that carries the meaning.
    """
    if route == "proxy":
        return (24 - 18.2 - 1.95, 24 - 18.2 - 1.95, 24 + 18.2 + 1.95, 24 + 18.2 + 1.95)
    if route == "direct":
        return (6.8 - 2.1, 7.0 - 2.1, 44.0 + 2.1, 40.0 + 2.1)
    # unknown: broken orbit fragments plus the warning diamond.
    return (7.0, 5.5, 42.0, 41.0)


def draw_route(canvas: Canvas, route: str) -> None:
    """Route silhouette. Mirrors the shapes in src/popup.html."""
    orbit = linear(ORBIT_STOPS, canvas.to_device(7, 39)[0], 0, canvas.to_device(43, 13)[0], 0)
    flow = linear(FLOW_STOPS, canvas.to_device(7, 39)[0], 0, canvas.to_device(44, 7)[0], 0)

    if route == "proxy":
        # Closed orbit: a ring that reaches close to the canvas edge, plus three
        # route nodes sitting on the ring.
        canvas.circle_outline(24, 24, 18.2, 3.9, orbit)
        for x, y, r, colour in (
            (7.6, 30.2, 3.6, NODE_BLUE),
            (24.0, 40.6, 3.6, NODE_PINK),
            (40.4, 17.8, 3.7, NODE_CYAN),
        ):
            canvas.fill_disc(x, y, r, colour)

    elif route == "direct":
        # One trajectory that leaves through an arrow head.
        canvas.stroke(
            [(6.8, 37.1), (16.0, 40.0), (25.8, 36.0), (31.1, 26.0), (36.0, 15.0), (43.0, 7.0)],
            4.2,
            flow,
        )
        canvas.fill_disc(7.3, 37.2, 1.65, NODE_BLUE)

    elif route == "unknown":
        # Broken orbit fragments plus a warning diamond.
        canvas.stroke([(7.5, 29.5), (8.0, 22.0), (14.0, 12.5), (23.0, 8.8)], 3.1, orbit)
        canvas.stroke([(31.3, 8.8), (38.0, 11.5), (41.6, 17.5), (41.5, 23.5)], 3.1, orbit)
        canvas.stroke([(39.5, 30.2), (36.0, 37.0), (27.5, 42.0), (18.8, 40.3)], 3.1, orbit)
        canvas.stroke([(11.3, 37.1), (9.0, 35.0), (7.6, 31.0)], 3.1, orbit)
        # Solid warning diamond with a bright rim, kept fully inside the canvas:
        # at the design position the apex was clipped by the 1.16 zoom.
        canvas.fill_diamond(27.0, 12.4, 4.4, WARN)
        canvas.stroke(
            [(27.0, 8.0), (31.4, 12.4), (27.0, 16.8), (22.6, 12.4), (27.0, 8.0)],
            1.1,
            lambda _x, _y: (0xFF, 0xF0, 0xD5),
        )


def draw_xee(canvas: Canvas) -> None:
    """The central crossing mark, identical in every state."""
    xee = linear(XEE_STOPS, canvas.to_device(9, 9)[0], 0, canvas.to_device(41, 40)[0], 0, "diag")
    canvas.stroke([(13, 12.5), (35, 35.5)], 5.1, xee)
    canvas.stroke([(35, 12.5), (13, 35.5)], 5.1, xee)
    # Upper-right flare.
    canvas.stroke([(37.2, 7.2), (37.2, 13.3)], 1.25, lambda _x, _y: GLINT)
    canvas.stroke([(34.15, 10.25), (40.25, 10.25)], 1.25, lambda _x, _y: GLINT)
    canvas.fill_disc(37.2, 10.25, 1.7, (0xFF, 0xF8, 0xE9))


# --------------------------------------------------------------------------- #
# PNG writing (stdlib only)                                                    #
# --------------------------------------------------------------------------- #
def write_png(path: Path, size: int, pixels: list[Rgba]) -> None:
    """Writes an 8-bit RGBA PNG."""
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 (None)
        for x in range(size):
            raw.extend(pixels[y * size + x])

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def render(route: str, size: int) -> list[Rgba]:
    canvas = Canvas(size)
    canvas.fit(route_bounds(route))
    draw_route(canvas, route)
    draw_xee(canvas)
    return canvas.to_rgba()


ROUTES = ("proxy", "direct", "unknown")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="regenerate into memory and compare against the committed files",
    )
    args = parser.parse_args()

    mismatches: list[str] = []
    for route in ROUTES:
        for size in SIZES:
            path = OUT_DIR / f"{route}{size}.png"
            expected = render(route, size)
            if args.check:
                if not path.is_file():
                    mismatches.append(f"missing: {path.relative_to(ROOT)}")
                    continue
                actual = read_png(path)
                if actual != expected:
                    differing = sum(1 for a, b in zip(actual, expected) if a != b)
                    mismatches.append(
                        f"stale: {path.relative_to(ROOT)} ({differing} pixels differ)"
                    )
            else:
                OUT_DIR.mkdir(parents=True, exist_ok=True)
                write_png(path, size, expected)
                print(f"wrote {path.relative_to(ROOT)}")

    if args.check:
        if mismatches:
            print("Committed icons do not match scripts/render-icons.py:", file=sys.stderr)
            for item in mismatches:
                print(f"  {item}", file=sys.stderr)
            print("Run: python3 scripts/render-icons.py", file=sys.stderr)
            return 1
        print(f"All {len(ROUTES) * len(SIZES)} icons match scripts/render-icons.py")
    return 0


def read_png(path: Path) -> list[Rgba]:
    """Minimal 8-bit RGBA reader, used only by --check."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"not a PNG: {path}")
    offset = 8
    width = height = 0
    idat = bytearray()
    while offset + 8 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        tag = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        if tag == b"IHDR":
            width, height = struct.unpack(">II", payload[:8])
            if payload[8] != 8 or payload[9] != 6:
                raise SystemExit(f"{path}: expected 8-bit RGBA")
        elif tag == b"IDAT":
            idat.extend(payload)
        elif tag == b"IEND":
            break
        offset += 12 + length

    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    pixels: list[Rgba] = []
    previous = bytearray(stride)
    position = 0
    for _ in range(height):
        filter_type = raw[position]
        position += 1
        line = bytearray(raw[position : position + stride])
        position += stride
        if filter_type == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 0xFF
        elif filter_type == 2:
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif filter_type == 3:
            for i in range(stride):
                left = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = previous[i]
                c = previous[i - 4] if i >= 4 else 0
                line[i] = (line[i] + _paeth(a, b, c)) & 0xFF
        elif filter_type != 0:
            raise SystemExit(f"{path}: unsupported filter {filter_type}")
        pixels.extend(tuple(line[i : i + 4]) for i in range(0, stride, 4))
        previous = line
    return pixels


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


if __name__ == "__main__":
    raise SystemExit(main())
