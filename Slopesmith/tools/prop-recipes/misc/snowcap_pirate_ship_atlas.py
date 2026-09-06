"""Paint the Snowcap Pirate Ship's 128x128 carnival trim sheet.

The 4x4 grid keeps the big reads broad enough for PS2 filtering: navy/red hull paint, warm timber,
blue steel supports, gold trim and one square skull medallion used by the two side plaques.

    python Slopesmith/tools/prop-recipes/misc/snowcap_pirate_ship_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, panels, speckle, stripes   # noqa: E402

SIZE = 128
OUT = os.path.join(ROOT, 'build', 'snowcap_pirate_ship.png')
GRID = panels(SIZE, 4, 4)
HULL, RED, WOOD, STEEL = GRID[0]
GOLD, DECK, SEAT, ROPE = GRID[1]
SNOW, LIGHT, SKULL, DARK = GRID[2]
SUPPORT, HAZARD, FLAG, SPARE = GRID[3]

rnd = random.Random(260802)


def painted(draw, rect, base, hi, lo):
    x0, y0, x1, y1 = rect
    draw.rectangle(rect, fill=base)
    draw.rectangle((x0, y0, x1 - 1, y0 + 3), fill=hi)
    draw.rectangle((x0, y1 - 5, x1 - 1, y1 - 1), fill=lo)
    speckle(draw, rnd, rect, 15, (hi, lo), size=(1, 1))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img, draw = new_atlas(SIZE)
    draw.rectangle((0, 0, SIZE, SIZE), fill=(24, 27, 36, 255))

    painted(draw, HULL, (25, 54, 83), (50, 92, 126), (13, 29, 48))
    painted(draw, RED, (154, 39, 48), (213, 69, 64), (91, 21, 31))

    draw.rectangle(WOOD, fill=(111, 67, 38))
    stripes(draw, WOOD, (164, 105, 56), 7, horizontal=True, width=(0.7, 1.2), rnd=rnd)
    stripes(draw, WOOD, (66, 39, 28), 4, horizontal=True, width=(0.7, 1.1), rnd=rnd)
    speckle(draw, rnd, WOOD, 18, ((186, 128, 68), (57, 35, 27)), size=(1, 1))

    painted(draw, STEEL, (112, 124, 138), (184, 194, 201), (64, 72, 84))
    painted(draw, GOLD, (203, 151, 41), (251, 213, 91), (122, 76, 24))

    draw.rectangle(DECK, fill=(128, 82, 46))
    x0, y0, x1, y1 = DECK
    for y in range(y0 + 4, y1, 7):
        draw.line((x0, y, x1 - 1, y), fill=(67, 43, 31), width=1)
    for y in range(y0 + 5, y1, 7):
        draw.line((x0, y, x1 - 1, y), fill=(177, 120, 64), width=1)

    painted(draw, SEAT, (71, 30, 38), (119, 52, 57), (35, 18, 25))
    draw.rectangle(ROPE, fill=(137, 103, 63))
    x0, y0, x1, y1 = ROPE
    for k in range(-4, 8):
        draw.line((x0 + k * 6, y1, x0 + k * 6 + 20, y0), fill=(218, 185, 119), width=2)
        draw.line((x0 + k * 6 + 3, y1, x0 + k * 6 + 23, y0), fill=(81, 57, 38), width=1)

    draw.rectangle(SNOW, fill=(229, 239, 247))
    speckle(draw, rnd, SNOW, 24, ((253, 254, 255), (176, 201, 220)), size=(1, 2))

    draw.rectangle(LIGHT, fill=(44, 39, 48))
    x0, y0, x1, y1 = LIGHT
    for y in (y0 + 8, y0 + 23):
        for x in (x0 + 7, x0 + 16, x0 + 25):
            draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(242, 186, 67))
            draw.ellipse((x - 1, y - 2, x + 1, y), fill=(255, 248, 199))

    # A deliberately chunky skull: eye sockets and crossed bones survive even when the cell is a few pixels.
    draw.rectangle(SKULL, fill=(28, 35, 52))
    x0, y0, x1, y1 = SKULL
    bone = (232, 224, 190)
    draw.line((x0 + 6, y1 - 5, x1 - 6, y0 + 5), fill=bone, width=4)
    draw.line((x0 + 6, y0 + 5, x1 - 6, y1 - 5), fill=bone, width=4)
    draw.ellipse((x0 + 7, y0 + 4, x1 - 7, y1 - 9), fill=bone)
    draw.rectangle((x0 + 11, y0 + 17, x1 - 11, y0 + 25), fill=bone)
    draw.ellipse((x0 + 11, y0 + 11, x0 + 16, y0 + 17), fill=(35, 38, 47))
    draw.ellipse((x1 - 16, y0 + 11, x1 - 11, y0 + 17), fill=(35, 38, 47))
    draw.polygon([(x0 + 16, y0 + 17), (x0 + 13, y0 + 21), (x0 + 19, y0 + 21)], fill=(35, 38, 47))

    painted(draw, DARK, (30, 32, 39), (58, 63, 73), (16, 17, 22))
    painted(draw, SUPPORT, (43, 87, 117), (75, 132, 162), (23, 49, 72))

    draw.rectangle(HAZARD, fill=(226, 177, 47))
    x0, y0, x1, y1 = HAZARD
    for k in range(-2, 5):
        draw.polygon([(x0 + k * 12, y0), (x0 + k * 12 + 5, y0),
                      (x0 + k * 12 - 11, y1), (x0 + k * 12 - 16, y1)], fill=(36, 38, 44))

    draw.rectangle(FLAG, fill=(116, 25, 38))
    x0, y0, x1, y1 = FLAG
    draw.polygon([(x0 + 3, y0 + 4), (x1 - 3, y0 + 9), (x0 + 3, y1 - 4)], fill=(202, 47, 58))
    draw.line((x0 + 5, y0 + 6, x1 - 6, y0 + 10), fill=(244, 112, 89), width=2)
    painted(draw, SPARE, (27, 31, 41), (46, 51, 65), (17, 19, 26))

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
