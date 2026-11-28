"""用这套图标生成 logo：换成你项目的名字也行。

    pip install fonttools brotli resvg-py pillow      # resvg-py、pillow 只在要 PNG 时需要
    python tools/make_logo.py --name 远黛 --sub YUANDAI
    python tools/make_logo.py --name 星河 --sub XINGHE --out ../my-logo
    python tools/make_logo.py --name Nova            # 只有一行字也行

在 --out（默认 brand/logo/）里写出：
    logo-h-light.svg / logo-h-dark.svg                横版，静止（印刷、文档、Figma）
    logo-h-light-animated.svg / logo-h-dark-animated.svg   横版，会动：图标呼吸，名字一个字一个字浮现
    logo-v-*.svg / logo-v-*-animated.svg              竖版（图标在上，名字在下）
    wordmark-light.svg / wordmark-dark.svg            只有字
    以上每个静止版各一张 PNG（2 倍大小，透明底）
light 放在浅色底上，dark 放在深色底上。字已经转成路径，用的地方不用装字体。
浅色版的图标是“破晓”（会动的版本里先放一遍破晓开场），深色版是“守夜”。
"""
from __future__ import annotations

import argparse
import io
import re
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

KIT = Path(__file__).resolve().parent.parent
FONTS = KIT / "fonts"
ICONS = KIT / "brand" / "icons"

INK = {"light": ("#4A3340", "#9C7E8A"), "dark": ("#F3EDE7", "#B5A9A4")}
ICON = {"light": ("icon-day.svg", "icon-day-rise.svg"), "dark": ("icon-night.svg", "icon-night.svg")}   # (静止, 会动)

_fonts: dict[str, TTFont] = {}


def font(name: str) -> TTFont:
    if name not in _fonts:
        _fonts[name] = TTFont(FONTS / name)
    return _fonts[name]


def glyphs(font_file: str, text: str, size: float, spacing: float, tight_latin: bool = False) -> tuple[list[tuple[float, str]], float]:
    """每个字的 (x, 路径)，以及整行的宽度。x 从 0 开始。"""
    f = font(font_file)
    cmap, gs, upm = f.getBestCmap(), f.getGlyphSet(), f["head"].unitsPerEm
    missing = [ch for ch in text if ord(ch) not in cmap]
    if missing:
        raise SystemExit(f"字体 {font_file} 里没有这些字：{''.join(missing)}")
    k, x, out = size / upm, 0.0, []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        gs[name].draw(pen)
        out.append((x, pen.getCommands()))
        gap = spacing * .25 if tight_latin and ord(ch) <= 0x2E7F else spacing   # 名字里的西文字母挨得近一点（第二行故意疏开）
        x += gs[name].width * k + gap
    return out, x - gap if text else 0.0


def line(items: list[tuple[float, str]], x0: float, baseline: float, size: float, upm: int = 1000) -> str:
    k = size / upm
    return "".join(f'<g><path transform="translate({x0 + x:.1f} {baseline:.1f}) scale({k:.5f} {-k:.5f})" d="{d}"/></g>' for x, d in items)


def icon_inner(svg: str, prefix: str) -> str:
    """把图标 SVG 拆出来嵌进 logo；id 加前缀，免得一页里放两个 logo 时打架。"""
    inner = svg[svg.index(">", svg.index("<svg")) + 1:svg.rindex("</svg>")]
    ids = set(re.findall(r'id="([^"]+)"', inner))
    inner = re.sub(r'id="([^"]+)"', lambda m: f'id="{prefix}{m.group(1)}"', inner)
    return re.sub(r'(href="#|url\(#)([^")]+)', lambda m: m.group(1) + (prefix + m.group(2) if m.group(2) in ids else m.group(2)), inner)


def style(n: int) -> str:
    delays = "".join(f"  .cn > g:nth-child({i + 1}) {{ animation-delay: {.9 + .25 * i:.2f}s; }}\n" for i in range(n))
    return ("<style>\n"
            "  .cn > g, .en { opacity: 0; animation: rise 1.1s cubic-bezier(.2,.8,.2,1) forwards; }\n"
            f"{delays}"
            f"  .en {{ animation: spread 1.6s cubic-bezier(.2,.8,.2,1) {.9 + .25 * n + .35:.2f}s forwards; }}\n"
            "  @keyframes rise { from { opacity: 0; translate: 0 14px; filter: blur(4px); } to { opacity: 1; translate: 0 0; filter: blur(0); } }\n"
            "  @keyframes spread { from { opacity: 0; translate: -10px 0; } to { opacity: 1; translate: 0 0; } }\n"
            "  @media (prefers-reduced-motion: reduce) { .cn > g, .en { animation: none; opacity: 1; } }\n"
            "</style>\n")


