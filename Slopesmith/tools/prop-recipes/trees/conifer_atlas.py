"""
Paint the shared conifer atlas — an ALPHA-CUTOUT sheet of snow-laden bough sprigs.

This is the file that decides whether the conifers work. A cutout foliage page is a 128x128 page
of four hand-painted drooping boughs, 58.9% of it fully transparent: the tree's entire shape lives in
the alpha channel, and the geometry is just vertical cards to hang it on. So the art is the prop, and
the geometry is scaffolding.

ONE page for the whole conifer family — `frosted_pine`, `bushy_pine` and `tall_pine` all hang their
cards on these six sprigs. Sharing one page across a family is the cheapest way to a varied forest:
different trees hang off a single material, and the thing that separates them
is card count and placement, not art.

256x256 RGBA, a 2x4 grid of 128x64 cells:

    [0][0] bough A (long)      [0][1] bough B (long, heavier snow)
    [1][0] bough C (medium)    [1][1] bough D (medium, sparse)
    [2][0] bough E (short)     [2][1] bough F (tip sprig)
    [3][0] bark                [3][1] snow clump

Each bough runs LEFT (where it meets the trunk) to RIGHT (the tip), so a card's UV maps inner→outer
along U with no per-card decisions.

Two things that matter more than they look:

- The page starts transparent but its RGB is already foliage green, not black. Alpha is tested after
  filtering, so a transparent-black background bleeds dark fringes into every needle edge through the
  mip chain.
- Nothing is drawn antialiased. Slopesmith tests prop alpha at 0.4 (`props/textures.ts:288`), so a
  half-alpha edge pixel is a coin flip; hard 0-or-255 alpha cuts predictably.

    python Slopesmith/tools/prop-recipes/conifer_atlas.py
"""

import math
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import blob, new_atlas, panels, scatter_blobs, speckle, stripes   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'conifer.png')

GRID = panels(SIZE, 2, 4)
BOUGHS = [GRID[0][0], GRID[0][1], GRID[1][0], GRID[1][1], GRID[2][0], GRID[2][1]]
BARK, CLUMP = GRID[3][0], GRID[3][1]

NEEDLE = (48, 78, 56)
NEEDLE_LIT = (72, 108, 78)
NEEDLE_DEEP = (28, 48, 36)
FROST = (232, 240, 245)
FROST_SHADE = (196, 212, 222)
FROST_BLUE = (168, 190, 206)
BARK_BASE = (66, 52, 41)
BARK_LIT = (96, 77, 60)
BARK_DEEP = (40, 31, 25)

rnd = random.Random(31415926)


# A bough card is about 1.5 m long and its cell is 128 px wide, so this page runs ~1.2 cm per pixel
# across and ~1.4 cm per pixel up. Every length below is derived from that, because it is what decides
# whether the art reads as a branch or as a houseplant:
#
#     a pine needle       4-12 cm     3-8 px      <- barely more than the line that carries it
#     a lateral shoot    10-35 cm     7-25 px     <- the visible lobes; these make the silhouette
#
# Needles are therefore nearly the smallest mark the page can hold, and the frond's whole vertical
# extent has to come from the SHOOTS. Combing 30 px strokes straight off the spine draws 43 cm needles
# and the bough comes out a fern.
NEEDLE_PX = (2.6, 7.0)


