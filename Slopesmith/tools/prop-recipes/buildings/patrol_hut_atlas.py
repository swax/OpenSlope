"""
Paint the family atlas for the ski patrol hut.

256x256 RGBA, a 4x4 grid of 64px panels — 256 rather than the cookie's 128 because a building wears
many more distinct surfaces than a dessert does, and still ONE page for the whole prop, the way SNOW's
snow blower family shares one.

    [0][0] wall siding    [0][1] front wall     [0][2] cross sign     [0][3] gable boards
    [1][0] roof shingle   [1][1] ski            [1][2] soffit/fascia  [1][3] back wall
    [2][0] deck           [2][1] sawn timber    [2][2] snow           [2][3] door
    [3][0] window         [3][1] flue metal     [3][2] log bark       [3][3] log end

`_lib.panels(4, 4)` describes the same grid in UV space.

## What each panel is drawn AT

A panel is not a square metre of anything — it is stretched onto whatever face it lands on, and that
ratio decides what can be drawn there. `check.py` prints these off the geometry, which is where they
should be read from; a 64px cell only carries 56 usable pixels once `_lib.uv()` has inset it, and
deriving them by hand instead lands every number about 14% out.

    panel      the face it lands on              across      up      so
    wall       3.20 x 2.25 m long wall           5.7 cm/px   4.0     a 22 cm board course is 6 px
    front      2.80 x 2.25 m gable-end wall      5.0         4.0     same courses, same 6 px
    gable      3.80 x 1.50 m roof end            6.8         2.7     the same 22 cm course is 8 px
    roof       5.20 x 2.34 m slope               9.3         4.2     a 25 cm shingle course is 6 px,
                                                                     and a 40 cm shingle is 4 wide
    soffit     3.80 x 5.20 m roof underside      6.8         9.3     rafters 60 cm apart are 6 px
    deck       1.35 x 2.20 m decking             2.4         3.9     15 cm boards are 6 px
    sign       0.88 x 0.88 m cross board         1.6         1.6     square, and drawn square
    door       0.84 x 1.70 m                     1.5         3.0     2:1; the ironwork is drawn tall
    window     0.95 x 0.78 m                     1.7         1.4     nearly square

HORIZONTAL siding is worth the choice it looks like it isn't. The three wall panels land on faces of
three different widths but all of the same height, so lapped courses line up all the way around the
building for free; vertical boards would come out a different width on every wall. The gable takes a
course of its own only because its panel is stretched differently, and 9 px there is the same 22 cm
board as 6 px on the wall below it.

Two panels are shared across faces of very different aspect, and both resolve it by drawing for the
majority. `timber` is mostly posts and reveals — tall narrow faces, 0.28 cm/px across against 3.5 up —
so its grain runs vertically and degrades to noise on the few short cross-strips. `soffit` does the
roof underside and the fascia board, which at least agree that their lines should run the long way.

Nothing here needs pre-distorting, and that is a design decision rather than luck: the one face with a
real taper is the roof's trapezoidal end, and the cross that wants to go there is modelled as its own
flat board instead. See `patrol_hut.py` for why.

    python Slopesmith/tools/prop-recipes/buildings/patrol_hut_atlas.py
"""

import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import blob, new_atlas, panels, scatter_blobs, speckle, stripes   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'patrol_hut.png')

# `_lib.uv()` insets every mapped face by 2/128 of the page off its panel's edges, so mip filtering
# cannot drag one panel into the next. On a 256px page that is 4px, and it means the outer 4px of a
# cell is never SEEN — it only bleeds. Art that has to land in a known place goes through `at()`.
INSET = 4

GRID = panels(SIZE, 4, 4)
WALL, WALL_DOOR, SIGN, GABLE = GRID[0]
ROOF, GEAR, SOFFIT, WALL_BACK = GRID[1]
DECK, TIMBER, SNOW, DOOR = GRID[2]
WINDOW, METAL, BARK, LOGEND = GRID[3]

