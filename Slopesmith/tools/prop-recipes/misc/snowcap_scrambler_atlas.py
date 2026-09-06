"""Paint the Snowcap Scrambler's one small carnival trim sheet.

128x128 RGBA, a 4x4 grid of 32px panels. The page behaves as a trim sheet rather than a unique
unwrap: all three cars share their construction and take identity from one accent cell apiece, while
the platform, arms, mast and base repeatedly sample the same handful of metal panels.

    [0][0] deck blue     [0][1] bulb trim      [0][2] steel         [0][3] dark rubber
    [1][0] cyan car      [1][1] orange car     [1][2] magenta car   [1][3] seat vinyl
    [2][0] snow          [2][1] warm light     [2][2] hazard stripe [2][3] icy glass
    [3][*] dark spare / palette safety

`_lib.panels(4, 4)` describes the same grid in UV space.

    python Slopesmith/tools/prop-recipes/misc/snowcap_scrambler_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, panels, speckle, stripes   # noqa: E402

SIZE = 128
OUT = os.path.join(ROOT, 'build', 'snowcap_scrambler.png')
GRID = panels(SIZE, 4, 4)
DECK, TRIM, METAL, DARK = GRID[0]
CYAN, ORANGE, MAGENTA, SEAT = GRID[1]
SNOW, LIGHT, HAZARD, GLASS = GRID[2]

rnd = random.Random(260729)


def painted(draw, rect, base, hi, lo, slash=None):
    """A 32px paint cell with enough large-value structure to survive PS2 sampling."""
    x0, y0, x1, y1 = rect
    draw.rectangle(rect, fill=base)
    draw.rectangle((x0, y0, x1 - 1, y0 + 3), fill=hi)
    draw.rectangle((x0, y1 - 5, x1 - 1, y1 - 1), fill=lo)
    if slash:
        draw.polygon([(x0 + 3, y1 - 8), (x0 + 7, y1 - 4),
                      (x1 - 3, y0 + 8), (x1 - 7, y0 + 4)], fill=slash)
    speckle(draw, rnd, rect, 12, (hi, lo), size=(1, 1))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img, draw = new_atlas(SIZE)
    draw.rectangle((0, 0, SIZE, SIZE), fill=(29, 31, 39, 255))

    painted(draw, DECK, (42, 91, 126), (75, 135, 170), (25, 58, 82))

    # One repeating painted ring does the work a second scrolling page would have done. As the platform
    # rotates, this visibly travels past the stationary base and centre mast.
    draw.rectangle(TRIM, fill=(24, 35, 55))
    x0, y0, x1, y1 = TRIM
    for i, colour in enumerate(((248, 210, 88), (79, 220, 229), (245, 94, 156), (248, 151, 68))):
        cx = x0 + 4 + i * 8
        draw.ellipse((cx - 2, (y0 + y1) // 2 - 2, cx + 2, (y0 + y1) // 2 + 2), fill=colour)
        draw.point((cx - 1, (y0 + y1) // 2 - 1), fill=(255, 251, 220))

    draw.rectangle(METAL, fill=(132, 142, 153))
    stripes(draw, METAL, (188, 197, 204), 7, horizontal=True, width=(0.6, 1.2), rnd=rnd)
    stripes(draw, METAL, (84, 93, 104), 6, horizontal=True, width=(0.6, 1.2), rnd=rnd)
    speckle(draw, rnd, METAL, 16, ((208, 214, 219), (72, 80, 90)), size=(1, 1))

    painted(draw, DARK, (34, 36, 43), (66, 70, 80), (19, 20, 25))

    # The white slash breaks the round tub's rotational symmetry. It is intentionally broad: a tiny
    # number or logo would disappear on a 32px cell, while this reads from across the course.
    painted(draw, CYAN, (34, 171, 184), (82, 222, 224), (18, 102, 118), slash=(232, 245, 239))
    painted(draw, ORANGE, (219, 112, 42), (250, 166, 70), (145, 61, 27), slash=(250, 242, 219))
    painted(draw, MAGENTA, (196, 52, 125), (238, 100, 169), (121, 28, 77), slash=(245, 235, 244))

    draw.rectangle(SEAT, fill=(43, 38, 54))
    x0, y0, x1, y1 = SEAT
    draw.rectangle((x0, y0 + 3, x1 - 1, y0 + 6), fill=(91, 80, 108))
    draw.line((x0 + 4, y0 + 2, x0 + 4, y1 - 3), fill=(113, 98, 129), width=1)
    draw.line((x1 - 5, y0 + 2, x1 - 5, y1 - 3), fill=(25, 23, 31), width=1)

    draw.rectangle(SNOW, fill=(231, 239, 246))
    speckle(draw, rnd, SNOW, 22, ((252, 253, 255), (180, 204, 222)), size=(1, 2))

    draw.rectangle(LIGHT, fill=(232, 194, 77))
    x0, y0, x1, y1 = LIGHT
    draw.ellipse((x0 + 5, y0 + 5, x1 - 5, y1 - 5), fill=(255, 238, 153))
    draw.ellipse((x0 + 9, y0 + 8, x1 - 11, y1 - 12), fill=(255, 252, 220))

    draw.rectangle(HAZARD, fill=(236, 190, 52))
    x0, y0, x1, y1 = HAZARD
    for k in range(-2, 5):
        draw.polygon([(x0 + k * 12, y0), (x0 + k * 12 + 5, y0),
                      (x0 + k * 12 - 11, y1), (x0 + k * 12 - 16, y1)], fill=(38, 40, 46))

    draw.rectangle(GLASS, fill=(69, 105, 128))
    x0, y0, x1, y1 = GLASS
    draw.polygon([(x0 + 2, y1 - 7), (x1 - 3, y0 + 4),
                  (x1 - 3, y0 + 11), (x0 + 2, y1 - 1)], fill=(141, 191, 210))

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