def build(name: str, sub: str, layout: str, tone: str, animated: bool, icon: bool = True) -> tuple[str, int, int]:
    ink, subink = INK[tone]
    sc, latin = "serif-sc-600.woff2", "serif-latin-400.woff2"
    upm_sc, upm_la = font(sc)["head"].unitsPerEm, font(latin)["head"].unitsPerEm
    if layout == "h":
        cn, cw = glyphs(sc, name, 150, 22, True)
        en, ew = glyphs(latin, sub.upper(), 44, 16) if sub else ([], 0)
        tx = 364 if icon else 48
        base_cn = 214 if sub else 232              # 只有一行字时，字的视觉中心对准图标中心
        up = 0 if icon else base_cn - 180          # 只有字：整体往上收，上下留白一样
        W, H = int(max(tx + cw, tx + 6 + ew) + 48), 356 if icon else (310 if sub else 246)
        parts = [line(cn, tx, base_cn - up, 150, upm_sc), line(en, tx + 6, 284 - up, 44, upm_la) if sub else ""]
        box = (48, 48)
    else:
        cn, cw = glyphs(sc, name, 120, 18, True)
        en, ew = glyphs(latin, sub.upper(), 36, 14) if sub else ([], 0)
        W = int(max(260, cw, ew) + 96)
        H = 48 + 260 + 40 + 100 + (60 if sub else 0) + 48
        parts = [line(cn, (W - cw) / 2, 448, 120, upm_sc), line(en, (W - ew) / 2, 508, 36, upm_la) if sub else ""]
        box = ((W - 260) / 2, 48)
    still, moving = ICON[tone]
    icon_svg = ""
    if icon:
        src = (ICONS / "animated" / moving) if animated else (ICONS / "static" / still)
        icon_svg = f'<svg x="{box[0]:.0f}" y="{box[1]:.0f}" width="260" height="260" viewBox="0 0 140 140">{icon_inner(src.read_text(encoding="utf-8"), f"{layout}{tone[0]}-")}</svg>\n'
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">\n'
           + (style(len(name)) if animated else "")
           + icon_svg
           + f'<g class="cn" fill="{ink}">{parts[0]}</g>\n'
           + (f'<g class="en" fill="{subink}">{parts[1]}</g>\n' if sub else "")
           + "</svg>\n")
    return svg, W, H


def png(svg: str, w: int, h: int, path: Path) -> bool:
    try:
        import resvg_py
        from PIL import Image
    except ImportError:
        return False
    data = bytes(resvg_py.svg_to_bytes(svg_string=svg, width=w * 2, height=h * 2))
    Image.open(io.BytesIO(data)).save(path, optimize=True)
    return True


def make_all(name: str, sub: str, out: Path) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for layout in ("h", "v"):
        for tone in ("light", "dark"):
            for animated in (False, True):
                svg, w, h = build(name, sub, layout, tone, animated)
                f = out / f"logo-{layout}-{tone}{'-animated' if animated else ''}.svg"
                f.write_text(svg, encoding="utf-8")
                written.append(f.name)
                if not animated and png(svg, w, h, f.with_suffix(".png")):
                    written.append(f.with_suffix(".png").name)
    for tone in ("light", "dark"):
        svg, w, h = build(name, sub, "h", tone, False, icon=False)
        f = out / f"wordmark-{tone}.svg"
        f.write_text(svg, encoding="utf-8")
        written.append(f.name)
        if png(svg, w, h, f.with_suffix(".png")):
            written.append(f.with_suffix(".png").name)
    return written


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="用这套图标生成横版 / 竖版 logo")
    ap.add_argument("--name", required=True, help="主名字，比如 远黛")
    ap.add_argument("--sub", default="", help="第二行（拼音或英文，会转成大写），可以不写")
    ap.add_argument("--out", default=str(KIT / "brand" / "logo"), help="写到哪个文件夹")
    a = ap.parse_args()
    files = make_all(a.name, a.sub, Path(a.out))
    print(f"写好 {len(files)} 个文件 → {a.out}")
