#!/usr/bin/env python3
"""Verify the toolbar icons that ship with the extension.

Why this exists
---------------
Three of the eight toolbar PNGs shipped in 0.1.3 were corrupt: one had a bad
palette CRC and two were truncated mid-file. Nothing checked them, so the only
symptom was a blank toolbar icon at high DPI - and the 32px icon is exactly what
manifest action.default_icon points at. That is the failure this script exists to
catch, and it is the one thing it still does.

The icons themselves
--------------------
icons/status/{proxy,direct,forced,unknown}{16,32}.png are the brand kit's own PNGs,
copied byte for byte from alaxee-kit/brand/icons/png/. tests/icons.test.js compares
the bytes, so a re-encode that happens to look the same still fails.

This script verifies them. It generates nothing, and it should not: two earlier
versions drew the icons programmatically and both produced artwork that was *like*
the identity rather than the identity.

How the state is shown
----------------------
Not by the artwork. The four kit files differ in time of day, not in routing state,
and at 16px two of them are 0.0097 apart in OKLab - indistinguishable, which is why
the toolbar used to look the same in every mode.

A shape badge composited into the corner was tried and rejected: the kit's picture
is not a canvas for app chrome, and it looked like a sticker on a logo. The route is
now carried by Edge's own action badge - a letter and a colour drawn by the browser
outside the image - so the artwork is untouched. See ROUTE_BADGES in background.js.

The state mapping
-----------------
The kit labels its icons by time of day, not by routing state, so the mapping below
is a product decision rather than something the artwork dictates:

    proxy     icon-day      morning star rising from the cloud bank; the default
    direct    icon-night-sleep  the only dark icon, so it cannot be confused
    forced    icon-noon     the brightest, for "a rule is holding this page"
    unknown   icon-morning  the palest

Day and night are the two that stay distinct at 16px; see tests/icons.test.js.

Usage:
    python3 scripts/render-icons.py --check    # verify the shipped icons
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "icons" / "status"

SIZES = (16, 32)
ROUTES = ("proxy", "direct", "forced", "unknown")

# Where each shipped file came from in the kit. Recorded so the mapping can be
# audited and re-applied when the kit is updated, rather than reconstructed from
# memory by comparing pixels.
SOURCE_OF = {
    "proxy": "icon-day",
    "direct": "icon-night-sleep",
    "forced": "icon-noon",
    "unknown": "icon-morning",
}

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def inspect(path: Path) -> tuple[bool, str, int, int]:
    """Walks the chunk table. Returns (ok, reason, width, height)."""
    data = path.read_bytes()
    if len(data) < 8 or data[:8] != PNG_SIGNATURE:
        return False, "bad signature", 0, 0

    offset = 8
    width = height = 0
    saw_idat = False
    while offset < len(data):
        if offset + 8 > len(data):
            return False, f"truncated before chunk header at {offset}", width, height
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        tag = data[offset + 4:offset + 8]
        if not all(65 <= byte <= 90 or 97 <= byte <= 122 for byte in tag):
            return False, f"invalid chunk type at {offset}", width, height
        if offset + 12 + length > len(data):
            return False, f"truncated {tag.decode('latin1')} chunk at {offset}", width, height

        payload = data[offset + 8:offset + 8 + length]
        declared = struct.unpack(">I", data[offset + 8 + length:offset + 12 + length])[0]
        if zlib.crc32(tag + payload) & 0xFFFFFFFF != declared:
            return False, f"{tag.decode('latin1')} chunk CRC mismatch", width, height
        if tag == b"IHDR":
            width, height = struct.unpack(">II", payload[:8])
        if tag == b"IDAT":
            saw_idat = True

        offset += 12 + length
        if tag == b"IEND":
            if not saw_idat:
                return False, "no IDAT chunk", width, height
            return True, "", width, height

    return False, "no IEND chunk", width, height


def check() -> int:
    problems: list[str] = []

    for route in ROUTES:
        for size in SIZES:
            path = OUT_DIR / f"{route}{size}.png"
            if not path.is_file():
                problems.append(f"missing: {path.relative_to(ROOT)}")
                continue
            ok, reason, width, height = inspect(path)
            if not ok:
                problems.append(f"corrupt: {path.relative_to(ROOT)} ({reason})")
                continue
            if (width, height) != (size, size):
                problems.append(
                    f"wrong size: {path.relative_to(ROOT)} is {width}x{height}, expected {size}x{size}"
                )

    if problems:
        print("Toolbar icons are unusable:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print(
            "\nThese are the brand kit's files, copied from alaxee-kit/brand/icons/png/."
            "\nRestore them from the kit rather than generating replacements.",
            file=sys.stderr,
        )
        return 1

    print(f"All {len(ROUTES) * len(SIZES)} toolbar icons present, valid and correctly sized")
    for route, source in SOURCE_OF.items():
        print(f"  {route:8} <- {source}")
    return 0


def main() -> int:
    if "--check" in sys.argv:
        return check()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
