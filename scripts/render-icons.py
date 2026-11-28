#!/usr/bin/env python3
"""Render the four toolbar state icons to PNG without any dependency.

Why this exists
---------------
The toolbar icons used to exist in three independent forms: ~193 lines of
OffscreenCanvas drawing in background.js, an inline SVG in popup.html, and eight
committed PNGs. The PNGs could not be regenerated from anything, so a broken file
had no source of truth to fall back on - and three of them were in fact corrupt
(proxy16 had a bad palette CRC, and two 32px files were truncated).

This script is the source of truth for the PNGs. It draws the same geometry as
the popup header mark using only the Python standard library: no Pillow, no
cairo, no npm dependency, consistent with the project's zero-dependency rule.

Geometry note: shapes are defined in the 48x48 coordinate space used by the popup
SVG so both stay recognisably the same mark. The two must be edited together: the
artwork is a crescent opening toward a four-point star, and both files position
those two figures in the same box.

States: proxy / direct / forced / unknown. `forced` is not a routing outcome - a
blacklist hit resolves to "proxy" - it is the same icon in amber, answering "why
is this page proxied?" at a glance. src/core.js iconStateFor() makes that choice.

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

# Brand palette from alaxee-kit (远黛 YUANDAI). Four toolbar states share one mark -
# the crescent and the four-point star - and differ only in colour, because the kit's
# time-of-day variants are three pinks that are indistinguishable at 16px:
# measured average colours were #edb0c0 / #eaacbd / #f5c5cf for day/morning/noon.
#
#   proxy   晨粉 dusk rose   - traffic is being carried by a proxy
#   direct  success teal     - the browser is going straight out
#   block   warning amber    - forced through the proxy by the blacklist
#   unknown faint grey       - state could not be determined
STAR_PINK = ((0.0, (0xFF, 0xE3, 0xC8)), (0.45, (0xF6, 0xA8, 0xC4)), (1.0, (0xC8, 0x54, 0x8B)))
STAR_TEAL = ((0.0, (0xCF, 0xEE, 0xE6)), (0.5, (0x54, 0xB3, 0x9F)), (1.0, (0x1F, 0x6B, 0x5F)))
STAR_AMBER = ((0.0, (0xFB, 0xE4, 0xC2)), (0.5, (0xD9, 0x96, 0x4A)), (1.0, (0x8F, 0x57, 0x13)))
STAR_GREY = ((0.0, (0xE8, 0xDF, 0xE4)), (0.5, (0xB8, 0xA6, 0xAF)), (1.0, (0x85, 0x70, 0x7B)))

MOON_PINK = ((0.0, (0xF7, 0xB8, 0xD0)), (1.0, (0xD9, 0x77, 0xA4)))
MOON_TEAL = ((0.0, (0x9C, 0xDD, 0xCC)), (1.0, (0x4A, 0xA8, 0x95)))
MOON_AMBER = ((0.0, (0xF5, 0xCE, 0x96)), (1.0, (0xD0, 0x94, 0x4E)))
MOON_GREY = ((0.0, (0xD3, 0xC5, 0xCD)), (1.0, (0x9A, 0x88, 0x92)))

# The routing model has three outcomes, not four: a blacklist hit resolves to "proxy".
# The fourth icon here is that distinction made visible - same shape, amber ring - for
# the toolbar. It is derived, not a new route.
STATE = {
    "proxy": (STAR_PINK, MOON_PINK),
    "direct": (STAR_TEAL, MOON_TEAL),
    "forced": (STAR_AMBER, MOON_AMBER),
    "unknown": (STAR_GREY, MOON_GREY),
}


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
    """Bounding box of the drawn mark, including the pen width.

    All four states share one silhouette now, so the box is the same for three of
    them; the unknown state carries an outer ring that needs a little more room.
    """
    # Crescent: centre (17, 27) radius 12.4 plus its 4.2 pen. Star: centre (30, 17.5)
    # radius 12.6 plus its 5.3 pen. Union of the two.
    left = min(17.0 - 12.4, 30.0 - 12.6) - 4.0
    top = min(27.0 - 12.4, 17.5 - 12.6) - 4.0
    right = max(17.0 + 12.4, 30.0 + 12.6) + 4.0
    bottom = max(27.0 + 12.4, 17.5 + 12.6) + 4.0
    if route == "unknown":
        left = min(left, 24 - 21.0 - 0.8)
        top = min(top, 24 - 21.0 - 0.8)
        right = max(right, 24 + 21.0 + 0.8)
        bottom = max(bottom, 24 + 21.0 + 0.8)
    return (left, top, right, bottom)


def four_point_star(canvas: "Canvas", cx: float, cy: float, radius: float, colour_at) -> None:
    """The brand's four-point star, drawn from its own bezier definition.

    The kit defines it as  M0 -1 C.05 -.18 .18 -.05 1 0  C.18 .05 .05 .18 0 1
    C-.05 .18 -.18 .05 -1 0  C-.18 -.05 -.05 -.18 0 -1 Z  in a unit square. Sampling
    that curve rather than approximating with a diamond keeps the pinched waist that
    makes it recognisably this mark instead of a generic sparkle.
    """
    def bezier(p0, p1, p2, p3, t):
        mt = 1 - t
        return (
            mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0],
            mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1],
        )

    quadrants = (
        ((0.0, -1.0), (0.05, -0.18), (0.18, -0.05), (1.0, 0.0)),
        ((1.0, 0.0), (0.18, 0.05), (0.05, 0.18), (0.0, 1.0)),
        ((0.0, 1.0), (-0.05, 0.18), (-0.18, 0.05), (-1.0, 0.0)),
        ((-1.0, 0.0), (-0.18, -0.05), (-0.05, -0.18), (0.0, -1.0)),
    )
    outline: list[tuple[float, float]] = []
    for p0, p1, p2, p3 in quadrants:
        for step in range(13):
            x, y = bezier(p0, p1, p2, p3, step / 12)
            outline.append((cx + x * radius, cy + y * radius))
    # Fill by stroking the closed outline with a heavy pen: at 16px the star is a few
    # pixels across, and a real polygon fill would alias into mush.
    canvas.stroke(outline + [outline[0]], radius * 0.42, colour_at)


def draw_crescent(canvas: "Canvas", cx: float, cy: float, radius: float, colour_at) -> None:
    """Crescent, drawn as the visible arc only.

    The naive approach - a filled disc with a second disc punched out - cannot work
    here: the rasteriser composites rather than subtracts, so painting the bite with an
    opaque colour fills the moon black instead of removing it. Stroking just the outer
    arc leaves the lune open toward the star, which is the same silhouette the brand
    uses.
    """
    # The opening faces the upper right, where the star sits.
    start = math.radians(125)
    end = math.radians(-70)
    points = []
    steps = 64
    for i in range(steps + 1):
        angle = start + (end - start) * (i / steps)
        points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    canvas.stroke(points, radius * 0.42, colour_at)


def draw_route(canvas: "Canvas", route: str) -> None:
    """One mark for every state: a crescent behind a four-point star.

    The original icons encoded state in geometry - an orbit, an arrow, a broken ring.
    At 16px that read as three unrelated scribbles. The brand has a single recognisable
    figure, so state now lives in colour and the figure stays constant, which is also
    how the kit itself works (one star, four times of day).
    """
    star_stops, moon_stops = STATE[route]
    star = linear(star_stops, canvas.to_device(12, 34)[0], 0, canvas.to_device(36, 12)[0], 0, "diag")
    moon = linear(moon_stops, canvas.to_device(10, 10)[0], 0, canvas.to_device(30, 38)[0], 0, "diag")

    # Crescent sits behind and to the left; the star overlaps its open side.
    draw_crescent(canvas, 17.0, 27.0, 12.4, moon)
    four_point_star(canvas, 30.0, 17.5, 12.6, star)

    if route == "forced":
        # Amber halo: resolved to the proxy because a blacklist rule matched.
        canvas.circle_outline(24, 24, 21.0, 1.9, lambda _x, _y: (0xC2, 0x7C, 0x30))

    if route == "unknown":
        # A question rather than a shape: a faint ring around the mark reads as "not
        # determined" without changing the silhouette.
        canvas.circle_outline(24, 24, 21.0, 1.5, lambda _x, _y: (0xB8, 0xA6, 0xAF))


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
    """Renders one state.

    The old cross mark is gone: it was the previous identity's centrepiece, and the
    brand mark is now the crescent-and-star itself. Keeping both produced a 16px icon
    with three overlapping figures, which read as noise.
    """
    canvas = Canvas(size)
    canvas.fit(route_bounds(route))
    draw_route(canvas, route)
    return canvas.to_rgba()


ROUTES = ("proxy", "direct", "forced", "unknown")


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