def bough(img, draw, cell, droop=0.42, density=3, snow=0.7, reach=0.96, lift=0.34, bare=0.0):
    """One snow-laden bough, drawn left-to-right across its cell.

    A bough BRANCHES, and drawing all three of its levels is the whole trick. A conifer branch is a main
    axis carrying lateral shoots, and the needles live on the shoots — never on the axis itself. A page
    this size can draw exactly that and must stop there: a spine with eight or ten foliage lobes hanging
    off it, each a clump a few pixels across under a snow cap. Not one individual needle is visible on
    the whole page, because at this scale a needle is about four pixels.

    Skip the shoot level and comb needles straight off the spine and you get a feather — one enormous
    fern frond whose "needles" are 40 cm long. The lobes are also what make the mass read as depth:
    clumps with thin stretches between them catch light unevenly, where an even comb reads as a flat
    green sheet however carefully the individual strokes are varied.

    Shoots rake BACKWARD toward the trunk and so do the needles on them, which is what gives a conifer
    its swept look. Snow settles on the upper lobes only, and the frond tapers toward the tip.

    `bare` is the fraction of the frond nearest the TRUNK carrying no shoots, only bare axis. Needles are
    shed once they stop paying for themselves, so how far in the foliage reaches is set by how long a
    species holds them: 2-4 years on a pine, 5-10 on a spruce or fir. A pine bough is therefore a tuft
    out at the end of a bare stick, and a fir bough is green nearly to the trunk. It is the difference
    between the two genera at any distance, and it costs nothing but where the shoots start.
    """
    x0, y0, x1, y1 = cell
    w, h = x1 - x0, y1 - y0
    span = int(w * reach)
    stem_y = y0 + h * lift                       # axis rides high; the frond hangs mostly below it

    def stem(t):
        return (x0 + 1 + t * span, stem_y + droop * h * (t ** 1.7))

    def half_height(t):
        return h * 0.46 * (1.0 - 0.55 * t)       # the frond narrows toward the tip

    def shoot(sx, sy, ang, length, thin=1.0):
        """One lateral shoot — a short woody stalk with needles combed off both of its sides."""
        ex, ey = sx + length * math.cos(ang), sy + length * math.sin(ang)
        draw.line([(sx, sy), (ex, ey)], fill=NEEDLE_DEEP + (255,), width=1)
        steps = max(2, int(length / 2.2))
        for i in range(steps + 1):
            f = i / steps
            nx, ny = sx + (ex - sx) * f, sy + (ey - sy) * f
            for side in (-1, 1):
                for _ in range(max(1, int(density * thin))):
                    # A needle leaves its shoot near-perpendicular and sweeps back toward the shoot's
                    # own base — the same rake as the shoots take against the trunk, one level down.
                    na = ang + side * (math.pi / 2) * (1.0 + rnd.uniform(0.15, 0.55))
                    nl = rnd.uniform(*NEEDLE_PX) * (1.0 - 0.35 * f) * thin
                    colour = rnd.choice((NEEDLE, NEEDLE, NEEDLE_LIT, NEEDLE_DEEP))
                    if ny < sy:
                        colour = NEEDLE_LIT if rnd.random() < 0.45 else NEEDLE   # lit upper surface
                    draw.line([(nx, ny), (nx + nl * math.cos(na), ny + nl * math.sin(na))],
                              fill=colour + (255,), width=1)

    # Shoots come in LOBES rather than evenly spaced: a conifer puts out a whorl of laterals at each
    # year's node, so the spray is a run of clumps with thinner stretches between them. Even spacing is
    # what turns a bough back into a feather even after the needles have been sized correctly.
    lobes = []                             # (x, y, t) per clump, for the snow pass to work from
    k = 0.0
    while k < span:
        t = k / max(span - 1, 1)
        if t < bare:
            k += 4.0                                 # bare axis: these shoots were shed years ago
            continue
        sx, sy = stem(t)
        # ramp in over the first stretch past the bare zone, so the foliage starts as a taper rather
        # than a wall — a hard edge across the frond reads as a cut, not as a needle line
        env = half_height(t) * (min(1.0, (t - bare) / 0.10 + 0.35) if bare else 1.0)
        # Lobe-to-lobe thickness varies widely on purpose. A constant one gives an even green sausage,
        # and the lumpy lower edge is most of what reads as "many small branches" at a distance.
        reach_k = env * rnd.uniform(0.55, 1.05)
        for _ in range(rnd.randint(3, 5)):
            jx, jy = sx + rnd.uniform(-2.5, 2.5), sy + rnd.uniform(-1.0, 1.0)
            if rnd.random() < 0.26:
                # the upper side of the spray, kept short: a bough's mass hangs BELOW its axis, and a
                # symmetric one loses the drooping read that says conifer
                ang = -math.pi / 2 - rnd.uniform(0.15, 0.75)
                ln = reach_k * rnd.uniform(0.28, 0.55)
            else:
                ang = math.pi / 2 + rnd.uniform(0.10, 0.85)
                ln = reach_k * rnd.uniform(0.68, 1.0)
            shoot(jx, jy, ang, ln)
        if rnd.random() < 0.22:
            # A drip: one long thin shoot hanging well below the mass. These are what stop the frond's
            # lower edge from being a straight cut.
            shoot(sx + rnd.uniform(-2.0, 2.0), sy, math.pi / 2 + rnd.uniform(-0.25, 0.45),
                  env * rnd.uniform(1.05, 1.55), thin=0.45)
        lobes.append((sx, sy, t))
        # Lobes overlap rather than sitting apart. Spaced out they read as beads on a string with the
        # background showing between them; overlapping, they merge into one mass that is still lumpy
        # along its lower edge, which is what a bough actually looks like.
        k += rnd.uniform(4.5, 8.0)

    # the axis itself, drawn over the shoots near the base where it would show — and all the way across
    # a bare zone, where it is the only thing there
    for k in range(0, int(span * max(0.55, bare + 0.12))):
        t = k / max(span - 1, 1)
        sx, sy = stem(t)
        draw.line([(sx, sy), (sx + 1, sy)], fill=NEEDLE_DEEP + (255,),
                  width=2 if t < bare * 0.75 else 1)

    # Snow follows the SILHOUETTE, found by scanning each column for its topmost foliage pixel. Placing
    # it by formula instead — off the axis, or off a lobe's nominal top — is what makes it read as
    # polka dots on green: half the dabs land mid-mass where no snow could settle, and the ones that
    # clear the foliage survive the alpha cut as white specks hanging in mid-air. A good page is more
    # white than green, a near-continuous crust along the top edge with the foliage showing through
    # beneath, and a crust is only continuous if it knows where the top edge actually is.
    # Measured in full BEFORE anything is drawn. Scanning and drawing in the same pass makes each dab
    # the next column's silhouette, and the crust walks itself up the cell in a diagonal staircase.
    px = img.load()
    silhouette = []
    for x in range(x0, x1):
        for y in range(y0, y1):
            if px[x, y][3] > 128:
                silhouette.append((x, y))
                break
    for (x, top) in silhouette:
        t = (x - x0) / max(w - 1, 1)
        if rnd.random() > snow * (1.0 - 0.40 * t):
            continue
        if t < bare:
            # on the bare axis snow has nothing to pile up on, so it stays a line rather than a mound
            draw.line([(x, top - 1), (x + 1, top - 1)], fill=FROST + (255,), width=1)
            continue
        r = rnd.uniform(1.5, 3.0) * (1.0 - 0.25 * t)
        shade = FROST if rnd.random() < 0.72 else FROST_SHADE
        draw.ellipse((x - r, top - r * 0.55, x + r, top + r * 1.15), fill=shade + (255,))
    # a few clumps sagging off the underside, where snow collects in the crotch of the shoots
    for (lx, ly, t) in lobes:
        if t > 0.85 or rnd.random() > snow * 0.30:
            continue
        cy = ly + half_height(t) * rnd.uniform(0.25, 0.7)
        r = rnd.uniform(1.4, 2.6)
        draw.ellipse((lx - r, cy - r * 0.8, lx + r, cy + r * 0.8), fill=FROST_SHADE + (255,))