WOOD = (104, 72, 52)
WOOD_HI = (136, 100, 74)
WOOD_LO = (72, 48, 34)
WOOD_DK = (52, 34, 25)
TRIM = (228, 226, 216)
TRIM_LO = (184, 182, 172)
RED = (166, 46, 42)
RED_HI = (198, 72, 64)
RED_LO = (116, 30, 28)
FROST = (240, 244, 248)
FROST_SH = (208, 218, 232)
FROST_DP = (174, 188, 208)
SHINGLE = (60, 64, 66)
SHINGLE_HI = (80, 85, 87)
SHINGLE_LO = (40, 44, 46)
SOOT = (44, 44, 48)
SOOT_HI = (76, 78, 84)
GLASS_LIT = (232, 190, 118)
GLASS_DIM = (150, 116, 72)
DECKW = (118, 92, 70)
DECKW_HI = (148, 122, 96)
DECKW_LO = (84, 64, 48)
PALE = (208, 180, 136)
PALE_LO = (170, 140, 98)
BARKC = (76, 60, 48)
BARKC_HI = (104, 86, 68)
IRON = (34, 32, 32)

rnd = random.Random(70325)
img, draw = new_atlas(SIZE)


def at(rect, u, v):
    """A panel's own 0-1 space to a page pixel, honouring the inset every mapped face gets."""
    x0, y0, x1, y1 = rect
    return (x0 + INSET + u * (x1 - x0 - 2 * INSET), y1 - INSET - v * (y1 - y0 - 2 * INSET))


def siding(rect, course, base, hi, lo):
    """Lapped horizontal boards. Each course gets a shadow line under its butt and a lit edge on the
    board below, which is the whole read — a wall drawn as one flat field looks like a decal."""
    x0, y0, x1, y1 = rect
    draw.rectangle(rect, fill=base)
    y = y1 - 1.0
    while y > y0:
        # A few courses a shade off. Boards weather at different rates and a perfectly even wall is
        # the same tell as a perfectly even whorl of branches.
        if rnd.random() < 0.30:
            draw.rectangle((x0, y - course + 1, x1 - 1, y), fill=rnd.choice((hi, lo, base)))
        draw.line([(x0, y), (x1 - 1, y)], fill=lo)
        draw.line([(x0, y - 1), (x1 - 1, y - 1)], fill=hi)
        y -= course
    speckle(draw, rnd, rect, 50, (hi, lo), size=(1, 1))
    for _ in range(3):
        cx, cy = rnd.uniform(x0 + 6, x1 - 6), rnd.uniform(y0 + 6, y1 - 6)
        blob(draw, rnd, cx, cy, 2.2, 1.4, WOOD_DK, lobes=6)      # a knot, flattened with the courses


def roof():
    """Shingles at the eave, snow over the top half, ragged where the slab has slid and broken off.

    A straight snow line reads as paint. The lower edge is a random walk with a few tongues reaching
    further down the slope, which is what a snow slab does before it lets go.
    """
    x0, y0, x1, y1 = ROOF
    draw.rectangle(ROOF, fill=SHINGLE)
    for k in range(11):
        y = y1 - 1 - k * 6.6
        draw.line([(x0, y), (x1 - 1, y)], fill=SHINGLE_LO)
        draw.line([(x0, y - 1), (x1 - 1, y - 1)], fill=SHINGLE_HI)
        # Butt joints every 5 px: a shingle is wider than its exposure is tall in life, and at this
        # page's 8.1 across against 3.7 up that comes out NARROWER than the course. Space them at the
        # course height instead and the roof reads as brickwork.
        for x in range(x0 + (k % 2) * 3, x1, 5):
            draw.line([(x, y), (x, y - 5)], fill=SHINGLE_LO)
    speckle(draw, rnd, ROOF, 70, (SHINGLE_HI, SHINGLE_LO), size=(1, 1))

    span = y1 - y0
    edge, y = [], y0 + 0.62 * span
    for x in range(x0, x1):
        y = max(y0 + 0.40 * span, min(y0 + 0.80 * span, y + rnd.uniform(-1.7, 1.7)))
        edge.append(y)
    for i, x in enumerate(range(x0, x1)):
        draw.line([(x, y0), (x, edge[i])], fill=FROST)
        draw.line([(x, edge[i] - 2), (x, edge[i])], fill=FROST_SH)   # the broken face of the slab
    for _ in range(3):
        cx = rnd.randrange(x0 + 6, x1 - 6)
        w, drop = rnd.randint(3, 7), rnd.uniform(4.0, 9.0)
        for x in range(cx - w, cx + w):
            if x0 <= x < x1:
                draw.line([(x, edge[x - x0]), (x, edge[x - x0] + drop * (1 - abs(x - cx) / w))],
                          fill=FROST)
    scatter_blobs(draw, rnd, (x0, y0, x1, y0 + int(0.4 * span)), 5, FROST_SH, (2.0, 4.0))


