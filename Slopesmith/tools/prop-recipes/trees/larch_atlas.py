"""
Paint the larch atlas — an ALPHA-CUTOUT sheet of BARE winter branchlets, plus fissured bark.

A larch is the deciduous conifer: whorled and conical like a spruce, but it drops its needles, so in
winter it is a bare gold-brown frame you can see straight through. That is a silhouette the rest of the
library does not have — every other conifer here is a solid mass of foliage.

Two marks carry the species:

- **Pendulous branchlets.** Fine shoots hanging nearly straight down off a level primary branch, dense
  and even — closer to a bottle brush than to the clumped weeping of a birch.
- **Spur shoots.** Larch grows its needle tufts from short knobbly spurs that stay on the branch all
  winter, so a bare larch twig is beaded with small dark knobs along its whole length. Nothing else in
  the family looks like this, and at 128 px a bead is 2 pixels.

256x256 RGBA, a 2x4 grid of 128x64 cells:

    [0][0] branchlet spray A (long)       [0][1] branchlet spray B (long, snowy)
    [1][0] spray C (medium)               [1][1] spray D (medium, sparse)
    [2][0] spray E (short)                [2][1] spray F (tip)
    [3][0] larch bark                     [3][1] snow clump

Bark fissures are FEW and WIDE. The panel is stretched around one trunk face — roughly 0.09 cm per
pixel across against 2 cm per pixel up — so a 2 px fissure lands as a 0.2 mm hairline and vanishes,
while a 10 px one lands near a centimetre and reads. Detail has to be coarse in the horizontal
direction to survive at all.

    python Slopesmith/tools/prop-recipes/larch_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, panels, scatter_blobs, speckle   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'larch.png')

GRID = panels(SIZE, 2, 4)
SPRAYS = [GRID[0][0], GRID[0][1], GRID[1][0], GRID[1][1], GRID[2][0], GRID[2][1]]
BARK, CLUMP = GRID[3][0], GRID[3][1]

TWIG = (126, 100, 74)
TWIG_LIT = (164, 136, 104)
TWIG_DARK = (78, 60, 46)
SPUR = (94, 70, 50)
BARK_BASE = (134, 104, 82)          # larch bark is warm, pink-brown under the grey
BARK_FISSURE = (70, 52, 40)
BARK_LIT = (172, 142, 116)
BARK_LICHEN = (112, 120, 88)
FROST = (238, 244, 248)
FROST_SHADE = (202, 216, 226)

rnd = random.Random(2718281)


def spray(draw, cell, droop=0.30, density=4, snow=0.40, reach=0.95, lift=0.26, spurs=0.55):
    """One bare larch branch, drawn left-to-right across its cell.

    The primary runs nearly level — a larch's branches are horizontal, not swept — and the branchlets
    hang from it almost vertically with only a little forward lean. Their length falls off toward the
    tip, which is what gives the branch a tapered profile rather than a rectangular one.
    """
    x0, y0, x1, y1 = cell
    w, h = x1 - x0, y1 - y0
    span = int(w * reach)
    stem_y = y0 + h * lift

    def stem(t):
        return (x0 + 1 + t * span, stem_y + droop * h * (t ** 2.0))

    def hang(t):
        return h * 0.46 * (1.0 - 0.55 * t)

    # Branchlets, evenly spaced on purpose — larch is tidy where a birch clumps. Kept SPARSE: this is a
    # bare tree, and its whole point in the library is that you can see the mountain through it. Packed
    # any tighter the strokes merge into a solid brown curtain and it reads as a hanging mat.
    for k in range(0, span, 4):
        t = k / max(span - 1, 1)
        sx, sy = stem(t)
        for _ in range(density):
            length = hang(t) * rnd.uniform(0.30, 1.00)
            lean = length * rnd.uniform(0.05, 0.30)          # only a little forward; they fall
            colour = rnd.choice((TWIG, TWIG, TWIG_LIT, TWIG_DARK))
            draw.line([(sx + rnd.uniform(-1.5, 1.5), sy), (sx + lean, sy + length)],
                      fill=colour + (255,), width=1)

    # the primary, pale on its lit upper edge
    for k in range(span):
        t = k / max(span - 1, 1)
        sx, sy = stem(t)
        draw.line([(sx, sy), (sx + 1.5, sy)], fill=TWIG + (255,), width=2 if t < 0.30 else 1)
        if t < 0.60:
            draw.point((sx, sy - 1), fill=TWIG_LIT + (255,))

    # spur shoots — the beading that says larch and nothing else
    for k in range(0, span, 3):
        if rnd.random() > spurs:
            continue
        t = k / max(span - 1, 1)
        sx, sy = stem(t)
        r = rnd.uniform(0.8, 1.7)
        draw.ellipse((sx - r, sy - r, sx + r, sy + r), fill=SPUR + (255,))

    # snow caught along the top of the primary, where a level branch actually holds it
    for k in range(0, span, 2):
        t = k / max(span - 1, 1)
        if rnd.random() > snow * (1.0 - 0.45 * t):
            continue
        sx, sy = stem(t)
        r = rnd.uniform(1.3, 3.0) * (1.0 - 0.30 * t)
        shade = FROST if rnd.random() < 0.72 else FROST_SHADE
        draw.ellipse((sx - r, sy - r * 1.1, sx + r, sy + r * 0.3), fill=shade + (255,))


def paint_bark(draw):
    """Warm fissured bark. FEW, WIDE fissures — see the module docstring on the cell's anisotropy."""
    x0, y0, x1, y1 = BARK
    h = y1 - y0
    draw.rectangle(BARK, fill=BARK_BASE + (255,))
    # Each fissure runs in BROKEN vertical chunks rather than one full-height bar. Jittering a crack
    # sideways is wasted here — a few pixels across is well under a millimetre on the trunk — so the
    # only irregularity that survives is along the height: present here, closed there.
    for _ in range(5):
        w = rnd.uniform(7, 14)
        x = rnd.uniform(x0 + 2, x1 - 3 - w)
        y = y0
        while y < y1 - 4:
            run = rnd.uniform(h * 0.18, h * 0.45)
            draw.rectangle((x, y, x + w, min(y + run, y1 - 1)), fill=BARK_FISSURE + (255,))
            draw.rectangle((x + w, y, x + w + rnd.uniform(2, 4), min(y + run, y1 - 1)),
                           fill=BARK_LIT + (255,))
            y += run + rnd.uniform(h * 0.08, h * 0.22)      # a closed stretch between chunks
    for _ in range(3):                                      # partial plates, never full width
        y = rnd.uniform(y0 + 6, y1 - 8)
        xa = rnd.uniform(x0, x1 - 40)
        draw.rectangle((xa, y, xa + rnd.uniform(18, 46), y + rnd.uniform(1.5, 3.0)),
                       fill=BARK_LIT + (255,))
    scatter_blobs(draw, rnd, BARK, 4, BARK_LICHEN + (255,), (3.0, 6.0))
    speckle(draw, rnd, BARK, 70, (BARK_LIT + (255,), BARK_FISSURE + (255,)), size=(1, 2))


