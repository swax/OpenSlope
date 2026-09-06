"""
Paint the birch atlas — an ALPHA-CUTOUT sheet of snow-dusted twig sprays, plus the white bark panel.

A birch is recognised by two things and nothing else at this distance: white bark banded with dark
lenticels, and a fine weeping twig mass that reads as haze rather than as leaves. Both live here — the
geometry underneath is the same card scaffold the conifers use.

Twigs differ from conifer needles in the one way that matters to the eye. A conifer bough is a flat
spray whose needles rake BACKWARD toward the trunk; a birch twig sweeps FORWARD toward the tip and then
hangs. Drawing the strokes the wrong way round is what makes a birch look like a sickly pine.

256x256 RGBA, a 2x4 grid of 128x64 cells:

    [0][0] twig spray A (long, snowy)     [0][1] twig spray B (long, gold leaves)
    [1][0] twig spray C (medium, snowy)   [1][1] twig spray D (medium, sparse)
    [2][0] twig spray E (short)           [2][1] twig sprig F (tip)
    [3][0] birch bark                     [3][1] bare crown twigs

Each spray runs LEFT (where it meets the trunk) to RIGHT (the tip), so a card's UV maps inner->outer
along U with no per-card decisions. The stem is painted pale at the left and darkens toward the tip,
because a birch branch is white where it leaves the trunk and reddish-brown out at the twigs — that
gradient is most of what sells the species.

The bark panel is stretched around ONE trunk face and up ONE segment, which is a very anisotropic cell:
about 0.09 cm per pixel across and 2 cm per pixel up. So it carries horizontal marks only. Lenticels
are horizontal on a real birch anyway, and vertical detail would land as unreadable hairlines. Its top
and bottom rows are kept clear, because the panel repeats once per trunk segment and any mark touching
an edge becomes a ring at every seam.

    python Slopesmith/tools/prop-recipes/birch_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, panels, scatter_blobs, speckle   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'birch.png')

GRID = panels(SIZE, 2, 4)
SPRAYS = [GRID[0][0], GRID[0][1], GRID[1][0], GRID[1][1], GRID[2][0], GRID[2][1]]
BARK, CROWN = GRID[3][0], GRID[3][1]

TWIG = (78, 62, 52)
TWIG_LIT = (120, 100, 84)
TWIG_DARK = (46, 37, 32)
BRANCH_PALE = (214, 208, 196)      # a birch limb is near-white where it leaves the trunk
LEAF = (176, 182, 104)
LEAF_GOLD = (206, 176, 92)
LEAF_DEEP = (128, 138, 74)
FROST = (238, 244, 248)
FROST_SHADE = (202, 216, 226)
BARK_WHITE = (234, 232, 226)
BARK_CREAM = (212, 204, 190)
BARK_GREY = (166, 162, 154)
BARK_DARK = (48, 42, 38)

rnd = random.Random(1618033)


def spray(draw, cell, droop=0.50, density=3, snow=0.55, leaves=0.0, reach=0.95, lift=0.22):
    """One weeping twig spray, drawn left-to-right across its cell.

    `leaves` is the chance a twig carries leaves; at 0 the spray is bare winter twigs. `snow` is the
    chance of a frost dab along the upper edge. Both are per-cell, so one page carries the whole range
    from a bare sprig to a leafy one and a tree can mix them.

    Two things separate this from a conifer frond, and getting either wrong makes a sickly pine:

    - Twigs HANG. They leave the branch sweeping slightly forward and then fall, so the drop dominates
      the forward reach; a conifer's needles rake backward at a fixed angle and read as a herringbone.
    - Twigs CLUMP. Spacing them evenly along the branch gives a feather. Real ones come in bunches with
      bare stretches between, which is what makes the mass read as haze at distance.
    """
    x0, y0, x1, y1 = cell
    w, h = x1 - x0, y1 - y0
    span = int(w * reach)
    stem_y = y0 + h * lift                       # the branch rides high; the twigs hang below it

    def stem(t):
        return (x0 + 1 + t * span, stem_y + droop * h * (t ** 1.8))

    def half_height(t):
        return h * 0.42 * (1.0 - 0.35 * t)

    # twigs first, so snow lies on top of them
    for k in range(0, span, 3):
        if rnd.random() > 0.80:                             # bare stretch: twigs grow in bunches
            continue
        t = k / max(span - 1, 1)
        sx, sy = stem(t)
        reach_k = half_height(t)
        for _ in range(density):
            length = reach_k * rnd.uniform(0.30, 0.95)
            forward = length * rnd.uniform(0.15, 0.60)      # sweeps toward the tip, then falls
            drop = length * rnd.uniform(0.60, 1.35)
            side = 1 if rnd.random() < 0.88 else -1         # nearly all hanging, a rare one reaching up
            if side < 0:
                drop *= 0.55        # an upward twig that runs off the cell edge cuts hard on the card
            colour = rnd.choice((TWIG, TWIG, TWIG_LIT, TWIG_DARK))
            ex, ey = sx + forward, sy + side * drop
            draw.line([(sx, sy), (ex, ey)], fill=colour + (255,), width=1)
            # a branchlet off the middle of it — one order of subdivision is the difference between a
            # comb and a mass, and it costs nothing but strokes on a page painted once
            if rnd.random() < 0.7:
                mx, my = sx + (ex - sx) * rnd.uniform(0.35, 0.65), sy + (ey - sy) * rnd.uniform(0.35, 0.65)
                draw.line([(mx, my), (mx + forward * rnd.uniform(0.2, 0.7),
                                      my + side * drop * rnd.uniform(0.25, 0.65))],
                          fill=colour + (255,), width=1)
            if leaves and rnd.random() < leaves:
                for f in (0.45, 0.75, 1.0):                 # along the twig, not only at its end
                    if rnd.random() < 0.35:
                        continue
                    r = rnd.uniform(0.9, 1.7)
                    lx, ly = sx + (ex - sx) * f, sy + (ey - sy) * f
                    leaf = rnd.choice((LEAF, LEAF_GOLD, LEAF_DEEP, LEAF_GOLD))
                    draw.ellipse((lx - r, ly - r * 0.55, lx + r, ly + r * 0.55), fill=leaf + (255,))

    # the branch itself: near-white where it leaves the trunk, darkening out to the twigs
    for k in range(span):
        t = k / max(span - 1, 1)
        sx, sy = stem(t)
        mix = min(1.0, t * 1.4)
        colour = tuple(int(BRANCH_PALE[i] + (TWIG[i] - BRANCH_PALE[i]) * mix) for i in range(3))
        draw.line([(sx, sy), (sx + 1.5, sy)], fill=colour + (255,), width=2 if t < 0.22 else 1)

    # Snow along the branch's upper edge, thinning toward the tip. It hugs the branch rather than
    # riding high above it: a dab with no twig under it is a free-floating white speck once the alpha
    # test cuts everything around it away.
    for k in range(0, span, 2):
        t = k / max(span - 1, 1)
        if rnd.random() > snow * (1.0 - 0.5 * t):
            continue
        sx, sy = stem(t)
        top = sy - half_height(t) * rnd.uniform(0.02, 0.30)
        r = rnd.uniform(1.4, 3.2) * (1.0 - 0.30 * t)
        shade = FROST if rnd.random() < 0.70 else FROST_SHADE
        draw.ellipse((sx - r, top - r * 0.65, sx + r, top + r * 0.65), fill=shade + (255,))
    # and a little caught on the branch itself, where a horizontal limb actually holds it
    for k in range(0, int(span * 0.7), 4):
        t = k / max(span - 1, 1)
        if rnd.random() > snow * 0.8:
            continue
        sx, sy = stem(t)
        r = rnd.uniform(1.2, 2.6)
        draw.ellipse((sx - r, sy - r * 0.9, sx + r, sy + r * 0.3), fill=FROST + (255,))


def paint_bark(draw):
    """White bark with horizontal lenticels. Horizontal marks only — see the module docstring."""
    x0, y0, x1, y1 = BARK
    draw.rectangle(BARK, fill=BARK_WHITE + (255,))
    # broad cream and grey banding, the shading that stops it reading as flat paper
    for _ in range(7):
        y = rnd.uniform(y0 + 5, y1 - 8)
        draw.rectangle((x0, y, x1 - 1, y + rnd.uniform(1.5, 4.0)),
                       fill=(BARK_CREAM if rnd.random() < 0.65 else BARK_GREY) + (255,))
    # Lenticels: short dark dashes, the mark that says birch and nothing else. Kept SPARSE and thin —
    # this cell is squeezed onto a face about 0.1 m wide, so ink that looks reasonable on the page
    # lands as heavy black banding on the trunk. The dark is a grey-brown, not near-black, for the
    # same reason: a birch is a light-toned prop and reads wrong once the bands dominate it.
    for _ in range(26):
        y = rnd.uniform(y0 + 6, y1 - 7)
        w = rnd.uniform(4, 20)
        x = rnd.uniform(x0, x1 - 1 - w)
        draw.rectangle((x, y, x + w, y + rnd.uniform(1.0, 1.8)), fill=BARK_DARK + (255,))
    # two heavier scars where a limb was shed, each with a pale lip above it
    for _ in range(2):
        y = rnd.uniform(y0 + 12, y1 - 14)
        w = rnd.uniform(20, 38)
        x = rnd.uniform(x0, x1 - 1 - w)
        draw.rectangle((x, y, x + w, y + rnd.uniform(3.0, 5.0)), fill=BARK_DARK + (255,))
        draw.rectangle((x, y - 2, x + w, y), fill=BARK_GREY + (255,))
    speckle(draw, rnd, (x0, y0 + 6, x1, y1 - 6), 70,
            (BARK_CREAM + (255,), BARK_GREY + (255,)), size=(1, 1))


def paint_crown(draw):
    """Bare upright twigs for the treetop — no snow cap, because a birch has no conical tip."""
    x0, y0, x1, y1 = CROWN
    w, h = x1 - x0, y1 - y0
    for _ in range(26):
        bx = rnd.uniform(x0 + 2, x0 + w * 0.35)
        by = rnd.uniform(y1 - 4, y1 - 1)
        ex = bx + rnd.uniform(w * 0.30, w * 0.92)
        ey = by - rnd.uniform(h * 0.25, h * 0.92)
        draw.line([(bx, by), (ex, ey)], fill=rnd.choice((TWIG, TWIG_LIT, TWIG_DARK)) + (255,), width=1)
        if rnd.random() < 0.35:
            r = rnd.uniform(1.2, 2.4)
            draw.ellipse((ex - r, ey - r, ex + r, ey + r), fill=FROST + (255,))
    scatter_blobs(draw, rnd, (x0, y1 - h * 0.3, x1, y1), 4, FROST_SHADE + (255,), (2.0, 4.5))


# Per-cell character, so 50-odd cards on one tree do not repeat visibly. Snow is deliberately lighter
# than the conifer page's: a birch's twigs are far finer, so the same frost coverage buries them and
# the whole crown renders as a pale haze with no structure left in it.
STYLE = [
    dict(droop=0.46, density=4, snow=0.45, leaves=0.00, reach=0.97),
    dict(droop=0.54, density=4, snow=0.30, leaves=0.38, reach=0.95),
    dict(droop=0.42, density=4, snow=0.42, leaves=0.10, reach=0.86),
    dict(droop=0.50, density=3, snow=0.28, leaves=0.30, reach=0.88),
    dict(droop=0.36, density=4, snow=0.38, leaves=0.18, reach=0.70),
    dict(droop=0.28, density=3, snow=0.34, leaves=0.08, reach=0.56),
]


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # transparent, but already twig-coloured: a transparent-BLACK page bleeds dark fringes into every
    # cutout edge through the mip chain, because alpha is tested after filtering
    img, draw = new_atlas(SIZE, bg=TWIG + (0,))
    for cell, style in zip(SPRAYS, STYLE):
        spray(draw, cell, **style)
    paint_bark(draw)
    paint_crown(draw)
    img.save(OUT)

    px = img.load()
    holes = sum(1 for y in range(SIZE) for x in range(SIZE) if px[x, y][3] < 16)
    print(f'wrote {OUT} {img.size} {img.mode}')
    print(f'  {100 * holes / (SIZE * SIZE):.1f}% fully transparent '
          f'(a deciduous canopy page runs 55-60%)')
    img.resize((SIZE * 3, SIZE * 3), 0).save(OUT.replace('.png', '_3x.png'))


if __name__ == '__main__':
    main()