def sign():
    """The patrol cross. Its own square board, so it is drawn exactly as it lands."""
    draw.rectangle(SIGN, fill=RED_LO)
    bx0, by1 = at(SIGN, 0.03, 0.03)
    bx1, by0 = at(SIGN, 0.97, 0.97)
    draw.rectangle((bx0, by0, bx1, by1), fill=RED)
    draw.rectangle((bx0, by0, bx1, by0 + 6), fill=RED_HI)          # the lit top edge of the board
    speckle(draw, rnd, SIGN, 26, (RED_HI, RED_LO), size=(1, 1))    # weathering, under the cross
    ax0, ay1 = at(SIGN, 0.14, 0.42)
    ax1, ay0 = at(SIGN, 0.86, 0.58)
    draw.rectangle((ax0, ay0, ax1, ay1), fill=TRIM)
    vx0, vy1 = at(SIGN, 0.42, 0.14)
    vx1, vy0 = at(SIGN, 0.58, 0.86)
    draw.rectangle((vx0, vy0, vx1, vy1), fill=TRIM)


def window():
    """Four panes, warm inside, frosted at the corners — the one thing on the hut that says someone is
    in it. Nearly square panel, so this is drawn as it looks."""
    draw.rectangle(WINDOW, fill=TRIM_LO)
    gx0, gy1 = at(WINDOW, 0.12, 0.12)
    gx1, gy0 = at(WINDOW, 0.88, 0.88)
    draw.rectangle((gx0, gy0, gx1, gy1), fill=GLASS_LIT)
    draw.rectangle((gx0, gy0, gx1, gy0 + (gy1 - gy0) * 0.30), fill=GLASS_DIM)   # the room's ceiling
    speckle(draw, rnd, (int(gx0), int(gy0), int(gx1), int(gy1)), 30,
            (GLASS_DIM, (250, 214, 148)), size=(1, 1))
    draw.rectangle((gx0, (gy0 + gy1) / 2 - 1, gx1, (gy0 + gy1) / 2 + 1), fill=TRIM)
    draw.rectangle(((gx0 + gx1) / 2 - 1, gy0, (gx0 + gx1) / 2 + 1, gy1), fill=TRIM)
    for cx, cy in ((gx0, gy0), (gx1, gy0), (gx0, gy1), (gx1, gy1)):
        blob(draw, rnd, cx, cy, 5, 4, FROST_SH, lobes=7)
    draw.rectangle((gx0 - 3, gy1 - 1, gx1 + 3, gy1 + 3), fill=FROST)            # snow on the sill


