"""Paint the Snowcap Screamer's coaster-train trim sheet.

128x128 RGBA, a 4x4 grid of 32px panels. Three cars share one page and take their identity from
paintwork rather than geometry, the way the Scrambler's tubs do.

    [0][0] flank crimson   [0][1] perimeter band  [0][2] steel        [0][3] tyre rubber
    [1][0] seat vinyl      [1][1] chrome          [1][2] snow crust   [1][3] lamp
    [2][0] flank cream     [2][1] hazard          [2][2] grille       [2][3] dark spare
    [3][*] dark spare / palette safety

`_lib.panels(4, 4)` describes the same grid in UV space.

The flank cells are the ones that matter. `extrude_profile` puts the car's SIDE silhouette on its two
cap faces, so those two panels carry almost all the art anyone will read at speed, and the perimeter
band is only the thin strip running over the nose, roof and tail. A coaster car is seen broadside from
the course below, so the chevron is drawn big enough to survive both the 32px cell and PS2 sampling.

    python Slopesmith/tools/prop-recipes/misc/snowcap_screamer_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import bars, hazard, new_atlas, panels, speckle, stripes   # noqa: E402

SIZE = 128
OUT = os.path.join(ROOT, 'build', 'snowcap_screamer.png')
GRID = panels(SIZE, 4, 4)
FLANK, BAND, STEEL, RUBBER = GRID[0]
SEAT, CHROME, SNOW, LAMP = GRID[1]
CREAM, HAZARD, GRILLE, DARK = GRID[2]

rnd = random.Random(511903)


def plate(draw, rect, base, hi, lo):
    """A painted panel with its highlight along the TOP edge and shade along the bottom.

    The car's flank is a cap face, and `extrude_profile` maps V to profile height there, so a band
    drawn across the top of the cell lands along the top of the car whichever way the profile was
    typed in. Vertical banding would not survive the same way: U is the profile's own Y extent.
    """
    x0, y0, x1, y1 = rect
    draw.rectangle(rect, fill=base)
    draw.rectangle((x0, y0, x1 - 1, y0 + 3), fill=hi)
    draw.rectangle((x0, y1 - 4, x1 - 1, y1 - 1), fill=lo)
    speckle(draw, rnd, rect, 10, (hi, lo), size=(1, 1))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img, draw = new_atlas(SIZE)
    draw.rectangle((0, 0, SIZE, SIZE), fill=(27, 29, 36, 255))

    # The flank. One broad chevron pointing at the nose: at 32px a number or a logo dissolves, while a
    # shape this size still reads as "which way is this thing going" from across the course.
    plate(draw, FLANK, (176, 44, 52), (222, 92, 88), (104, 22, 30))
    x0, y0, x1, y1 = FLANK
    draw.polygon([(x0 + 6, y0 + 8), (x0 + 14, y0 + 8), (x1 - 6, (y0 + y1) // 2),
                  (x0 + 14, y1 - 8), (x0 + 6, y1 - 8), (x1 - 14, (y0 + y1) // 2)],
                 fill=(247, 238, 214))
    draw.rectangle((x0, y1 - 7, x1 - 1, y1 - 5), fill=(38, 40, 48))

    plate(draw, CREAM, (226, 214, 186), (247, 241, 224), (162, 149, 126))
    x0, y0, x1, y1 = CREAM
    draw.polygon([(x0 + 6, y0 + 9), (x0 + 13, y0 + 9), (x1 - 7, (y0 + y1) // 2),
                  (x0 + 13, y1 - 9), (x0 + 6, y1 - 9), (x1 - 14, (y0 + y1) // 2)],
                 fill=(176, 44, 52))
    draw.rectangle((x0, y1 - 7, x1 - 1, y1 - 5), fill=(38, 40, 48))

    # The perimeter band wraps nose, roof, belly and tail in one continuous run of U, so it is drawn
    # uniform along U and shaded across V. Anything with structure along U would march over the crest.
    draw.rectangle(BAND, fill=(126, 30, 38))
    x0, y0, x1, y1 = BAND
    draw.rectangle((x0, y0 + 11, x1 - 1, y0 + 14), fill=(243, 233, 208))
    draw.rectangle((x0, y0 + 18, x1 - 1, y0 + 20), fill=(74, 18, 24))
    speckle(draw, rnd, BAND, 12, ((214, 96, 92), (68, 16, 22)), size=(1, 1))

    draw.rectangle(STEEL, fill=(134, 143, 154))
    stripes(draw, STEEL, (189, 198, 205), 7, horizontal=True, width=(0.6, 1.2), rnd=rnd)
    stripes(draw, STEEL, (85, 94, 105), 6, horizontal=True, width=(0.6, 1.2), rnd=rnd)
    speckle(draw, rnd, STEEL, 16, ((209, 215, 220), (73, 81, 91)), size=(1, 1))

    # A wheel is a tube swept along X, and `band_uv` gives every one of its five faces the whole cell:
    # U runs around the circumference, V along the axle. So a tread block is a VERTICAL bar here —
    # constant U, spanning V — and it repeats five times around the tyre. Horizontal bars would be
    # constant V instead and come out as rings around the sidewall, which is a different tyre.
    draw.rectangle(RUBBER, fill=(38, 38, 44))
    bars(draw, RUBBER, (62, 63, 72), 4, 3, horizontal=False)
    speckle(draw, rnd, RUBBER, 12, ((24, 24, 29), (72, 73, 82)), size=(1, 1))

    draw.rectangle(SEAT, fill=(40, 36, 50))
    x0, y0, x1, y1 = SEAT
    draw.rectangle((x0, y0 + 4, x1 - 1, y0 + 7), fill=(88, 78, 104))
    draw.line((x0 + 5, y0 + 3, x0 + 5, y1 - 4), fill=(110, 96, 126), width=1)
    draw.line((x1 - 6, y0 + 3, x1 - 6, y1 - 4), fill=(23, 21, 29), width=1)

    draw.rectangle(CHROME, fill=(178, 186, 196))
    stripes(draw, CHROME, (233, 239, 244), 5, horizontal=True, width=(1.0, 2.0), rnd=rnd)
    stripes(draw, CHROME, (108, 116, 128), 4, horizontal=True, width=(0.8, 1.6), rnd=rnd)

    draw.rectangle(SNOW, fill=(232, 240, 247))
    speckle(draw, rnd, SNOW, 22, ((252, 253, 255), (181, 205, 223)), size=(1, 2))

    draw.rectangle(LAMP, fill=(233, 196, 80))
    x0, y0, x1, y1 = LAMP
    draw.ellipse((x0 + 5, y0 + 5, x1 - 5, y1 - 5), fill=(255, 239, 156))
    draw.ellipse((x0 + 9, y0 + 8, x1 - 11, y1 - 12), fill=(255, 252, 222))

    draw.rectangle(HAZARD, fill=(237, 191, 54))
    hazard(draw, HAZARD, (38, 40, 46))

    draw.rectangle(GRILLE, fill=(50, 52, 60))
    x0, y0, x1, y1 = GRILLE
    for k in range(5):
        y = y0 + 4 + k * 5
        draw.rectangle((x0 + 3, y, x1 - 4, y + 2), fill=(150, 158, 168))

    plate(draw, DARK, (33, 35, 42), (64, 68, 78), (18, 19, 24))

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
