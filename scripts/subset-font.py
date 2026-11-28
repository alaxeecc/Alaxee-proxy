#!/usr/bin/env python3
"""Subset the brand's CJK serif face down to the characters the UI renders.

Why this exists
---------------
Noto Serif SC is 1.47 MB per weight. The extension ships four weights' worth of
scope in theory but uses one, and the panel itself only ever draws a few hundred
distinct characters - so shipping the full face would make the font the single
largest file in a package whose whole point is being small. Subsetting brings it to
about 66 KB, 4.5% of the original.

The character set is derived, not maintained
--------------------------------------------
An earlier attempt kept the charset as a file outside the repository. That made the
font impossible to regenerate from a clean checkout: the build output was in Git but
its input was not, and a 403-character list is not something anyone can reconstruct
by hand. This script scans the shipped UI sources for the characters that can
actually appear, so the input is always in the repository by construction.

What it includes:
    - every character in popup.html, settings.html and the JS that renders text
    - the printable ASCII range, because generated strings (hosts, ports, numbers)
      are not literal in the source
    - CJK punctuation that the copy uses around sentences

Usage:
    python3 scripts/subset-font.py --source /path/to/NotoSerifSC-Regular.otf
    python3 scripts/subset-font.py --check          # verify the subset covers the UI

`--check` is what tests/brand.test.js runs: it fails when a character is added to
the UI that the subset lacks, which would render as a fallback font mid-sentence.

Requires fontTools and brotli. Neither is a project dependency - they are build-time
only, the same way the PNG rasteriser is. Install with:
    python3 -m pip install --user fonttools brotli
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = ROOT / "src" / "brand" / "fonts"
SUBSET = FONT_DIR / "serif-sc-400.woff2"

# Files whose literal text ends up on screen. Only the popup and settings surfaces
# matter; the service worker logs to a console the user does not read in a font.
UI_SOURCES = (
    "src/popup.html",
    "src/popup-render.js",
    "src/popup-controller.js",
    "src/core.js",
    "src/backup.js",
    "src/sync.js",
    "settings.html",
    "settings.js",
)

# Characters that cannot appear literally in the list above but do appear in output:
# punctuation the copy leans on, and the full printable ASCII range because hosts,
# ports and byte counts are formatted at runtime rather than written out.
# Deliberately no speculative punctuation: an early version added ° and ‰ "in case",
# and the check then failed on a character that never appears on screen. The UI
# sources below are the whole input.
EXTRA_PUNCTUATION = "·—‘’“”…、。〈〉《》「」『』【】"
ASCII_PRINTABLE = "".join(chr(code) for code in range(0x20, 0x7F))

# fonts.css splits the work between two faces with unicode-range: the Latin face
# covers U+0000-00FF and U+2000-206F, the CJK face covers everything else. Checking
# every character against the CJK subset therefore reported all of ASCII as missing
# even though the browser never reaches for it there. Each face is checked against
# the range it is actually responsible for.
LATIN_RANGES = ((0x0000, 0x00FF), (0x2000, 0x206F))


def owned_by_latin(character: str) -> bool:
    code = ord(character)
    return any(start <= code <= end for start, end in LATIN_RANGES)


def is_cjk(character: str) -> bool:
    """True for the characters the serif subset is genuinely responsible for.

    Noto Serif SC contains no arrow, no gear and no geometric symbol, so requiring it
    to cover the ⚙ in the settings button would make this check unsatisfiable. Those
    are drawn by the browser's fallback chain by design; the serif face only has to
    carry Han characters and CJK punctuation, where a fallback would be obvious
    mid-sentence.
    """
    code = ord(character)
    return (
        0x4E00 <= code <= 0x9FFF      # CJK unified ideographs
        or 0x3400 <= code <= 0x4DBF   # extension A
        or 0x3000 <= code <= 0x303F   # CJK punctuation
        or 0xFF00 <= code <= 0xFFEF   # fullwidth forms
    )


def ui_characters() -> str:
    """Every character the shipped UI can draw, sorted for a stable hash."""
    found: set[str] = set(ASCII_PRINTABLE) | set(EXTRA_PUNCTUATION)
    for relative in UI_SOURCES:
        path = ROOT / relative
        if not path.exists():
            continue
        for character in path.read_text(encoding="utf-8"):
            # Control characters and the private-use range are not worth a glyph.
            if character.isprintable() and not (0xE000 <= ord(character) <= 0xF8FF):
                found.add(character)
    return "".join(sorted(found))


def check() -> int:
    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        print("fontTools is not installed; cannot verify the subset.")
        print("  python3 -m pip install --user fonttools brotli")
        return 2

    if not SUBSET.exists():
        print(f"missing {SUBSET.relative_to(ROOT)}")
        return 1

    font = TTFont(SUBSET)
    # getBestCmap returns code point -> glyph name for the best available subtable.
    covered = set(font.getBestCmap())
    cjk_wanted = {character for character in ui_characters() if is_cjk(character)}
    missing = sorted({character for character in cjk_wanted if ord(character) not in covered})

    latin_face = FONT_DIR / "serif-latin-400.woff2"
    latin_missing: set[str] = set()
    if latin_face.exists():
        latin_covered = set(TTFont(latin_face).getBestCmap())
        latin_wanted = {character for character in ui_characters() if owned_by_latin(character)}
        latin_missing = {character for character in latin_wanted if ord(character) not in latin_covered}

    if missing:
        print(f"{len(missing)} CJK character(s) render in a fallback font:")
        print("  " + "".join(missing))
        print("Regenerate with: python3 scripts/subset-font.py --source <NotoSerifSC.otf>")
        return 1
    if latin_missing:
        print(f"{len(latin_missing)} Latin character(s) render in a fallback font:")
        print("  " + "".join(sorted(latin_missing)))
        return 1

    # Symbols outside the CJK ranges are expected to fall back; report them so a new
    # one is visible in the build output rather than a surprise on screen.
    fallback = sorted(
        character for character in ui_characters()
        if not is_cjk(character) and not owned_by_latin(character) and ord(character) >= 0x2000
        and ord(character) not in covered
    )
    detail = f" ({len(fallback)} symbol(s) use the fallback font: {''.join(fallback)})" if fallback else ""
    print(f"subset covers all {len(cjk_wanted)} CJK characters the UI can draw{detail}")
    return 0


def subset(source: Path) -> int:
    try:
        from fontTools import subset as fonttools_subset
    except ImportError:
        print("fontTools is not installed; cannot build the subset.")
        print("  python3 -m pip install --user fonttools brotli")
        return 2

    if not source.exists():
        print(f"source font not found: {source}")
        print("Download Noto Serif SC from https://fonts.google.com/noto/specimen/Noto+Serif+SC")
        return 1

    wanted = ui_characters()
    FONT_DIR.mkdir(parents=True, exist_ok=True)

    options = fonttools_subset.Options()
    options.flavor = "woff2"
    options.desubroutinize = True
    options.drop_tables += ["DSIG"]
    # Hinting is dropped deliberately: the panel renders at 11-17px on high-DPI
    # displays where the browser's own rasteriser does the work, and the hints are
    # a large share of what remains after subsetting.
    options.hinting = False
    options.layout_features = ["*"]
    options.notdef_outline = True

    font = fonttools_subset.load_font(str(source), options)
    subsetter = fonttools_subset.Subsetter(options)
    subsetter.populate(text=wanted)
    subsetter.subset(font)
    fonttools_subset.save_font(font, str(SUBSET), options)
    font.close()

    size = SUBSET.stat().st_size
    print(f"wrote {SUBSET.relative_to(ROOT)}: {len(wanted)} characters, {size / 1024:.0f} KB")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, help="full Noto Serif SC .otf/.ttf to subset from")
    parser.add_argument("--check", action="store_true", help="verify the committed subset covers the UI")
    parser.add_argument("--print-chars", action="store_true", help="dump the derived character set")
    args = parser.parse_args()

    if args.print_chars:
        print(ui_characters())
        return 0
    if args.check:
        return check()
    if args.source:
        return subset(args.source)

    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
