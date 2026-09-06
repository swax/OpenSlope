"""
Paint the page for the snow gun. The spray is a particle emitter, so the art is only the machine.

    snow_gun.png        256x256, 4x4 grid of 64px panels, opaque

    [0][0] steel        [0][1] barrel shell   [0][2] fan face      [0][3] skid deck
    [1][0] control box  [1][1] cable          [1][2] snow          [1][3] hazard stripe

    python Slopesmith/tools/prop-recipes/misc/snow_gun_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import bars, blob, new_atlas, panels, scatter_blobs, speckle, stripes   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'snow_gun.png')

GRID = panels(SIZE, 4, 4)
STEEL, BARREL, FAN, SKID = GRID[0]
BOX, CABLE, SNOW, HAZARD = GRID[1]

PAINT = (52, 104, 148)          # the machine's own blue, the colour resort guns are usually wearing
PAINT_HI = (86, 142, 186)
PAINT_LO = (34, 72, 106)
GALV = (146, 150, 156)          # galvanised steel
GALV_HI = (186, 190, 196)
GALV_LO = (104, 108, 116)
DARK = (40, 42, 46)
DARK_HI = (68, 70, 76)
RUST = (128, 74, 44)
YELLOW = (214, 176, 48)
FROST = (238, 243, 249)
FROST_SH = (206, 217, 232)
FROST_DP = (172, 188, 208)
CABLE_C = (30, 30, 33)

rnd = random.Random(9114)
img, draw = new_atlas(SIZE)


def brushed(rect, base, hi, lo, streaks=14):
    draw.rectangle(rect, fill=base)
    stripes(draw, rect, lo, streaks, horizontal=False, width=(0.6, 2.0), rnd=rnd)
    stripes(draw, rect, hi, streaks // 2, horizontal=False, width=(0.5, 1.4), rnd=rnd)
    speckle(draw, rnd, rect, 40, (hi, lo), size=(1, 1))


def fan_face():
    """The barrel's end caps. `tube(closed_ends=True)` fans this panel as N wedges around the axis, all
    mapped identically — so a wedge drawn here comes out as a ROTATIONALLY SYMMETRIC disc on the model,
    which is exactly a fan. The apex at (0.5, 1.0) is the hub and the bottom edge is the rim."""
    x0, y0, x1, y1 = FAN
    draw.rectangle(FAN, fill=DARK)
    cx, top, bot = (x0 + x1) / 2, y0 + 3, y1 - 1
    # one blade, swept back from the hub — repeated around the disc by the fan mapping
    draw.polygon([(cx, top + 2), (x1 - 6, bot - 4), (cx + 6, bot - 2), (cx - 2, top + 10)], fill=GALV_LO)
    draw.polygon([(cx, top + 3), (x1 - 12, bot - 8), (cx + 3, bot - 5), (cx - 1, top + 11)], fill=GALV)
    draw.ellipse((cx - 7, top - 1, cx + 7, top + 12), fill=GALV_HI)     # the hub
    draw.ellipse((cx - 3, top + 3, cx + 3, top + 9), fill=DARK_HI)
    speckle(draw, rnd, FAN, 30, (DARK_HI, GALV_LO), size=(1, 1))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    draw.rectangle((0, 0, SIZE, SIZE), fill=GALV)      # spares read as steel, never black

    brushed(STEEL, GALV, GALV_HI, GALV_LO)
    for _ in range(3):
        cx, cy = rnd.uniform(STEEL[0] + 8, STEEL[2] - 8), rnd.uniform(STEEL[1] + 8, STEEL[3] - 8)
        blob(draw, rnd, cx, cy, 3.0, 2.4, RUST, lobes=7)                # weathering at the joints

    # barrel shell — painted, with a lit band along the top and a shadow under, so a cylinder that is
    # only eight-sided still reads round
    x0, y0, x1, y1 = BARREL
    draw.rectangle(BARREL, fill=PAINT)
    draw.rectangle((x0, y0, x1 - 1, y0 + 9), fill=PAINT_HI)
    draw.rectangle((x0, y1 - 11, x1 - 1, y1 - 1), fill=PAINT_LO)
    bars(draw, BARREL, PAINT_LO, 3, 2.0, horizontal=True)               # stiffening rings
    speckle(draw, rnd, BARREL, 40, (PAINT_HI, PAINT_LO), size=(1, 1))

    fan_face()

    # skid deck — galvanised tread plate. The grid is kept close in tone to the plate: at full contrast
    # a 2px bar each way reads as a chequerboard from any distance rather than as tread.
    draw.rectangle(SKID, fill=GALV_LO)
    bars(draw, SKID, GALV, 7, 2.0, horizontal=True)
    bars(draw, SKID, GALV, 7, 2.0, horizontal=False)
    speckle(draw, rnd, SKID, 40, (GALV, GALV_LO), size=(1, 1))

    # control box — a painted cabinet with a vent and a warning label
    draw.rectangle(BOX, fill=PAINT)
    bx0, by0, bx1, by1 = BOX
    draw.rectangle((bx0 + 6, by0 + 8, bx1 - 7, by0 + 26), fill=DARK)
    bars(draw, (bx0 + 6, by0 + 8, bx1 - 7, by0 + 26), DARK_HI, 4, 2.0, horizontal=True)
    draw.rectangle((bx0 + 10, by1 - 22, bx1 - 11, by1 - 12), fill=YELLOW)
    speckle(draw, rnd, BOX, 30, (PAINT_HI, PAINT_LO), size=(1, 1))

    draw.rectangle(CABLE, fill=CABLE_C)
    stripes(draw, CABLE, (58, 58, 62), 10, horizontal=False, width=(0.6, 1.6), rnd=rnd)

    # snow — the drift is mapped RADIALLY on its cap, so irregular blobs only, never rings
    draw.rectangle(SNOW, fill=FROST)
    scatter_blobs(draw, rnd, SNOW, 7, FROST_SH, (4.0, 9.0))
    scatter_blobs(draw, rnd, SNOW, 4, FROST_DP, (2.5, 5.0))
    speckle(draw, rnd, SNOW, 50, (FROST_SH, (252, 253, 255)), size=(1, 1))

    # hazard stripe for the mast foot
    draw.rectangle(HAZARD, fill=YELLOW)
    for k in range(-4, 10):
        draw.polygon([(HAZARD[0] + k * 12, HAZARD[1]), (HAZARD[0] + k * 12 + 6, HAZARD[1]),
                      (HAZARD[0] + k * 12 - 10, HAZARD[3]), (HAZARD[0] + k * 12 - 16, HAZARD[3])],
                     fill=DARK)

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
