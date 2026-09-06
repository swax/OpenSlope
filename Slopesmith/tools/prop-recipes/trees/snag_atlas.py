"""
Paint the snag atlas — weathered dead wood. No alpha: a snag is solid geometry, not cards.

The one opaque page in the tree set, and the smallest. A dead standing trunk has no foliage to cut out,
so the whole prop is a tapered tube with broken stubs and this 128x128 carries every surface on it.

128x128 RGBA, a 2x2 grid of 64x64 cells:

    [0][0] weathered bark        [0][1] raw splintered wood
    [1][0] end grain             [1][1] bare silvered wood, bark gone

`end grain` is the exception to the rule in `_lib.radial_uv`, which warns that concentric art lands as
concentric circles on a cap and reads as a vinyl record. On the broken top of a trunk that is exactly
what is wanted — growth rings ARE concentric, and this is the one panel in the library that should be
drawn as rings on purpose.

Bark cracks are FEW and WIDE for the usual reason: the cell is stretched around one trunk face at
roughly 0.1 cm per pixel across against 2 cm per pixel up, so fine vertical detail disappears.

    python Slopesmith/tools/prop-recipes/trees/snag_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, panels, scatter_blobs, speckle   # noqa: E402

SIZE = 128
OUT = os.path.join(ROOT, 'build', 'snag.png')

GRID = panels(SIZE, 2, 2)
BARK, SPLINTER = GRID[0][0], GRID[0][1]
GRAIN, SILVER = GRID[1][0], GRID[1][1]

BARK_MID = (104, 96, 86)
BARK_DARK = (56, 51, 46)
BARK_LIT = (146, 138, 126)
WOOD_PALE = (188, 170, 142)
WOOD_MID = (154, 134, 108)
WOOD_DARK = (108, 90, 70)
SILVER_MID = (158, 154, 146)
SILVER_LIT = (196, 192, 184)
SILVER_DARK = (110, 106, 100)
CHAR = (44, 40, 36)

rnd = random.Random(6553600)


def paint_bark(draw):
    x0, y0, x1, y1 = BARK
    draw.rectangle(BARK, fill=BARK_MID + (255,))
    for _ in range(4):                                   # few, wide cracks; fine ones vanish
        w = rnd.uniform(4, 9)
        x = rnd.uniform(x0 + 1, x1 - 2 - w)
        draw.rectangle((x, y0, x + w, y1 - 1), fill=BARK_DARK + (255,))
        draw.rectangle((x + w, y0, x + w + rnd.uniform(1.5, 3.0), y1 - 1), fill=BARK_LIT + (255,))
    # ONE sloughed patch, and a soft one. This cell tiles 20 times over the trunk, so any high-contrast
    # island in it becomes a regular polka-dot grid — the repeat is far more visible than the mark.
    xa = rnd.uniform(x0, x1 - 22)
    ya = rnd.uniform(y0 + 4, y1 - 16)
    draw.rectangle((xa, ya, xa + rnd.uniform(14, 22), ya + rnd.uniform(8, 14)),
                   fill=BARK_LIT + (255,))
    speckle(draw, rnd, BARK, 70, (BARK_DARK + (255,), BARK_LIT + (255,)), size=(1, 2))


def paint_splinter(draw):
    """Raw pale wood, for the spikes on the broken top."""
    x0, y0, x1, y1 = SPLINTER
    draw.rectangle(SPLINTER, fill=WOOD_MID + (255,))
    for _ in range(11):                                  # long fibres running up the splinter
        x = rnd.uniform(x0, x1 - 2)
        draw.rectangle((x, y0, x + rnd.uniform(0.8, 2.4), y1 - 1),
                       fill=(WOOD_PALE if rnd.random() < 0.55 else WOOD_DARK) + (255,))
    speckle(draw, rnd, SPLINTER, 40, (WOOD_DARK + (255,), WOOD_PALE + (255,)), size=(1, 1))


def paint_grain(draw):
    """Growth rings for the broken top — concentric ON PURPOSE, see the module docstring."""
    x0, y0, x1, y1 = GRAIN
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    draw.rectangle(GRAIN, fill=WOOD_PALE + (255,))
    r = (x1 - x0) * 0.5
    while r > 1.0:
        draw.ellipse((cx - r, cy - r, cx + r, cy + r),
                     outline=(WOOD_DARK if rnd.random() < 0.6 else WOOD_MID) + (255,), width=1)
        r -= rnd.uniform(1.6, 3.8)                       # uneven spacing: rings are not a target
    for _ in range(3):                                   # radial checks, the cracks a drying log opens
        a = rnd.uniform(0, 6.28)
        import math
        draw.line([(cx, cy), (cx + math.cos(a) * (x1 - x0) * 0.5, cy + math.sin(a) * (y1 - y0) * 0.5)],
                  fill=CHAR + (255,), width=1)
    draw.ellipse((cx - 2, cy - 2, cx + 2, cy + 2), fill=WOOD_DARK + (255,))     # heartwood


def paint_silver(draw):
    """Bare weathered wood, bark long gone — grey, hard, faintly striped."""
    x0, y0, x1, y1 = SILVER
    draw.rectangle(SILVER, fill=SILVER_MID + (255,))
    for _ in range(8):
        x = rnd.uniform(x0, x1 - 3)
        draw.rectangle((x, y0, x + rnd.uniform(1.5, 4.5), y1 - 1),
                       fill=(SILVER_LIT if rnd.random() < 0.5 else SILVER_DARK) + (255,))
    scatter_blobs(draw, rnd, SILVER, 3, SILVER_DARK + (255,), (2.5, 5.0))
    speckle(draw, rnd, SILVER, 50, (SILVER_LIT + (255,), SILVER_DARK + (255,)), size=(1, 1))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img, draw = new_atlas(SIZE, bg=BARK_MID + (255,))    # OPAQUE: no cutout anywhere on this prop
    paint_bark(draw)
    paint_splinter(draw)
    paint_grain(draw)
    paint_silver(draw)
    img.save(OUT)

    px = img.load()
    clear = sum(1 for y in range(SIZE) for x in range(SIZE) if px[x, y][3] < 250)
    print(f'wrote {OUT} {img.size} {img.mode}')
    print(f'  {clear} pixel(s) not fully opaque (should be 0 — this prop is solid geometry)')
    img.resize((SIZE * 5, SIZE * 5), 0).save(OUT.replace('.png', '_5x.png'))


if __name__ == '__main__':
    main()
