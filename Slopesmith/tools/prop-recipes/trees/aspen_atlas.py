"""
Paint the aspen atlas — pale scarred bark, plus an ALPHA-CUTOUT sheet of fine bare twig sprays.

An aspen is read from its TRUNK, not its crown. The crown is a narrow oval confined to the top third
and mostly sky; what you actually recognise is a straight chalk-white column marked with black scars.
So the bark cell carries this prop, which is the reverse of every conifer here.

Against the birch, which is the other white-trunked tree in the library:

    birch    fine HORIZONTAL lenticel dashes, evenly peppered, warm white
    aspen    heavy BLACK knots and chevrons, sparse and irregular, cool green-white, dark rough base

Those are genuinely different marks, and at trunk scale they are the whole difference between the two
props. Painting an aspen with lenticels just makes a second birch.

256x256 RGBA, a 2x4 grid of 128x64 cells:

    [0][0] twig spray A (long)        [0][1] twig spray B (long, snowy)
    [1][0] spray C (medium)           [1][1] spray D (medium, sparse)
    [2][0] spray E (short)            [2][1] spray F (tip)
    [3][0] aspen bark                 [3][1] dark base bark

Twigs ASCEND here — aspen branches sweep steeply up, unlike the birch's weeping. Each spray is drawn
left-to-right rising, so the card's UV maps inner->outer with no per-card decisions.

    python Slopesmith/tools/prop-recipes/trees/aspen_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, panels, scatter_blobs, speckle   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'aspen.png')

GRID = panels(SIZE, 2, 4)
SPRAYS = [GRID[0][0], GRID[0][1], GRID[1][0], GRID[1][1], GRID[2][0], GRID[2][1]]
BARK, BASE = GRID[3][0], GRID[3][1]

TWIG = (96, 84, 70)
TWIG_LIT = (146, 132, 112)
TWIG_DARK = (58, 50, 42)
BUD = (122, 96, 74)
FROST = (238, 244, 248)
FROST_SHADE = (204, 216, 226)
BARK_PALE = (226, 228, 214)          # cool, faintly green — not the birch's warm white
BARK_GREEN = (204, 210, 184)
BARK_GREY = (172, 176, 162)
BARK_BLACK = (38, 36, 32)
BASE_DARK = (72, 68, 60)
BASE_MID = (108, 104, 92)

rnd = random.Random(31337)


def spray(draw, cell, climb=0.34, density=3, snow=0.35, reach=0.95, drop=0.30, buds=0.30):
    """One ascending twig spray, drawn left-to-right across its cell.

    `climb` lifts the branch over its length and the twigs go up off it, which is what separates this
    from `birch_atlas.spray` — the same fine winter twigs, hung the opposite way.
    """
    x0, y0, x1, y1 = cell
    w, h = x1 - x0, y1 - y0
    span = int(w * reach)
    stem_y = y0 + h * (1.0 - drop)                   # the branch starts LOW and climbs

    def stem(t):
        return (x0 + 1 + t * span, stem_y - climb * h * (t ** 1.3))

    def spread(t):
        return h * 0.40 * (1.0 - 0.30 * t)

    for k in range(0, span, 3):
        if rnd.random() > 0.72:
            continue
        t = k / max(span - 1, 1)
        sx, sy = stem(t)
        reach_k = spread(t)
        for _ in range(density):
            length = reach_k * rnd.uniform(0.35, 1.05)
            forward = length * rnd.uniform(0.25, 0.75)
            side = -1 if rnd.random() < 0.80 else 1      # up, with the occasional one crossing down
            colour = rnd.choice((TWIG, TWIG, TWIG_LIT, TWIG_DARK))
            ex, ey = sx + forward, sy + side * length
            draw.line([(sx, sy), (ex, ey)], fill=colour + (255,), width=1)
            if rnd.random() < buds:                      # a fat winter bud at the tip
                draw.point((ex, ey), fill=BUD + (255,))
            if rnd.random() < 0.55:                      # one order of subdivision, for fineness
                mx, my = sx + (ex - sx) * 0.5, sy + (ey - sy) * 0.5
                draw.line([(mx, my), (mx + forward * rnd.uniform(0.2, 0.6),
                                      my + side * length * rnd.uniform(0.2, 0.5))],
                          fill=colour + (255,), width=1)

    for k in range(span):                                # the branch itself
        t = k / max(span - 1, 1)
        sx, sy = stem(t)
        draw.line([(sx, sy), (sx + 1.5, sy)], fill=TWIG + (255,), width=2 if t < 0.25 else 1)

    for k in range(0, span, 2):                          # snow on the upper side
        t = k / max(span - 1, 1)
        if rnd.random() > snow * (1.0 - 0.5 * t):
            continue
        sx, sy = stem(t)
        r = rnd.uniform(1.2, 2.8) * (1.0 - 0.3 * t)
        shade = FROST if rnd.random() < 0.7 else FROST_SHADE
        draw.ellipse((sx - r, sy - r * 1.05, sx + r, sy + r * 0.35), fill=shade + (255,))


def paint_bark(draw):
    """The prop's real subject: chalk-pale, faintly green, marked with heavy black scars."""
    x0, y0, x1, y1 = BARK
    draw.rectangle(BARK, fill=BARK_PALE + (255,))
    for _ in range(6):                                   # soft vertical tonal banding
        w = rnd.uniform(10, 26)
        x = rnd.uniform(x0, x1 - 1 - w)
        draw.rectangle((x, y0, x + w, y1 - 1),
                       fill=(BARK_GREEN if rnd.random() < 0.65 else BARK_GREY) + (255,))
    # Black branch scars — an aspen's eyes. Drawn about 20x WIDER than tall, which is what a round mark
    # on the trunk looks like in this cell: 128 px spans one 0.13 m face at ~0.1 cm/px, while 64 px
    # spans a 1.3 m segment at ~2 cm/px. Draw an eye that looks like an eye on the page and the trunk
    # gets a tall black smear. Two per panel, because the panel repeats 30 times over the trunk.
    for _ in range(2):
        cx = rnd.uniform(x0 + 36, x1 - 37)
        cy = rnd.uniform(y0 + 10, y1 - 11)
        rx, ry = rnd.uniform(22, 36), rnd.uniform(1.6, 2.6)
        draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=BARK_BLACK + (255,))
        draw.arc((cx - rx * 1.25, cy - ry * 5.0, cx + rx * 1.25, cy + ry * 2.0), 200, 340,
                 fill=BARK_BLACK + (255,), width=2)       # the chevron over the eye
    for _ in range(5):                                    # smaller knots and healed stubs
        cx, cy = rnd.uniform(x0 + 8, x1 - 9), rnd.uniform(y0 + 4, y1 - 5)
        r = rnd.uniform(5.0, 13.0)
        draw.ellipse((cx - r, cy - 1.2, cx + r, cy + 1.2), fill=BARK_BLACK + (255,))
    speckle(draw, rnd, BARK, 60, (BARK_GREY + (255,), BARK_GREEN + (255,)), size=(1, 2))


