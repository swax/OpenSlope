"""Slopesmith brand icons — trace the source mark once, emit every derived asset.

`media/slopesmith_anvil_icon_source.png` is the drawn artwork. Everything the page links to
is generated from a single vector trace of it, so the SVGs and the rasters can never
drift apart. Run after changing the source PNG or the wordmark constants below.

    python -m pip install -r Slopesmith/tools/generate-icons/requirements.txt
    python Slopesmith/tools/generate-icons/makeicons.py
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import potrace
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]      # Slopesmith/
MEDIA = ROOT / "media"
PUBLIC = ROOT / "public"

NAME = "Slopesmith"
TAGLINE = "Carve the mountain, then carve the mountain"
DESCRIPTION = "Author and test-ride SSX-style snowboard courses in your browser with OpenSlope."

INK = "#16202c"           # dark-surface colour, sampled from the source PNG
INK_LIGHT = "#ffffff"     # the inverse mark, for dark surfaces
BG_TILE = (22, 32, 44)    # #16202c — the app canvas colour, used for icon tiles
BG_BAR = "#0c141d"        # the top-bar colour, used for theme-color
MUTED = (159, 179, 200)   # #9fb3c8 — the chrome's muted label colour


# ------------------------------------------------------------------ trace ----
def masks(src: Path):
    """Extract the light mark from its flat dark source tile.

    The source is intentionally kept as the supplied opaque PNG. Thresholding its high-
    contrast white artwork gives us one deterministic mask for every raster and vector
    target, including the enclosed highlight cuts in the anvil.
    """
    g = np.array(Image.open(src).convert("L")).astype(int)
    return g >= 128


def trace(mask, turdsize: int = 8):
    """Vector-trace a boolean mask into subpaths of line and cubic segments."""
    # Bitmap() inverts whatever it is handed, so feed it the negated mask to end up
    # tracing `mask` itself as the ink region.
    bmp = potrace.Bitmap(~mask.astype(bool))
    out = []
    for curve in bmp.trace(turdsize=turdsize, alphamax=1.0, opticurve=True, opttolerance=0.2):
        segs = []
        for seg in curve:
            if seg.is_corner:
                segs.append(("L", (seg.c.x, seg.c.y)))
                segs.append(("L", (seg.end_point.x, seg.end_point.y)))
            else:
                segs.append(("C", (seg.c1.x, seg.c1.y), (seg.c2.x, seg.c2.y),
                             (seg.end_point.x, seg.end_point.y)))
        out.append(((curve.start_point.x, curve.start_point.y), segs))
    return out


def flatten(subpaths, steps: int = 32):
    """Subpaths -> polygons in source-pixel space, for bounds and rasterising."""
    polys = []
    for start, segs in subpaths:
        pts = [start]
        cur = start
        for seg in segs:
            if seg[0] == "L":
                cur = seg[1]
                pts.append(cur)
            else:
                _, c1, c2, p = seg
                for i in range(1, steps + 1):
                    t = i / steps
                    m = 1 - t
                    pts.append((
                        m**3 * cur[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t**3 * p[0],
                        m**3 * cur[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t**3 * p[1],
                    ))
                cur = p
        polys.append(pts)
    return polys


# -------------------------------------------------------------------- svg ----
def fmt(v: float) -> str:
    return f"{round(v, 2):g}"


def to_d(subpaths, sx: float, sy: float, k: float) -> str:
    """Path data, mapping a source pixel to `(px - s) * k`."""
    def m(p):
        return ((p[0] - sx) * k, (p[1] - sy) * k)
    parts = []
    for start, segs in subpaths:
        x, y = m(start)
        parts.append(f"M{fmt(x)} {fmt(y)}")
        for seg in segs:
            if seg[0] == "L":
                x, y = m(seg[1])
                parts.append(f"L{fmt(x)} {fmt(y)}")
            else:
                c1, c2, p = m(seg[1]), m(seg[2]), m(seg[3])
                parts.append(f"C{fmt(c1[0])} {fmt(c1[1])} {fmt(c2[0])} {fmt(c2[1])} {fmt(p[0])} {fmt(p[1])}")
        parts.append("Z")
    return "".join(parts)


# -------------------------------------------------------------- rasterise ----
class Art:
    """The traced mark plus the bounds every layout is expressed against."""

    def __init__(self, src: Path):
        artwork = masks(src)
        self.src_mask_ink = artwork
        self.ink = trace(artwork)
        self.polys_ink = flatten(self.ink)
        pts = [p for poly in self.polys_ink for p in poly]
        self.x0, self.x1 = min(p[0] for p in pts), max(p[0] for p in pts)
        self.y0, self.y1 = min(p[1] for p in pts), max(p[1] for p in pts)
        self.w, self.h = self.x1 - self.x0, self.y1 - self.y0

    def alpha(self, polys, box, size, ss: int = 4):
        """Even-odd fill of `polys` into an 8-bit alpha channel.

        `box` is the (x, y, w, h) destination rect in output pixels that the artwork
        bounds map onto. Drawn supersampled and filtered down for clean edges.
        """
        bx, by, bw, bh = box
        w, h = size
        sx, sy = bw / self.w, bh / self.h
        acc = np.zeros((h * ss, w * ss), dtype=bool)
        for poly in polys:
            img = Image.new("1", (w * ss, h * ss), 0)
            pts = [((((p[0] - self.x0) * sx) + bx) * ss, (((p[1] - self.y0) * sy) + by) * ss)
                   for p in poly]
            ImageDraw.Draw(img).polygon(pts, fill=1)
            acc ^= np.array(img, dtype=bool)
        return Image.fromarray((acc * 255).astype(np.uint8), mode="L").resize((w, h), Image.LANCZOS)

    def tile(self, size, bg, frac: float, colour=(255, 255, 255)) -> Image.Image:
        """An opaque tile with the inverse mark centred at `frac` of its width."""
        w, h = size
        img = Image.new("RGB", (w, h), bg)
        mw = w * frac
        mh = mw * (self.h / self.w)
        box = ((w - mw) / 2, (h - mh) / 2, mw, mh)
        img.paste(Image.new("RGB", (w, h), colour), (0, 0), self.alpha(self.polys_ink, box, size))
        return img

    def fidelity(self):
        """Re-rasterise the traced geometry over the source and report the disagreement."""
        h, w = self.src_mask_ink.shape
        box = (self.x0, self.y0, self.w, self.h)   # map the bounds back onto themselves
        a = np.array(self.alpha(self.polys_ink, box, (w, h), ss=1)) > 127
        diff = int((a ^ self.src_mask_ink).sum())
        return [("artwork", diff, 100.0 * diff / self.src_mask_ink.size)]


def font(names, size):
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()


# ------------------------------------------------------------------- main ----
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=Path, default=MEDIA / "slopesmith_anvil_icon_source.png")
    ap.add_argument("--out", type=Path, default=PUBLIC)
    ap.add_argument("--sheet", type=Path, help="also write a contact sheet here for eyeballing")
    args = ap.parse_args()

    art = Art(args.src)
    args.out.mkdir(parents=True, exist_ok=True)
    print(f"traced {args.src.name}: artwork={len(art.ink)} subpaths")
    print(f"artwork bounds {art.w:.1f}x{art.h:.1f} at ({art.x0:.1f}, {art.y0:.1f})")

    # Favicon: the mark centred in a square with a hair of padding, plus a dark-scheme
    # override so it inverts rather than vanishing into a dark tab strip. The presentation
    # attribute holds the light-scheme look for renderers that ignore the stylesheet.
    side, pad = 512.0, 0.03
    k = (side * (1 - 2 * pad)) / max(art.w, art.h)
    ox = art.x0 - (side / k - art.w) / 2
    oy = art.y0 - (side / k - art.h) / 2
    (args.out / "slopesmith_icon.svg").write_text(
        f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(side)} {fmt(side)}">
  <title>{NAME}</title>
  <style>
    @media (prefers-color-scheme: dark) {{
      .ink {{ fill: {INK_LIGHT} }}
    }}
  </style>
  <path class="ink" fill="{INK}" fill-rule="evenodd" d="{to_d(art.ink, ox, oy, k)}"/>
</svg>
""", encoding="utf-8")

    # Header mark: the inverse cut — artwork alone, interiors left open so the dark chrome
    # shows through — cropped tight so it sits flush beside the wordmark.
    kk = 256.0 / art.w
    (args.out / "slopesmith_icon_light.svg").write_text(
        f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(art.w * kk)} {fmt(art.h * kk)}">
  <title>{NAME}</title>
  <path fill="{INK_LIGHT}" fill-rule="evenodd" d="{to_d(art.ink, art.x0, art.y0, kk)}"/>