def door():
    """Vertical tongue-and-groove with strap hinges. The panel runs 1.3 cm/px across against 2.7 up,
    so the ironwork is drawn TALL to come out square on the door."""
    draw.rectangle(DOOR, fill=RED_LO)
    ax0, ay1 = at(DOOR, 0.0, 0.0)
    ax1, ay0 = at(DOOR, 1.0, 1.0)
    draw.rectangle((ax0, ay0, ax1, ay1), fill=RED)
    for k in range(1, 6):
        x = ax0 + (ax1 - ax0) * k / 6.0
        draw.line([(x, ay0), (x, ay1)], fill=RED_LO)
        draw.line([(x + 1, ay0), (x + 1, ay1)], fill=RED_HI)
    for v in (0.20, 0.78):
        hx, hy = at(DOOR, 0.06, v)
        draw.rectangle((hx, hy - 3, at(DOOR, 0.62, v)[0], hy + 3), fill=IRON)
    kx, ky = at(DOOR, 0.84, 0.46)
    draw.ellipse((kx - 2, ky - 4, kx + 2, ky + 4), fill=IRON)
    speckle(draw, rnd, DOOR, 40, (RED_HI, RED_LO), size=(1, 1))


def logend():
    """A split billet's sawn face: bark around the rim, rings off centre, and the split it was made by.
    The end is 0.22 x 0.20 m, so this is one of the few panels that lands almost square."""
    draw.rectangle(LOGEND, fill=BARKC)
    ex0, ey1 = at(LOGEND, 0.09, 0.09)
    ex1, ey0 = at(LOGEND, 0.91, 0.91)
    draw.rectangle((ex0, ey0, ex1, ey1), fill=PALE)
    cx, cy = (ex0 + ex1) / 2 + 4, (ey0 + ey1) / 2 - 3       # heartwood is never in the middle
    for r in (23, 18, 13, 9, 5):
        draw.ellipse((cx - r, cy - r * 0.94, cx + r, cy + r * 0.94), outline=PALE_LO, width=1)
    draw.line([(cx - 3, cy - 16), (cx + 2, cy + 18)], fill=PALE_LO, width=1)
    speckle(draw, rnd, LOGEND, 40, (PALE_LO, (224, 200, 160)), size=(1, 1))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    draw.rectangle((0, 0, SIZE, SIZE), fill=WOOD)      # unused corners read as timber, never black

    siding(WALL, 6.3, WOOD, WOOD_HI, WOOD_LO)
    siding(WALL_DOOR, 6.3, WOOD, WOOD_HI, WOOD_LO)
    siding(WALL_BACK, 6.3, WOOD, WOOD_HI, WOOD_LO)
    siding(GABLE, 9.4, WOOD_LO, WOOD, WOOD_DK)         # the shaded end, and its own course spacing

    # The doorway's cased opening, sized off the recipe's own door box: 0.84 x 1.70 m starting at the
    # deck, on a 2.80 x 2.25 m wall. The door itself is modelled proud of this, so what shows is trim.
    tx0, ty1 = at(WALL_DOOR, 0.5 - 0.63 / 2.80, 0.30 / 2.25)
    tx1, ty0 = at(WALL_DOOR, 0.5 + 0.63 / 2.80, 2.10 / 2.25)
    draw.rectangle((tx0, ty0, tx1, ty1), fill=TRIM)
    draw.rectangle((tx0 + 3, ty0 + 3, tx1 - 3, ty1), fill=WOOD_DK)

    # A louvred vent high on the back wall, where a hut puts one to let the stove breathe.
    vx0, vy1 = at(WALL_BACK, 0.40, 0.74)
    vx1, vy0 = at(WALL_BACK, 0.60, 0.88)
    draw.rectangle((vx0, vy0, vx1, vy1), fill=WOOD_DK)
    for k in range(4):
        y = vy0 + (vy1 - vy0) * (k + 0.5) / 4
        draw.line([(vx0, y), (vx1, y)], fill=WOOD_HI)

    roof()
    sign()
    window()
    door()
    logend()

    # snow — the drift's top is mapped RADIALLY, so anything concentric here lands as concentric rings
    # on the snow and reads as a target. Irregular blobs only.
    draw.rectangle(SNOW, fill=FROST)
    scatter_blobs(draw, rnd, SNOW, 7, FROST_SH, (4.0, 9.0))
    scatter_blobs(draw, rnd, SNOW, 4, FROST_DP, (2.5, 5.0))
    scatter_blobs(draw, rnd, SNOW, 9, (250, 252, 255), (2.0, 4.5))
    speckle(draw, rnd, SNOW, 60, (FROST_SH, (252, 253, 255)), size=(1, 1))

    # soffit and fascia — the shaded underside of the roof, with the rafter ends showing. Its lines
    # run the long way on both faces it lands on.
    draw.rectangle(SOFFIT, fill=WOOD_DK)
    x0, y0, x1, y1 = SOFFIT
    for k in range(9):
        y = y0 + (y1 - y0) * (k + 0.5) / 9
        draw.line([(x0, y), (x1 - 1, y)], fill=(38, 25, 18))
        draw.line([(x0, y + 1), (x1 - 1, y + 1)], fill=WOOD_LO)
    speckle(draw, rnd, SOFFIT, 40, (WOOD_LO, (38, 25, 18)), size=(1, 1))

    # decking — boards running toward the door, with snow trodden across rather than swept clean
    draw.rectangle(DECK, fill=DECKW)
    x0, y0, x1, y1 = DECK
    for k in range(9):
        x = x0 + (x1 - x0) * (k + 0.5) / 9
        draw.line([(x, y0), (x, y1 - 1)], fill=DECKW_LO)
        draw.line([(x + 1, y0), (x + 1, y1 - 1)], fill=DECKW_HI)
    scatter_blobs(draw, rnd, DECK, 5, FROST_SH, (3.0, 6.0))
    speckle(draw, rnd, DECK, 50, (DECKW_HI, DECKW_LO), size=(1, 1))

    # sawn timber — posts, frames, deck and sign edges. The grain runs with the panel's V because most
    # of what this lands on is a tall narrow face: four corner posts, two porch posts, and the reveals
    # around the door and windows. The handful of short cross-strips it also dresses (deck edges, the
    # door head) take the same grain as fine noise, which at 14 cm tall is all it can read as anyway.
    draw.rectangle(TIMBER, fill=WOOD)
    stripes(draw, TIMBER, WOOD_LO, 9, horizontal=False, width=(0.8, 2.4), rnd=rnd)
    stripes(draw, TIMBER, WOOD_HI, 7, horizontal=False, width=(0.6, 1.8), rnd=rnd)
    speckle(draw, rnd, TIMBER, 50, (WOOD_HI, WOOD_LO), size=(1, 1))

    # ski — red topsheet running down to a black tip, which is the end V maps to
    draw.rectangle(GEAR, fill=RED)
    x0, y0, x1, y1 = GEAR
    draw.rectangle((x0, y0, x1 - 1, y0 + 15), fill=IRON)
    draw.rectangle((x0, y0 + 15, x1 - 1, y0 + 18), fill=TRIM)
    draw.rectangle((x0, y1 - 7, x1 - 1, y1 - 1), fill=RED_LO)
    speckle(draw, rnd, GEAR, 30, (RED_HI, RED_LO), size=(1, 1))

    # flue — sooted steel, streaked down its length
    draw.rectangle(METAL, fill=SOOT)
    stripes(draw, METAL, SOOT_HI, 12, horizontal=False, width=(0.6, 2.0), rnd=rnd)
    stripes(draw, METAL, (24, 24, 26), 8, horizontal=False, width=(0.5, 1.6), rnd=rnd)

    # firewood bark, streaked along the billet
    draw.rectangle(BARK, fill=BARKC)
    stripes(draw, BARK, BARKC_HI, 16, horizontal=False, width=(0.8, 2.4), rnd=rnd)
    stripes(draw, BARK, (48, 38, 30), 12, horizontal=False, width=(0.6, 1.8), rnd=rnd)
    speckle(draw, rnd, BARK, 60, (BARKC_HI, (48, 38, 30)), size=(1, 1))

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