def paint_bark(draw):
    x0, y0, x1, y1 = BARK
    draw.rectangle(BARK, fill=BARK_BASE + (255,))
    stripes(draw, BARK, BARK_DEEP + (255,), 26, width=(1.0, 3.2), rnd=rnd)
    stripes(draw, BARK, BARK_LIT + (255,), 14, width=(0.7, 2.0), rnd=rnd)
    speckle(draw, rnd, BARK, 140, (BARK_LIT + (255,), BARK_DEEP + (255,)), size=(1, 2))
    draw.rectangle((x0, y0, x1 - 1, y0 + 3), fill=FROST_SHADE + (255,))   # snow caught on the upper trunk


def paint_clump(draw):
    """Pure snow, for the crown cap."""
    draw.rectangle(CLUMP, fill=FROST + (255,))
    scatter_blobs(draw, rnd, CLUMP, 9, FROST_SHADE + (255,), (4.0, 10.0))
    scatter_blobs(draw, rnd, CLUMP, 5, FROST_BLUE + (255,), (3.0, 7.0))
    speckle(draw, rnd, CLUMP, 70, (FROST_SHADE + (255,), (255, 255, 255, 255)), size=(1, 1))


# Per-cell character, so 30-odd cards on one tree do not repeat visibly, and the page splits BY COLUMN
# into the two genera it serves:
#
#     left  column (A, C, E)   bare 0.40-0.46   PINE      needles held 2-4 years, a tuft on a bare stick
#     right column (B, D, F)   bare 0.04-0.08   FIR/SPRUCE  needles held 5-10 years, green to the trunk
#
# Each column carries a long, a medium and a short frond, so either genus still gets a full range of
# sizes off half the page. `frosted_pine`, `bushy_pine` and `tall_pine` draw from the left column,
# `medium_fir` and `tall_spruce` from the right.
STYLE = [
    dict(droop=0.40, density=3, snow=0.72, reach=0.97, bare=0.42),
    dict(droop=0.50, density=4, snow=0.95, reach=0.95, bare=0.06),
    dict(droop=0.36, density=3, snow=0.58, reach=0.84, bare=0.46),
    dict(droop=0.46, density=3, snow=0.55, reach=0.88, bare=0.08),
    dict(droop=0.30, density=3, snow=0.78, reach=0.70, bare=0.40),
    dict(droop=0.24, density=3, snow=0.62, reach=0.55, bare=0.04),
]


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # transparent, but already green: see the module docstring on why not transparent-black
    img, draw = new_atlas(SIZE, bg=NEEDLE + (0,))
    for cell, style in zip(BOUGHS, STYLE):
        bough(img, draw, cell, **style)
    paint_bark(draw)
    paint_clump(draw)
    img.save(OUT)

    px = img.load()
    holes = sum(1 for y in range(SIZE) for x in range(SIZE) if px[x, y][3] < 16)
    print(f'wrote {OUT} {img.size} {img.mode}')
    print(f'  {100 * holes / (SIZE * SIZE):.1f}% fully transparent '
          f'(a cutout foliage page runs 55-60%)')
    img.resize((SIZE * 3, SIZE * 3), 0).save(OUT.replace('.png', '_4x.png'))


if __name__ == '__main__':
    main()