def paint_base(draw):
    """Rough dark bark for the bottom of the trunk, where an old aspen goes furrowed and grey."""
    x0, y0, x1, y1 = BASE
    draw.rectangle(BASE, fill=BASE_MID + (255,))
    for _ in range(7):
        w = rnd.uniform(6, 15)
        x = rnd.uniform(x0, x1 - 1 - w)
        draw.rectangle((x, y0, x + w, y1 - 1), fill=BASE_DARK + (255,))
        draw.rectangle((x + w, y0, x + w + rnd.uniform(2, 4), y1 - 1), fill=BARK_GREY + (255,))
    draw.rectangle((x0, y0, x1 - 1, y0 + 4), fill=BARK_GREY + (255,))   # fades into the pale bark above
    scatter_blobs(draw, rnd, BASE, 4, BASE_DARK + (255,), (3.0, 6.0))
    speckle(draw, rnd, BASE, 70, (BASE_DARK + (255,), BARK_GREY + (255,)), size=(1, 2))


STYLE = [
    dict(climb=0.34, density=3, snow=0.32, reach=0.97, buds=0.30),
    dict(climb=0.40, density=3, snow=0.58, reach=0.95, buds=0.22),
    dict(climb=0.30, density=3, snow=0.30, reach=0.86, buds=0.34),
    dict(climb=0.38, density=2, snow=0.24, reach=0.88, buds=0.26),
    dict(climb=0.26, density=3, snow=0.34, reach=0.70, buds=0.36),
    dict(climb=0.20, density=2, snow=0.28, reach=0.56, buds=0.30),
]


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # transparent, but already twig-coloured: a transparent-BLACK page bleeds dark fringes into every
    # cutout edge through the mip chain, because alpha is tested after filtering
    img, draw = new_atlas(SIZE, bg=TWIG + (0,))
    for cell, style in zip(SPRAYS, STYLE):
        spray(draw, cell, **style)
    paint_bark(draw)
    paint_base(draw)
    img.save(OUT)

    px = img.load()
    holes = sum(1 for y in range(SIZE) for x in range(SIZE) if px[x, y][3] < 16)
    print(f'wrote {OUT} {img.size} {img.mode}')
    print(f'  {100 * holes / (SIZE * SIZE):.1f}% fully transparent (a bare winter crown runs well above '
          f"the 55-60% a foliated page runs)")
    img.resize((SIZE * 3, SIZE * 3), 0).save(OUT.replace('.png', '_3x.png'))


if __name__ == '__main__':
    main()