def paint_clump(draw):
    """Pure snow, for the crown cap."""
    draw.rectangle(CLUMP, fill=FROST + (255,))
    scatter_blobs(draw, rnd, CLUMP, 9, FROST_SHADE + (255,), (4.0, 10.0))
    speckle(draw, rnd, CLUMP, 70, (FROST_SHADE + (255,), (255, 255, 255, 255)), size=(1, 1))


STYLE = [
    dict(droop=0.26, density=2, snow=0.35, reach=0.97, spurs=0.60),
    dict(droop=0.34, density=2, snow=0.62, reach=0.95, spurs=0.50),
    dict(droop=0.24, density=2, snow=0.32, reach=0.85, spurs=0.62),
    dict(droop=0.32, density=1, snow=0.28, reach=0.87, spurs=0.45),
    dict(droop=0.20, density=2, snow=0.38, reach=0.70, spurs=0.58),
    dict(droop=0.16, density=1, snow=0.30, reach=0.55, spurs=0.50),
]


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # transparent, but already twig-coloured: a transparent-BLACK page bleeds dark fringes into every
    # cutout edge through the mip chain, because alpha is tested after filtering
    img, draw = new_atlas(SIZE, bg=TWIG + (0,))
    for cell, style in zip(SPRAYS, STYLE):
        spray(draw, cell, **style)
    paint_bark(draw)
    paint_clump(draw)
    img.save(OUT)

    px = img.load()
    holes = sum(1 for y in range(SIZE) for x in range(SIZE) if px[x, y][3] < 16)
    print(f'wrote {OUT} {img.size} {img.mode}')
    print(f'  {100 * holes / (SIZE * SIZE):.1f}% fully transparent (a bare tree runs higher than the '
          f'55-60% a foliated page runs)')
    img.resize((SIZE * 3, SIZE * 3), 0).save(OUT.replace('.png', '_3x.png'))


if __name__ == '__main__':
    main()
