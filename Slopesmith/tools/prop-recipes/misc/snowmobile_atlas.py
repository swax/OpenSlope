"""
Paint the family atlas for the snowmobile prop.

256x256 RGBA, a 4x4 grid of 64px panels. Bigger than the cookie's 128x128 because a vehicle wears more
distinct surfaces than a dessert does — but still ONE page for the whole prop, the way SNOW's snow
blower family shares one, and still inside the importer's 512-per-edge cap.

    [0][0] body           [0][1] body dark      [0][2] track          [0][3] seat
    [1][0] ski            [1][1] metal          [1][2] windshield     [1][3] headlight
    [2][0] tunnel         [2][1] vent/grille    [2][2] (spare)        [2][3] (spare)
    [3][*] (spare)

`_lib.panels(4, 4)` describes the same grid in UV space.

A red utility/patrol sled: the palette is deliberately narrow and a little desaturated, because a PS2
prop reads as a handful of flat regions and saturation is what makes low-poly art look like a modern
render instead.

    python Slopesmith/tools/prop-recipes/misc/snowmobile_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import bars, blob, new_atlas, panels, scatter_blobs, speckle, stripes   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'snowmobile.png')

GRID = panels(SIZE, 4, 4)
BODY, BODY_DARK, TRACK, SEAT = GRID[0][0], GRID[0][1], GRID[0][2], GRID[0][3]
SKI, METAL, GLASS, LIGHT = GRID[1][0], GRID[1][1], GRID[1][2], GRID[1][3]
TUNNEL, VENT = GRID[2][0], GRID[2][1]

RED = (166, 42, 38)
RED_HI = (198, 68, 58)
RED_LO = (118, 28, 26)
PLASTIC = (38, 38, 43)
PLASTIC_HI = (60, 60, 68)
RUBBER = (26, 26, 28)
RUBBER_HI = (52, 52, 57)
VINYL = (30, 30, 34)
VINYL_HI = (74, 74, 82)
SKI_GREY = (46, 48, 55)
SKI_HI = (92, 96, 105)
STEEL = (138, 142, 149)
STEEL_LO = (104, 108, 115)
STEEL_HI = (176, 180, 187)
SMOKE = (58, 70, 84)
SMOKE_HI = (108, 126, 145)
LENS = (228, 216, 172)
LENS_HI = (252, 246, 214)
ALU = (150, 154, 161)

rnd = random.Random(4041207)


def flat(draw, rect, base, hi, lo, wear=0):
    """A painted panel: flat base, a lit band along the top, a shaded one along the bottom. The lit/shade
    bands are what keep a big untextured body face from reading as a plastic slab."""
    x0, y0, x1, y1 = rect
    draw.rectangle(rect, fill=base)
    draw.rectangle((x0, y0, x1 - 1, y0 + 7), fill=hi)
    draw.rectangle((x0, y1 - 9, x1 - 1, y1 - 1), fill=lo)
    if wear:
        speckle(draw, rnd, rect, wear, (hi, lo), size=(1, 2))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img, draw = new_atlas(SIZE)
    draw.rectangle((0, 0, SIZE, SIZE), fill=PLASTIC)   # spare cells read as dark plastic, not black

    # body — the sled's colour, with a swept graphic so the flanks are not one flat field
    flat(draw, BODY, RED, RED_HI, RED_LO, wear=40)
    x0, y0, x1, y1 = BODY
    draw.polygon([(x0, y1 - 22), (x1 - 1, y1 - 34), (x1 - 1, y1 - 20), (x0, y1 - 8)], fill=RED_LO)
    draw.polygon([(x0, y1 - 26), (x1 - 1, y1 - 38), (x1 - 1, y1 - 34), (x0, y1 - 22)], fill=(235, 235, 232))

    flat(draw, BODY_DARK, PLASTIC, PLASTIC_HI, (24, 24, 28), wear=30)

    # track — regular cleat bars, unlike the irregular crumb noise everything organic gets
    draw.rectangle(TRACK, fill=RUBBER)
    bars(draw, TRACK, RUBBER_HI, 9, 3.0, horizontal=True)
    speckle(draw, rnd, TRACK, 120, (RUBBER_HI, (18, 18, 20)), size=(1, 2))

    # seat — vinyl with a stitched centre seam
    flat(draw, SEAT, VINYL, VINYL_HI, (20, 20, 24))
    x0, y0, x1, y1 = SEAT
    draw.rectangle((x0, (y0 + y1) // 2 - 1, x1 - 1, (y0 + y1) // 2 + 1), fill=VINYL_HI)
    bars(draw, SEAT, (52, 52, 58), 14, 1.0, horizontal=False)

    # ski — scuffed plastic, streaked along its length by the snow it rides on
    flat(draw, SKI, SKI_GREY, SKI_HI, (30, 32, 38))
    stripes(draw, SKI, SKI_HI, 14, horizontal=True, width=(0.8, 2.0), rnd=rnd)

    # metal — brushed, for handlebars and spindles
    draw.rectangle(METAL, fill=STEEL)
    stripes(draw, METAL, STEEL_LO, 20, horizontal=True, width=(0.6, 1.8), rnd=rnd)
    stripes(draw, METAL, STEEL_HI, 9, horizontal=True, width=(0.5, 1.2), rnd=rnd)

    # windshield — smoked, with a diagonal sheen. Not transparent: the alpha channel would need the
    # importer's blend flag, and a dark opaque pane reads correctly at this scale anyway.
    draw.rectangle(GLASS, fill=SMOKE)
    x0, y0, x1, y1 = GLASS
    draw.polygon([(x0, y1 - 14), (x1 - 1, y0 + 6), (x1 - 1, y0 + 20), (x0, y1 - 1)], fill=SMOKE_HI)

    # headlight
    draw.rectangle(LIGHT, fill=PLASTIC)
    cx, cy = (LIGHT[0] + LIGHT[2]) // 2, (LIGHT[1] + LIGHT[3]) // 2
    draw.ellipse((cx - 22, cy - 15, cx + 22, cy + 15), fill=LENS)
    draw.ellipse((cx - 13, cy - 9, cx + 6, cy + 3), fill=LENS_HI)

    # tunnel — bare aluminium, brushed lengthwise
    draw.rectangle(TUNNEL, fill=ALU)
    stripes(draw, TUNNEL, STEEL_LO, 16, horizontal=True, width=(0.7, 2.0), rnd=rnd)
    speckle(draw, rnd, TUNNEL, 60, (STEEL_HI, STEEL_LO), size=(1, 1))

    # vent / grille slats
    draw.rectangle(VENT, fill=(30, 30, 34))
    bars(draw, VENT, PLASTIC_HI, 7, 4.0, horizontal=True)

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
