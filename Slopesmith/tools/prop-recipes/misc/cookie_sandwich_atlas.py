"""
Paint the family atlas for the chocolate-chip cookie ice cream sandwich prop.

128x128 RGBA, a 2x2 grid of 64px panels — the page size the target platform uses for a prop (a whole
family shares one 128x128 page across its base, head and both pipe runs).

    [0][0] cookie top      [0][1] cookie side
    [1][0] ice cream       [1][1] chocolate chip

`_lib.panels(2, 2)` describes the same grid in UV space; both come from the same two numbers so they
cannot drift apart.

Everything is painted from one fixed seed, so a re-run reproduces the same texture byte for byte and a
tweak is a diff rather than a repaint.

Run with the system Python (needs Pillow) — NOT inside Blender, whose bundled Python has none:
    python Slopesmith/tools/prop-recipes/misc/cookie_sandwich_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import bars, blob, new_atlas, panels, scatter_blobs, speckle, stripes   # noqa: E402

SIZE = 128
OUT = os.path.join(ROOT, 'build', 'cookie_sandwich.png')

GRID = panels(SIZE, 2, 2)
COOKIE_TOP, COOKIE_SIDE = GRID[0][0], GRID[0][1]
CREAM, CHIP = GRID[1][0], GRID[1][1]

# A deliberately small, slightly desaturated set — a PS2 prop reads as a handful of flat regions, and
# saturation is what makes hand-painted low-poly art look like a modern render instead.
DOUGH = (109, 69, 38)
DOUGH_LIGHT = (138, 91, 52)
DOUGH_DARK = (78, 48, 25)
CRUST = (90, 55, 32)
CRUST_DARK = (62, 37, 21)
CHOC = (43, 26, 17)
CHOC_LIT = (69, 41, 26)
CHOC_HI = (96, 60, 38)
VANILLA = (244, 232, 208)
VANILLA_SHADE = (226, 210, 178)
VANILLA_HI = (251, 244, 227)

rnd = random.Random(20260726)


def paint_cookie_top(draw):
    """The hero face: baked dough with chips painted in, so the top reads chocolate-chip at any distance
    the modelled chips are too small to carry."""
    x0, y0, x1, y1 = COOKIE_TOP
    draw.rectangle(COOKIE_TOP, fill=DOUGH)
    speckle(draw, rnd, COOKIE_TOP, 240, (DOUGH_LIGHT, DOUGH_DARK, CRUST), size=(1, 2))
    # Uneven bake blooms. Deliberately NOT concentric rings: this panel is mapped radially onto the cap,
    # so anything circular in texture space lands as a circle on the cookie and reads as a vinyl record.
    scatter_blobs(draw, rnd, COOKIE_TOP, 11, DOUGH_LIGHT, (6.0, 13.0))
    scatter_blobs(draw, rnd, COOKIE_TOP, 7, DOUGH_DARK, (5.0, 10.0))
    speckle(draw, rnd, COOKIE_TOP, 160, (DOUGH_LIGHT, DOUGH, CRUST), size=(1, 2))
    for _ in range(13):
        cx = rnd.uniform(x0 + 7, x1 - 7)
        cy = rnd.uniform(y0 + 7, y1 - 7)
        r = rnd.uniform(3.0, 5.6)
        blob(draw, rnd, cx, cy, r, r * rnd.uniform(0.82, 1.1), CHOC)
        # one lit facet up-left of centre: the chips catch the same key every other prop does
        blob(draw, rnd, cx - r * 0.28, cy - r * 0.3, r * 0.44, r * 0.4, CHOC_LIT)
    speckle(draw, rnd, COOKIE_TOP, 40, (DOUGH_LIGHT,), size=(1, 1))


def paint_cookie_side(draw):
    """The rim band. Each side quad spans this panel whole, so it repeats 12x around the cookie — the
    same trick a pipe run uses to carry two surfaces on one cell."""
    x0, y0, x1, y1 = COOKIE_SIDE
    draw.rectangle(COOKIE_SIDE, fill=CRUST)
    # baked top lip, shaded underside — the vertical read that says "thick cookie" from the side
    draw.rectangle((x0, y0, x1 - 1, y0 + 13), fill=DOUGH)
    draw.rectangle((x0, y0 + 13, x1 - 1, y0 + 18), fill=DOUGH_LIGHT)
    draw.rectangle((x0, y1 - 12, x1 - 1, y1 - 1), fill=CRUST_DARK)
    speckle(draw, rnd, COOKIE_SIDE, 200, (DOUGH_LIGHT, DOUGH_DARK, CRUST_DARK), size=(1, 2))
    for _ in range(5):   # a few chips broken open at the edge
        cx = rnd.uniform(x0 + 6, x1 - 6)
        cy = rnd.uniform(y0 + 20, y1 - 14)
        r = rnd.uniform(2.4, 4.0)
        blob(draw, rnd, cx, cy, r, r * 0.8, CHOC)
        blob(draw, rnd, cx - r * 0.25, cy - r * 0.25, r * 0.4, r * 0.35, CHOC_LIT)


def paint_cream(draw):
    """Vanilla, two rows tall: the barrel's lower ring takes the bottom half and the upper ring the top,
    so the drip streaks run continuously from cookie to cookie."""
    x0, y0, x1, y1 = CREAM
    draw.rectangle(CREAM, fill=VANILLA)
    stripes(draw, CREAM, VANILLA_SHADE, 26, rnd=rnd)
    # highlight along the squeezed-out middle, where the bulge catches the light
    draw.rectangle((x0, y0 + (y1 - y0) // 2 - 3, x1 - 1, y0 + (y1 - y0) // 2 + 2), fill=VANILLA_HI)
    speckle(draw, rnd, CREAM, 90, (VANILLA_SHADE, VANILLA_HI), size=(1, 1))


def paint_chip(draw):
    """The modelled chips' skin. Lit toward the top of the panel because every chip face maps its apex
    there — so the four sides of a chip pyramid shade consistently without needing four panels."""
    x0, y0, x1, y1 = CHIP
    draw.rectangle(CHIP, fill=CHOC)
    draw.polygon([(x0, y1 - 1), (x1 - 1, y1 - 1), ((x0 + x1) / 2, y0 + 4)], fill=CHOC_LIT)
    draw.polygon([(x0 + 12, y1 - 1), (x1 - 13, y1 - 1), ((x0 + x1) / 2, y0 + 12)], fill=CHOC_HI)
    speckle(draw, rnd, CHIP, 70, (CHOC, CHOC_LIT), size=(1, 1))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img, draw = new_atlas(SIZE)
    paint_cookie_top(draw)
    paint_cookie_side(draw)
    paint_cream(draw)
    paint_chip(draw)
    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