</svg>
""", encoding="utf-8")

    # Home-screen icons are full-bleed opaque tiles: iOS masks the corners itself and
    # renders transparency as black. Maskable art must survive an aggressive circular
    # crop, so it sits inside the middle 80%.
    art.tile((180, 180), BG_TILE, 0.72).save(args.out / "apple-touch-icon.png")
    art.tile((192, 192), BG_TILE, 0.72).save(args.out / "icon-192.png")
    art.tile((512, 512), BG_TILE, 0.72).save(args.out / "icon-512.png")
    art.tile((512, 512), BG_TILE, 0.54).save(args.out / "icon-maskable-512.png")
    ico = art.tile((256, 256), BG_TILE, 0.78)
    ico.save(args.out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    # Social card: the mark over the wordmark, on the app's own background.
    og = (1200, 630)
    card = Image.new("RGB", og, BG_TILE)
    mw = 300.0
    card.paste(Image.new("RGB", og, (255, 255, 255)), (0, 0),
               art.alpha(art.polys_ink, ((og[0] - mw) / 2, 150, mw, mw * (art.h / art.w)), og))
    draw = ImageDraw.Draw(card)
    for text, f, fill, y in (
        (NAME, font(["seguisb.ttf", "segoeuib.ttf", "arialbd.ttf"], 84), (255, 255, 255), 400),
        (TAGLINE, font(["segoeui.ttf", "arial.ttf"], 30), MUTED, 505),
    ):
        draw.text(((og[0] - draw.textbbox((0, 0), text, font=f)[2]) / 2, y), text, font=f, fill=fill)
    card.save(args.out / "og-image.png")

    (args.out / "site.webmanifest").write_text(json.dumps({
        "name": NAME,
        "short_name": NAME,
        "description": DESCRIPTION,
        "start_url": "/",
        "display": "standalone",
        "background_color": "#16202c",
        "theme_color": BG_BAR,
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png",
             "purpose": "maskable"},
            {"src": "/slopesmith_icon.svg", "sizes": "any", "type": "image/svg+xml",
             "purpose": "any"},
        ],
    }, indent=2) + "\n", encoding="utf-8")

    for name in ("slopesmith_icon.svg", "slopesmith_icon_light.svg", "favicon.ico",
                 "apple-touch-icon.png", "icon-192.png", "icon-512.png",
                 "icon-maskable-512.png", "og-image.png", "site.webmanifest"):
        print(f"  {name:26} {(args.out / name).stat().st_size:>8,}B")

    # The trace is only worth trusting if it still agrees with the pixels it came from.
    for tag, diff, pct in art.fidelity():
        print(f"fidelity {tag:11} {diff:>7,} px differ from the source ({pct:.3f}% of canvas)")

    if args.sheet:
        sheet = Image.new("RGB", (1200, 400), (90, 90, 90))
        sheet.paste(Image.open(args.out / "apple-touch-icon.png"), (20, 20))
        sheet.paste(Image.open(args.out / "icon-maskable-512.png").resize((180, 180), Image.LANCZOS),
                    (220, 20))
        for i, px in enumerate((16, 32, 48)):
            sheet.paste(ico.resize((px, px), Image.LANCZOS), (420 + i * 40, 20))
        bar = Image.new("RGB", (560, 46), (12, 20, 29))
        mh = 22
        bar.paste(Image.new("RGB", (560, 46), (255, 255, 255)), (0, 0),
                  art.alpha(art.polys_ink, (10, (46 - mh) / 2, mh * (art.w / art.h), mh), (560, 46)))
        sheet.paste(bar, (20, 230))
        sheet.paste(Image.open(args.out / "og-image.png").resize((600, 315), Image.LANCZOS), (590, 20))
        sheet.save(args.sheet)
        print(f"wrote {args.sheet}")


if __name__ == "__main__":
    main()
