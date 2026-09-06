"""
Paint the architecture page for The Black Sun — the dark one of its four.

512x512 RGBA and fully OPAQUE, an 8x8 grid of 64 px panels. 512 because it is the importer's
per-edge cap and because a three-level nightclub wears more distinct surfaces than any other prop
here: the hut needs 16 panels, this needs all 64. Nothing on this page is a cutout, so there is
nothing for alpha to do and a stray transparent pixel would only punch a hole in a wall.

    python Slopesmith/tools/prop-recipes/buildings/black_sun_atlas.py

## The panel map

    row 0  EXT_BASE   EXT_FACE   EXT_HIGH   EXT_RIB    JAMB       EXT_VENT   SUN_DISC   SUN_RAY
    row 1  RAMP_DECK  RAMP_FLANK RAMP_UNDER APRON      THRESH     SKIRT      RISER      TREAD
    row 2  WALL_LO    WALL_MID   WALL_UP    WALL_TOP   SOFFIT     BEAM       FASCIA     COVE
    row 3  FLOOR      FLOOR_EDGE MEZZ_FLOOR PODIUM     PODIUM_RIM GRATE      LEDGE      INLAY
    row 4  BAR_FRONT  BAR_TOP    BACKBAR    SHELF      BAR_HOOD   STOOL      SPK_FACE   SPK_SIDE
    row 5  BOOTH_BACK BOOTH_SEAT BOOTH_END  TABLE_TOP  TABLE_STEM POST       RAIL       NICHE
    row 6  TOWER      BEZEL      TRUSS      VAULT_UNDER VAULT_TOP SPIRE      DESK       DESK_TOP
    row 7  TRUSS_NODE FIXTURE    LENS       DUCT       OCULUS     DARK       MAT        STEP_SIDE

`black_sun.py` unpacks `_lib.panels(8, 8)` in exactly this order, one `GRID[row]` per line, and that
is the same grid in UV space that `_atlas.panels(SIZE, 8, 8)` returns in pixels. Both are generated
from the same two numbers because a mismatch between them is a silent texture-offset bug that only
shows on the model — reorder a row here without reordering it there and the club is dressed in the
wrong paint everywhere at once, with nothing anywhere reporting it.

What each one dresses: EXT_* the pyramid's outside skin, JAMB the entrance reveal, SUN_DISC/SUN_RAY
the emblem over the door *and* the disc hanging in the ceiling oculus, RAMP_* the fanned approach,
RISER/TREAD the two corner flights, WALL_LO..WALL_TOP the raked interior bottom to top, SOFFIT the
mezzanine's underside seen from the dance floor, FASCIA its edge over the atrium, FLOOR the dance
floor, MEZZ_FLOOR/LEDGE the balcony, PODIUM/PODIUM_RIM the DJ stage, BAR_* the counter, BACKBAR the
backlit bottle wall painted onto the rake, BOOTH_* the private booths, TOWER the DJ tower's shaft,
BEZEL the frame showing around each video screen, VAULT_* the flared canopy, SPIRE the mast rising
from it into the oculus, DARK plain filler for faces nobody sees.

Twelve of the sixty-four — EXT_RIB, EXT_VENT, APRON, SKIRT, BEAM, COVE, GRATE, INLAY, RAIL, NICHE,
LENS, MAT — are reserve: the recipe currently dresses those surfaces some other way. They are still
painted, because an unpainted panel is a black square that the mip chain drags into its neighbours,
and because the reserve is what the next revision of the recipe reaches for.

## Why the page is nearly black, and why that is a constraint rather than a taste

`fullBright` is per PLACEMENT, not per material, so this club cannot be a lit sign and a shaded
building at once. It ships SHADED and the split between "building" and "light" is done in the paint:
this page runs **12-40 out of 255** while `black_sun_neon.png` and `black_sun_video.png` run at the
top of the range. The editor's own prop lighting multiplies a placement by up to 3x when free point
lights are dropped inside it (docs/013) — near-black stays near-black under that multiply while a
saturated line saturates to full, which is exactly the separation wanted. Paint the architecture at
80 and dropping one light inside blows the whole pyramid out to grey.

So bright pixels here are thin, deliberate LINES and nothing else: the lit nosing at the top of each
RISER, the hot edge around BAR_TOP and SHELF, the downlight rhythm on SOFFIT and BAR_HOOD, the
corona on SUN_RAY, FIXTURE's lens. BACKBAR and LENS are the two panels allowed to be bright fields,
because both of them ARE light fittings seen face-on.

The palette is cool: near-black carrying blue-violet and cyan in the shadows, magenta and amber only
where light actually lands. Every field is panelised — recessed joints, seams, fine ribs — because a
flat black panel does not read as black architecture, it reads as a hole in the model.

## What each panel is drawn AT

A panel is not a square metre of anything; it is stretched onto whatever face it lands on, and that
ratio decides what can be drawn there. `check.py black_sun` prints these off the geometry, which is
where they should be read from — a 64 px cell carries only 48 usable pixels once `_lib.uv()` has
inset it, so deriving them by hand lands every number a third out.

    panel          the face it lands on                    across        up       so
    EXT_BASE       60.0 x 9.2 m podium band, tapered      125 -> 101      19.1    a 1.15 m course is 6 px
    EXT_FACE       48.6 x 8.2 m mid band, tapered         101 -> 80       17.0    the same course is 6.6
    EXT_HIGH       27.8 x 8.4 m upper band, tapered        58 -> 2        17.5    ...and 7.2 near the apex
    JAMB           1.6 m reveal x 8.2 m of return            3.3          17.0    a 5 cm arris is 1.5 px
    SUN_DISC       5.7 m disc, mapped RADIALLY              11.9          11.9    round, and drawn round
    SUN_RAY        6.6 m disc, mapped RADIALLY              13.8          13.8    only its outer 14% shows
    RAMP_DECK      16-32 m wide x 4.2 m of run              33-67          8.7    a 1 m grip course is 12 px
    RAMP_FLANK     4.2 m of run x up to 7.2 m deep           8.7          15.0    horizontal courses again
    THRESH         1.6 m of reveal x 14 m of opening         3.3          29.2    all structure across U
    RISER          3.0 m wide x 0.29 m tall                  6.3           0.76   the nosing is 3 cm of page
    TREAD          3.0 m wide x 0.70 m going                 6.3           1.5    grip runs across the step
    WALL_LO..TOP   45 -> 4.7 m wide x 8.2 m tall, tapered    95 -> 10      16-18  a 1.6 m panel is 9 px
    SOFFIT         1.9 x 1.9-3.0 m of mezzanine underside     4-6          4-6    square; one lamp each
    FASCIA         15.2 m of slab edge x 0.30 m               31.7          0.63  three lines, and no more
    FLOOR          6.0 x 6.0 m of dance floor                12.7          12.7   square, and drawn square
    MEZZ_FLOOR     1.9 x 1.9-3.8 m of balcony deck            4-8           4-8
    PODIUM         15 m stage top, mapped RADIALLY           31            31     irregular ONLY - see below
    PODIUM_RIM     4.6 m of stage edge x 1.3 m               9.5           2.7
    BAR_FRONT      20.0 m of counter x 1.15 m               41.7           2.4    185:1 - horizontal only
    BAR_TOP        20.4 x 1.7 m top, and its 0.11 m edge    42.5 / 3.5     0.23   both axes long: see below
    BACKBAR        18.0 m of bottle wall x 4.3 m            37.5           9.0    a bottle is 0.2 px. Bands.
    SHELF          17.0 m of shelf x 0.12 m lip             35.4           0.25
    BAR_HOOD       20.0 m of hood x 2.6 m soffit            41.7           5.4    six lamps over 20 m
    SPK_FACE       1.9 x 2.0 m speaker front                 4.0           4.2    a 6 cm hole is 1.5 px
    BOOTH_BACK     3.2 m of banquette x 1.4 m                6.7           2.9    0.4 m flutes are 6 px
    POST           0.12 m mullion x 1.05 m                   0.25          2.2    all structure across U
    TOWER          8.0 x 6.5 m of shaft                     16.7          13.5    a 1.6 m clad panel is 9.6
    BEZEL          7.3 x 9.7 m frame behind a screen        15.2          20.2    only its border ever shows
    TRUSS          0.44 m section x 22 m chord               0.9          45.8    70:1 - vertical only
    VAULT_UNDER    3.1 m of arc x 1.5 m of flare             6.4           3.1    v=1 is the rim
    SPIRE          2.7 m section x 11 m mast, tapered        5.6          22.8    horizontal only
    STEP_SIDE      3.0 m wide x 25.8 m of raked slab         6.3          53.8    43:1 - vertical only
    FIXTURE        0.34-0.44 m lamp body                     0.7-0.9       0.7-0.9

## The tapered faces, and why seven panels carry nothing but horizontal lines

`check.py` measures 8.3:1 of taper on the exterior bands and 3.0:1 on the interior ones — they are
trapezoids, because a square frustum's side is one. On a taper U is a FRACTION of the width rather
than a distance, so it shears across the face, and the exporter triangulates the quad and kinks that
shear at the diagonal. Pre-distortion cannot rescue it (README, "A TAPERED face cannot be rescued");
only V survives, because both triangles still map V to height.

So EXT_BASE, EXT_FACE, EXT_HIGH, WALL_LO, WALL_MID, WALL_UP and WALL_TOP are painted as strictly
horizontal art: courses, joints, arrises, seams, running side to side, uniform along U. No vertical
edge, no motif with a vertical axis, nothing whose left-right position has to mean anything. SPIRE
is on the list too — its drum tapers 2.1:1 — and RAMP_DECK/RAMP_FLANK are mildly tapered and were
going to be horizontal anyway.

That is a real design constraint and not a workaround: the building's vertical articulation lives
where it can be expressed, on the arrises, which the recipe dresses with neon strips off a different
page. The pyramid is horizontally coursed for the same reason `patrol_hut` is horizontally sided —
because the faces it lands on cannot carry anything else.

Every one of those seven panels is painted with the SAME real course height so the courses line up
across a band seam: 1.15 m outside and 1.6 m inside. The pixel pitch therefore differs per panel —
6.0 px on EXT_BASE against 7.2 on EXT_HIGH is the same 1.15 m of wall, because the bands are drawn
at different cm/px.

## The panels stretched along one axis, and which way that axis runs

Six more land on faces so long and thin that the art has to be uniform along the long axis and carry
all of its structure across the short one. Which axis that is comes from the MAPPING rather than from
the shape — `band_uv` runs V along a sweep where a box side face runs U along its width — so it is
worth writing down:

    BAR_FRONT   box side face   U = 20 m of counter, V = 1.15 m tall   185:1  -> horizontal courses
    FASCIA      free quad       U = 15.2 m of slab, V = 0.30 m tall     51:1  -> horizontal courses
    TRUSS       `band_uv`       U = 0.44 m section, V = 22 m of chord   71:1  -> vertical flutes
    STEP_SIDE   free quad       U = 3 m wide,  V = 25.8 m of raked run  43:1  -> vertical flutes
    POST        box side face   U = 0.12 m section, V = 1.05 m tall      9:1  -> vertical flutes
    RAIL        `band_uv`       U = the section, V = the run             9:1  -> vertical flutes

RISER and TREAD are on the same footing at 43:1 with U long, and are drawn horizontally.

BAR_TOP is the one panel with no safe axis: it dresses both the counter's top face, where V is the
20.4 m length, and the counter's edge band, where U is. So it is painted as a dark field with a hot
line just inside all four sampled edges — on the top that is a light-edged counter, on the edge band
it is a lit top and bottom reveal, and neither reading has any structure to get stretched. SHELF is
resolved the same way, and gets the glowing shelf edge it wanted for free.

STEP_SIDE, TRUSS_NODE, BOOTH_END, POST and RAIL are painted SYMMETRICALLY about the panel's middle,
because `mirror_y` copies the second stair flight with its corner order reversed — so the mirrored
flight samples those panels backwards, and any asymmetry in them shows up as two staircases that do
not match.

## The seven radially mapped panels, two of which want it

`radial_uv` maps circles in the page onto circles on the prop, which is normally the warning in this
library and here is the point twice over. SUN_DISC and SUN_RAY dress `disc()` faces and
`face_disc()` faces — the emblem over the front door and the black sun hanging in the oculus — so
concentric art in the panel lands as concentric rings on the sun. They are painted as a real sun:
a near-black body with a corona ring near the rim.

The corona's radius is set by the geometry rather than by eye. The rim maps to the circle inscribed
in the panel's SAMPLED box, and SUN_DISC is modelled proud of SUN_RAY at 2.85 m against 3.30 m in
the ceiling and 5.40 against 5.75 on the emblem — so all that is ever visible of SUN_RAY is its
outer 14%, and on the emblem only its outer 6%. The corona goes there. Everything inside is hidden
behind the disc and is kept warm rather than black, so the mip chain has nothing dark to drag out
into the ring.

The other five — PODIUM, TABLE_TOP, TABLE_STEM, STOOL and SPIRE — pick `radial_uv` up by accident,
because they are `drum()` caps, and for those concentric art is the trap it usually is: a stage top
with rings in it reads as a vinyl record. PODIUM, TABLE_TOP and STOOL are therefore painted with
irregular blobs, exactly as `_atlas.blob` exists to do; SPIRE's cap and TABLE_STEM's take the
banding and the flutes those two panels carry for their side faces, which come out as a brushed
finish on a cap rather than as rings. The one concentric mark on any of the five is TABLE_TOP's, at
0.9 of the radius, where a ring is a table edge.
"""

import math
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import blob, new_atlas, panels, scatter_blobs, speckle   # noqa: E402

SIZE = 512
OUT = os.path.join(ROOT, 'build', 'black_sun.png')

# `_lib.uv()` insets every mapped face by 2/128 of the page off its panel's edges so mip filtering
# cannot drag one panel into the next. On a 512 px page that is 8 px, and it means the outer 8 px of
# a 64 px cell is never SEEN — it exists only to bleed. Art that has to land in a known place goes
# through `at()`; art that only has to be there goes edge to edge so the margin carries it too.
INSET = 8
CELL = SIZE // 8
SEEN = CELL - 2 * INSET          # 48 px: the whole of what any face actually samples

GRID = panels(SIZE, 8, 8)
EXT_BASE, EXT_FACE, EXT_HIGH, EXT_RIB, JAMB, EXT_VENT, SUN_DISC, SUN_RAY = GRID[0]
RAMP_DECK, RAMP_FLANK, RAMP_UNDER, APRON, THRESH, SKIRT, RISER, TREAD = GRID[1]
WALL_LO, WALL_MID, WALL_UP, WALL_TOP, SOFFIT, BEAM, FASCIA, COVE = GRID[2]
FLOOR, FLOOR_EDGE, MEZZ_FLOOR, PODIUM, PODIUM_RIM, GRATE, LEDGE, INLAY = GRID[3]
BAR_FRONT, BAR_TOP, BACKBAR, SHELF, BAR_HOOD, STOOL, SPK_FACE, SPK_SIDE = GRID[4]
BOOTH_BACK, BOOTH_SEAT, BOOTH_END, TABLE_TOP, TABLE_STEM, POST, RAIL, NICHE = GRID[5]
TOWER, BEZEL, TRUSS, VAULT_UNDER, VAULT_TOP, SPIRE, DESK, DESK_TOP = GRID[6]
TRUSS_NODE, FIXTURE, LENS, DUCT, OCULUS, DARK, MAT, STEP_SIDE = GRID[7]

# ---- the palette ---------------------------------------------------------------------------------
#
# Structure lives between 12 and 44. Nothing here is neutral grey: the blacks carry blue-violet, the
# shadows carry cyan, and warmth only appears where a fitting is actually putting light on something.

VOID = (9, 10, 14)              # the darkest thing on the page — inside a joint, behind a grille
PITCH = (14, 15, 21)            # the building's own black
SHELL = (21, 22, 30)            # exterior skin
SHELL_HI = (33, 35, 46)
SHELL_LO = (13, 14, 20)
GRAPH = (26, 28, 36)            # cast concrete, ramp decks, soffits
GRAPH_HI = (42, 45, 56)
GRAPH_LO = (16, 17, 23)
SLATE = (30, 33, 42)            # dressed stone: floors, counters, treads
SLATE_HI = (48, 52, 64)
VIOLET = (27, 22, 40)           # the interior's shadow colour
VIOLET_HI = (47, 37, 70)
VIOLET_LO = (15, 12, 23)
CYAN_SH = (16, 30, 37)          # a cool shadow, where a cove is spilling onto something
CYAN_MID = (36, 78, 92)
MAG_SH = (34, 18, 32)
MAG_MID = (92, 32, 76)

# The lit end. Every one of these is used as a LINE, a pool, or one of the two bright panels.
CYAN_LIT = (128, 234, 248)
ICE_LIT = (214, 236, 248)
ICE_MID = (86, 108, 126)
MAG_LIT = (236, 92, 194)
AMBER_LIT = (240, 178, 88)
AMBER_MID = (104, 66, 30)
EMBER = (152, 76, 32)
GLASSY = (206, 224, 238)

rnd = random.Random(51224)
img, draw = new_atlas(SIZE)


# ---- the machinery -------------------------------------------------------------------------------
#
# ImageDraw has no clip region at all, so every one of these clamps to the panel it is given. A mark
# that overhangs is not lost, it is drawn into the neighbouring cell — where it becomes some other
# part of the building's paint, on a page that still looks fine at 1x.

def at(rect, u, v):
    """A panel's own 0-1 space to a page pixel, honouring the inset every mapped face gets.

    v=0 is the panel's BOTTOM in the image, because image space runs top-down and UV space runs
    bottom-up — so v is up the wall, up the riser, up the mast, the way the recipe means it.
    """
    x0, y0, x1, y1 = rect
    return (x0 + INSET + u * (x1 - x0 - 2 * INSET), y1 - INSET - v * (y1 - y0 - 2 * INSET))


def mix(a, b, t):
    """Linear blend between two RGB triples, clamped."""
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def slab(rect, ya, yb, colour):
    """A horizontal bar across the panel's FULL width, clamped to it. The full width matters: it puts
    the course into the 8 px bleed margin as well, so mip filtering has this panel's own art to drag
    inward instead of the neighbour's."""
    x0, y0, x1, y1 = rect
    a, b = max(y0, min(ya, yb)), min(y1 - 1, max(ya, yb))
    if b >= a:
        draw.rectangle((x0, a, x1 - 1, b), fill=colour)


def column(rect, xa, xb, colour):
    """The same, the other way up."""
    x0, y0, x1, y1 = rect
    a, b = max(x0, min(xa, xb)), min(x1 - 1, max(xa, xb))
    if b >= a:
        draw.rectangle((a, y0, b, y1 - 1), fill=colour)


def patch(rect, u0, v0, u1, v1, colour):
    """A rectangle in the panel's own 0-1 space, clamped to the panel."""
    x0, y0, x1, y1 = rect
    ax, ay = at(rect, u0, v0)
    bx, by = at(rect, u1, v1)
    lx, hx = max(x0, min(ax, bx)), min(x1 - 1, max(ax, bx))
    ly, hy = max(y0, min(ay, by)), min(y1 - 1, max(ay, by))
    if hx >= lx and hy >= ly:
        draw.rectangle((lx, ly, hx, hy), fill=colour)


def flat(rect, colour):
    draw.rectangle(rect, fill=colour)


def gradient(rect, low, high):
    """A vertical ramp filling the panel — `low` at v=0, `high` at the top. Every field on this page
    is either ramped or coursed, because a flat near-black rectangle reads as a hole in the model
    rather than as black architecture."""
    x0, y0, x1, y1 = rect
    span = max(1, y1 - 1 - y0)
    for y in range(y0, y1):
        draw.line([(x0, y), (x1 - 1, y)], fill=mix(low, high, (y1 - 1 - y) / span))


def wash_u(rect, left, right):
    """A horizontal ramp — `left` at u=0, `right` at u=1."""
    x0, y0, x1, y1 = rect
    span = max(1, x1 - 1 - x0)
    for x in range(x0, x1):
        draw.line([(x, y0), (x, y1 - 1)], fill=mix(left, right, (x - x0) / span))


def courses(rect, pitch, joint, lit, vary=None, chance=0.24):
    """Lapped horizontal courses over the whole panel, drawn up from its bottom edge.

    The caller fills the panel first, so a course run can sit on a ramp. Each course gets a recessed
    joint under it and a lit arris on the course below, which is the entire read: the joints are what
    make a black wall look panelised, and panelisation is what stops it looking like a decal.

    `pitch` is in PIXELS, which is a fixed number of metres on the face — the docstring's table is
    where that conversion lives, and it is why the same 1.15 m course is 6.0 px on EXT_BASE and
    7.2 px on EXT_HIGH.
    """
    x0, y0, x1, y1 = rect
    y = y1 - 1.0
    while y > y0 - pitch:
        if vary and rnd.random() < chance:
            # A few courses a shade off. Cladding weathers at different rates and a perfectly even
            # wall is the same tell as a perfectly even whorl of branches.
            slab(rect, y - pitch + 1.0, y, rnd.choice(vary))
        slab(rect, y - 0.9, y, joint)
        slab(rect, y - 1.9, y - 1.0, lit)
        y -= pitch


def flutes(rect, pitch, groove, lit, symmetric=False):
    """Vertical grooves at a fixed pitch, centred on the panel.

    Centred rather than started from an edge so the pattern is the same either way round; pass
    `symmetric` for the panels a mirrored face samples backwards, which lights both sides of each
    groove instead of only the one.
    """
    x0, y0, x1, y1 = rect
    cx = (x0 + x1) / 2.0
    n = int((x1 - x0) / pitch) + 2
    for i in range(-n, n + 1):
        x = cx + (i + 0.5) * pitch
        column(rect, x - 0.9, x, groove)
        column(rect, x + 0.1, x + 1.0, lit)
        if symmetric:
            column(rect, x - 2.0, x - 1.1, lit)


def edge_line(rect, colour, thickness=0.0, bleed=1.0):
    """A hot line just inside the SAMPLED area on all four sides, with a dimmer halo either side of
    it reaching out into the never-sampled margin.

    The halo is what keeps the line alive through the first mip level, where a single bright pixel is
    otherwise averaged straight back into the dark field behind it. It is a HALO rather than more of
    the same colour on purpose: a margin painted hot all the way out makes the whole cell glow once
    the chain gets down to 8 px, which turns a lit counter edge into a lit counter.

    `thickness` is EXTRA pixels: ImageDraw's rectangle is inclusive at both ends, so the default 0.0
    is a one-pixel line and 1.0 would be two. On BAR_TOP one pixel is 3.5 cm of counter edge.
    """
    ax, ay = at(rect, 0.0, 0.0)
    bx, by = at(rect, 1.0, 1.0)
    halo = mix(colour, VOID, 0.66)
    slab(rect, by - bleed, by + thickness + bleed, halo)
    slab(rect, ay - thickness - bleed, ay + bleed, halo)
    column(rect, ax - bleed, ax + thickness + bleed, halo)
    column(rect, bx - thickness - bleed, bx + bleed, halo)
    slab(rect, by, by + thickness, colour)
    slab(rect, ay - thickness, ay, colour)
    column(rect, ax, ax + thickness, colour)
    column(rect, bx - thickness, bx, colour)


def pool(rect, cx, cy, rx, ry, glow, gamma=1.7):
    """A soft pool of light, blended over whatever is already there and clamped by construction.

    Per-pixel rather than a stack of ellipses because a downlight's falloff is most of what makes it
    read as a lamp rather than as a painted dot, and because the clamp is then free.
    """
    x0, y0, x1, y1 = rect
    for y in range(max(y0, int(cy - ry)), min(y1, int(cy + ry) + 2)):
        for x in range(max(x0, int(cx - rx)), min(x1, int(cx + rx) + 2)):
            d = math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry)
            if d >= 1.0:
                continue
            img.putpixel((x, y), mix(img.getpixel((x, y))[:3], glow, (1.0 - d) ** gamma) + (255,))


def grain(rect, n, colours, size=(1, 1)):
    """Crumb noise, kept strictly inside the panel by `_atlas.speckle`."""
    speckle(draw, rnd, rect, n, colours, size=size)


def blotch(rect, n, colour, radius, margin=None):
    """Irregular patches — wear on a stage, sheen on a seat, dirt on a deck.

    `scatter_blobs` defaults to a 4 px margin, which is SMALLER than most of the blobs asked of it
    here, and a blob centred 4 px from the edge with a 7 px radius is drawn 3 px into the next panel.
    The margin is therefore always passed, and it is the largest radius times `blob`'s own worst-case
    lobe wobble of 1.22 — the radius alone is not enough, because a lobe reaches past it.
    """
    scatter_blobs(draw, rnd, rect, n, colour, radius,
                  margin=int(margin if margin is not None else radius[1] * 1.25 + 1))


def radial(rect, profile):
    """Paint a panel as a function of radius, for the faces `radial_uv` maps.

    `radial_uv` puts the cap's rim on the circle inscribed in the SAMPLED box, so radius 1.0 here is
    24 px from the panel's centre and the four corners beyond it are never sampled by a cap. They are
    still painted — they are what the rim's mip taps reach into.
    """
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    rim = SEEN / 2.0
    for y in range(y0, y1):
        for x in range(x0, x1):
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            img.putpixel((x, y),
                         profile(math.hypot(dx, dy) / rim, math.atan2(dy, dx)) + (255,))


# ---- row 0: the pyramid's skin, its one opening, and the mark over it ------------------------------

# The corona's angular flicker, drawn off the seeded stream ONCE so the two sun panels agree: a real
# corona is not an airbrush, and a perfectly even ring reads as a rendered gradient.
CORONA = [rnd.uniform(0.86, 1.10) for _ in range(96)]


def wobble(theta):
    """The flicker at an angle, interpolated so the ring has no facets in it."""
    t = (theta / (2 * math.pi) % 1.0) * len(CORONA)
    i = int(t)
    return CORONA[i % len(CORONA)] + (CORONA[(i + 1) % len(CORONA)] - CORONA[i % len(CORONA)]) * (t - i)


def disc_profile(d, theta):
    """SUN_DISC: the sun's BODY. Near-black, faintly banded, with an ember limb at its own rim.

    Concentric on purpose — this is one of the two panels `radial_uv` is being used for rather than
    worked around. The banding is a slow cosine rather than drawn rings so nothing in it reads as a
    groove; what should read as an edge is the limb, and only the limb.
    """
    if d > 1.0:
        return VOID
    body = mix(VOID, (24, 22, 34), 0.30 + 0.30 * (0.5 + 0.5 * math.cos(d * 31.0)))
    if d > 0.88:
        return mix(body, EMBER, min(1.0, (d - 0.88) / 0.12) * 0.42 * wobble(theta))
    return body


def ray_profile(d, theta):
    """SUN_RAY: the corona, which is all that is ever seen of this panel.

    SUN_DISC is modelled proud of it and covers everything inside d=0.86 in the ceiling and d=0.94 on
    the emblem, so the whole fitting lives in the outer band. What is hidden is kept warm rather than
    black for the mip chain's sake, and the ring is one of the four bright things on this page.
    """
    if d > 1.0:
        return VOID
    if d < 0.80:
        return mix(VOID, EMBER, 0.12)
    t = min(1.0, (d - 0.80) / 0.20) * wobble(theta)
    hot = mix(EMBER, AMBER_LIT, min(1.0, t * 1.7))
    return mix(hot, (255, 240, 212), max(0.0, t - 0.62) / 0.38)


def shell():
    """The three tapered exterior bands, the entrance reveal, and the black sun over the door.

    All three bands carry the same 1.15 m course at three different pixel pitches, so the coursing
    runs on through a band seam instead of stepping at it — which is the same reason `patrol_hut`
    sides three differently sized walls with one board height.
    """
    # EXT_BASE — the solid podium, 0 to 7.2 m. The heaviest coursing on the building, with a deeper
    # reveal every fourth course, and violet gathering at the foot where the snow meets it.
    gradient(EXT_BASE, mix(SHELL, VIOLET, 0.55), SHELL)
    courses(EXT_BASE, 6.0, VOID, SHELL_HI, vary=(SHELL_LO, SLATE), chance=0.22)
    for k in range(1, 9):
        y = EXT_BASE[3] - 1 - k * 24.0
        slab(EXT_BASE, y - 1.6, y, VOID)
        slab(EXT_BASE, y - 2.7, y - 1.7, mix(SHELL_HI, VIOLET_HI, 0.45))
    slab(EXT_BASE, EXT_BASE[3] - 4, EXT_BASE[3] - 1, mix(VOID, VIOLET, 0.5))
    grain(EXT_BASE, 90, (SHELL_HI, SHELL_LO, VIOLET))

    # EXT_FACE — the middle. Same course, finer joints, and a flatter value: this is the band the
    # portal is cut out of and the one seen from furthest away.
    gradient(EXT_FACE, SHELL, mix(SHELL, PITCH, 0.35))
    courses(EXT_FACE, 6.6, VOID, mix(SHELL_HI, SHELL, 0.4), vary=(SHELL_LO, SHELL), chance=0.18)
    for k in range(1, 8):
        slab(EXT_FACE, EXT_FACE[3] - 1 - k * 19.8 - 1.2, EXT_FACE[3] - 1 - k * 19.8, VOID)
    grain(EXT_FACE, 80, (SHELL_HI, SHELL_LO))

    # EXT_HIGH — near the apex, where the face is 25 m wide at the bottom and 1 m at the top. Darkest
    # of the three, because nothing up there catches anything but sky.
    gradient(EXT_HIGH, mix(SHELL, PITCH, 0.4), mix(PITCH, VOID, 0.4))
    courses(EXT_HIGH, 7.2, VOID, mix(SHELL_HI, PITCH, 0.5), vary=(SHELL_LO, PITCH), chance=0.16)
    grain(EXT_HIGH, 70, (SHELL, VOID))

    # EXT_RIB — reserve: a raised arris rib. A rib is swept, so `band_uv` would run V along its
    # length and all of its structure has to be across U.
    flat(EXT_RIB, mix(SHELL, PITCH, 0.5))
    flutes(EXT_RIB, 7.0, VOID, mix(SHELL_HI, SHELL, 0.6), symmetric=True)
    grain(EXT_RIB, 50, (SHELL, VOID))

    # JAMB — the 1.6 m reveal through the wall, on both the head and the two sides. u=0 is INSIDE the
    # club and u=1 is out on the ramp for all three faces, which is what lets the reveal be drawn as
    # one directional gradient instead of a symmetric one.
    wash_u(JAMB, VOID, mix(GRAPH, CYAN_SH, 0.35))
    column(JAMB, at(JAMB, 0.13, 0)[0], at(JAMB, 0.13, 0)[0] + 1.6, VOID)      # the shadow groove
    column(JAMB, at(JAMB, 0.80, 0)[0], at(JAMB, 0.80, 0)[0] + 1.2, mix(CYAN_MID, ICE_LIT, 0.45))
    column(JAMB, at(JAMB, 0.86, 0)[0], at(JAMB, 0.86, 0)[0] + 1.0, CYAN_SH)
    grain(JAMB, 60, (GRAPH_HI, VOID))

    # EXT_VENT — reserve: a louvred plant vent. Louvres are horizontal, so it can live on a tapered
    # band if it ever has to.
    flat(EXT_VENT, VOID)
    for k in range(12):
        y = EXT_VENT[3] - 3 - k * 5.0
        slab(EXT_VENT, y - 1.4, y, mix(SHELL_HI, GRAPH, 0.5))
        slab(EXT_VENT, y - 3.4, y - 1.5, VOID)
    grain(EXT_VENT, 40, (GRAPH, VOID))

    radial(SUN_DISC, disc_profile)
    radial(SUN_RAY, ray_profile)


# ---- row 1: the approach, the threshold and the two flights ---------------------------------------

def approach():
    """Everything a rider crosses on the way in, plus the stairs to the mezzanine.

    RAMP_DECK's V runs ALONG the run and its U across the fan, so a horizontal line in the panel is a
    transverse band on the ramp — which is both what the taper allows and what a ramp deck actually
    wants. The panel repeats once per ramp band, so those bands land as a 4 m rhythm the whole way up
    rather than as one drawn-once pattern stretched over 24 m.
    """
    gradient(RAMP_DECK, mix(GRAPH, VIOLET, 0.25), GRAPH)
    courses(RAMP_DECK, 3.2, VOID, GRAPH_HI, vary=(GRAPH_LO,), chance=0.30)      # 28 cm grip ribs
    for k in range(1, 5):                                                       # 1 m expansion joints
        y = RAMP_DECK[3] - 1 - k * 12.8
        slab(RAMP_DECK, y - 1.8, y, VOID)
        slab(RAMP_DECK, y - 2.8, y - 1.9, mix(GRAPH_HI, CYAN_SH, 0.5))
    blotch(RAMP_DECK, 5, GRAPH_LO, (3.0, 6.0))                                  # board scuffing
    grain(RAMP_DECK, 110, (GRAPH_HI, GRAPH_LO, VIOLET))

    # RAMP_FLANK — the wedge's side, whose V is its depth to the snow. Battered courses, dirtier at
    # the bottom, and the same 1 m rhythm as the deck so the two agree at the arris.
    gradient(RAMP_FLANK, mix(VOID, VIOLET, 0.55), mix(GRAPH, SHELL, 0.5))
    courses(RAMP_FLANK, 5.4, VOID, mix(GRAPH_HI, SHELL_HI, 0.5), vary=(GRAPH_LO, SHELL), chance=0.22)
    slab(RAMP_FLANK, RAMP_FLANK[3] - 5, RAMP_FLANK[3] - 1, mix(VOID, VIOLET, 0.35))
    grain(RAMP_FLANK, 80, (GRAPH, VOID))

    # RAMP_UNDER — the underside of a closed wedge sitting on the snow. Nobody sees it; it is dark,
    # and it is still coursed, because DARK-flat is what a hole in the model looks like.
    flat(RAMP_UNDER, mix(VOID, PITCH, 0.5))
    courses(RAMP_UNDER, 8.0, VOID, mix(PITCH, GRAPH, 0.4))
    grain(RAMP_UNDER, 60, (PITCH, VOID))

    # APRON — reserve: the snow apron at the foot of the ramp, where grit gets tracked out of it.
    gradient(APRON, mix(GRAPH, VIOLET, 0.35), mix(GRAPH, SLATE, 0.4))
    blotch(APRON, 7, GRAPH_LO, (3.0, 6.5))
    blotch(APRON, 5, mix(SLATE, ICE_MID, 0.25), (2.0, 4.5))
    grain(APRON, 130, (SLATE, GRAPH_LO, VOID))

    # THRESH — the doorway underfoot, 1.6 m of reveal across U and 14 m of opening down V. All of its
    # structure is therefore across U: a plate with a drainage groove outside and a lit inner arris.
    wash_u(THRESH, mix(SLATE, CYAN_SH, 0.4), mix(GRAPH, VIOLET, 0.3))
    column(THRESH, at(THRESH, 0.10, 0)[0], at(THRESH, 0.10, 0)[0] + 1.4,
           mix(CYAN_MID, ICE_LIT, 0.35))
    column(THRESH, at(THRESH, 0.62, 0)[0], at(THRESH, 0.62, 0)[0] + 2.2, VOID)
    column(THRESH, at(THRESH, 0.72, 0)[0], at(THRESH, 0.72, 0)[0] + 1.0, GRAPH_HI)
    grain(THRESH, 90, (SLATE_HI, GRAPH_LO))

    # SKIRT — reserve: the ramp's ground skirt where it meets uneven terrain.
    gradient(SKIRT, VOID, mix(GRAPH, SHELL, 0.4))
    courses(SKIRT, 4.6, VOID, mix(GRAPH_HI, SHELL, 0.5), vary=(GRAPH_LO,), chance=0.25)
    grain(SKIRT, 70, (GRAPH, VOID))

    # RISER — 3 m wide and 29 cm tall on the page's V, which is 43:1 and forces the art to be uniform
    # across the flight. The lit nosing is the one bright thing on the stairs, and it is 3 cm of step:
    # five sampled pixels at the top of the band, then three pixels of halo carried into the margin so
    # the line survives the first mip level, then dark. Carrying the hot colour all the way out
    # instead would light the whole riser at distance, which is the opposite of what a nosing is for.
    gradient(RISER, VOID, mix(GRAPH, VIOLET, 0.4))
    slab(RISER, at(RISER, 0, 0.55)[1], at(RISER, 0, 0.35)[1], mix(GRAPH_LO, VIOLET, 0.4))
    slab(RISER, at(RISER, 0, 0.90)[1], at(RISER, 0, 0.86)[1], mix(CYAN_MID, VOID, 0.4))
    nose = mix(CYAN_LIT, ICE_LIT, 0.5)
    slab(RISER, at(RISER, 0, 1.0)[1] - 1.5, at(RISER, 0, 0.92)[1], nose)
    slab(RISER, at(RISER, 0, 1.0)[1] - 4.0, at(RISER, 0, 1.0)[1] - 1.6, mix(nose, VOID, 0.55))
    grain(RISER, 40, (GRAPH_HI, VOID))

    # TREAD — 3 m wide and 70 cm of going. v=0 is the nosing edge (the quad runs front to back), so
    # the leading band is the lit one and the grain coarsens toward the back of the step.
    gradient(TREAD, mix(SLATE, CYAN_SH, 0.3), mix(GRAPH, VIOLET, 0.35))
    slab(TREAD, TREAD[3] - 1, at(TREAD, 0, 0.06)[1], mix(ICE_MID, CYAN_MID, 0.5))
    slab(TREAD, at(TREAD, 0, 0.10)[1], at(TREAD, 0, 0.07)[1], VOID)
    for k in range(1, 7):                                    # grip lines running across the step
        y = at(TREAD, 0, 0.10 + 0.13 * k)[1]
        slab(TREAD, y - 0.9, y, mix(VOID, GRAPH, 0.5))
    grain(TREAD, 90, (SLATE_HI, GRAPH_LO))


# ---- row 2: the room itself -----------------------------------------------------------------------

def room():
    """The four raked interior bands, the balcony's underside and its edge.

    WALL_LO..WALL_TOP are the other four tapered panels, so they are coursed exactly as the exterior
    is — and at one shared real course height of 1.6 m, which is 9.4 px at the bottom of the atrium
    and 10.1 px at the top because those bands are drawn at different cm/px. A rider standing on the
    dance floor sees all four at once, stacked, over 25.8 m of atrium: if the courses did not line up
    through the seams the rake would read as four separate walls.

    Value falls as the wall climbs, and the colour goes with it: magenta near the floor where the cove
    at L2 is bouncing off it, violet through the middle, and cyan at the very top where the oculus
    corona is the only thing reaching that far.
    """
    gradient(WALL_LO, mix(VIOLET, MAG_SH, 0.45), VIOLET)
    courses(WALL_LO, 9.4, VOID, mix(VIOLET_HI, MAG_MID, 0.30), vary=(VIOLET_LO, MAG_SH), chance=0.20)
    slab(WALL_LO, WALL_LO[3] - 3, WALL_LO[3] - 1, mix(MAG_MID, VOID, 0.45))   # the cove's own bounce
    grain(WALL_LO, 90, (VIOLET_HI, VIOLET_LO, MAG_SH))

    gradient(WALL_MID, VIOLET, mix(VIOLET, PITCH, 0.35))
    courses(WALL_MID, 8.9, VOID, VIOLET_HI, vary=(VIOLET_LO, PITCH), chance=0.20)
    grain(WALL_MID, 80, (VIOLET_HI, VIOLET_LO))

    gradient(WALL_UP, mix(VIOLET, PITCH, 0.45), mix(PITCH, VIOLET_LO, 0.4))
    courses(WALL_UP, 9.1, VOID, mix(VIOLET_HI, PITCH, 0.45), vary=(VIOLET_LO, VOID), chance=0.18)
    grain(WALL_UP, 70, (VIOLET, VOID))

    gradient(WALL_TOP, mix(PITCH, VIOLET_LO, 0.5), mix(VOID, CYAN_SH, 0.35))
    courses(WALL_TOP, 10.1, VOID, mix(CYAN_SH, VIOLET_HI, 0.5), vary=(VOID, VIOLET_LO), chance=0.16)
    slab(WALL_TOP, WALL_TOP[1], WALL_TOP[1] + 3, mix(CYAN_SH, CYAN_MID, 0.35))   # the oculus, spilling
    grain(WALL_TOP, 60, (CYAN_SH, VOID))

    # SOFFIT — the mezzanine's underside, seen from the dance floor 9.8 m below. Nearly square and not
    # tapered, so this is one of the few panels on the building that can carry a real two-dimensional
    # pattern: a coffer joint round the edge and one downlight in the middle. It repeats once per
    # 1.9 m segment, which turns the single lamp into an even grid across the whole balcony — a
    # regular repeat is normally the trap here, and on a ceiling it is the intent.
    gradient(SOFFIT, mix(PITCH, VIOLET, 0.4), PITCH)
    for u in (0.0, 1.0):
        column(SOFFIT, at(SOFFIT, u, 0)[0] - 1.0, at(SOFFIT, u, 0)[0] + 1.0, VOID)
    for v in (0.0, 1.0):
        slab(SOFFIT, at(SOFFIT, 0, v)[1] - 1.0, at(SOFFIT, 0, v)[1] + 1.0, VOID)
    cx, cy = at(SOFFIT, 0.5, 0.5)
    pool(SOFFIT, cx, cy, 11.0, 11.0, mix(AMBER_MID, VIOLET, 0.35), gamma=2.2)
    pool(SOFFIT, cx, cy, 4.2, 4.2, AMBER_LIT, gamma=1.5)
    grain(SOFFIT, 70, (VIOLET_HI, VOID))

    # BEAM — reserve: a structural beam. Swept, so `band_uv` runs V along its length and everything
    # it can say has to be said across U.
    flat(BEAM, mix(PITCH, GRAPH, 0.5))
    flutes(BEAM, 9.0, VOID, GRAPH_HI, symmetric=True)
    grain(BEAM, 50, (GRAPH, VOID))

    # FASCIA — 15.2 m of slab edge over the atrium, 30 cm tall: 50:1, and the sampled band is 48 px
    # for 30 cm of concrete. That is room for exactly three lines — a lit top arris catching the
    # mezzanine floor, the body, and the shadow the slab casts on itself — and anything more would be
    # detail nobody can resolve smeared over fifteen metres.
    gradient(FASCIA, VOID, mix(GRAPH, VIOLET, 0.4))
    slab(FASCIA, FASCIA[1], at(FASCIA, 0, 0.88)[1], mix(GRAPH_HI, VIOLET_HI, 0.4))
    slab(FASCIA, at(FASCIA, 0, 0.88)[1], at(FASCIA, 0, 0.82)[1], VOID)
    slab(FASCIA, at(FASCIA, 0, 0.14)[1], at(FASCIA, 0, 0.06)[1], mix(VIOLET_HI, MAG_MID, 0.4))
    grain(FASCIA, 50, (VIOLET_HI, VOID))

    # COVE — reserve: a light channel's own section, which is horizontal by construction.
    gradient(COVE, mix(PITCH, VIOLET, 0.5), VOID)
    slab(COVE, at(COVE, 0, 0.62)[1], at(COVE, 0, 0.38)[1], VOID)
    slab(COVE, at(COVE, 0, 0.56)[1], at(COVE, 0, 0.44)[1], mix(CYAN_SH, CYAN_MID, 0.5))
    slab(COVE, at(COVE, 0, 0.70)[1], at(COVE, 0, 0.66)[1], mix(VIOLET_HI, CYAN_MID, 0.35))
    grain(COVE, 50, (VIOLET_HI, VOID))


# ---- row 3: everything you stand on ----------------------------------------------------------------

def decks():
    """The dance floor, the balcony deck and the DJ stage.

    FLOOR tiles 8x8 over the 45 m footprint, so this panel is seen sixty-four times side by side and
    anything distinctive in it becomes a polka-dot grid. It gets a joint at its own edge — which lands
    as a 6 m slab pattern across the whole floor — a fainter joint down the middle, and nothing else
    but grain and a couple of long reflections.
    """
    gradient(FLOOR, mix(SLATE, VIOLET, 0.45), mix(SLATE, CYAN_SH, 0.30))
    for u in (0.0, 1.0):
        column(FLOOR, at(FLOOR, u, 0)[0] - 1.0, at(FLOOR, u, 0)[0] + 1.0, VOID)
    for v in (0.0, 1.0):
        slab(FLOOR, at(FLOOR, 0, v)[1] - 1.0, at(FLOOR, 0, v)[1] + 1.0, VOID)
    column(FLOOR, at(FLOOR, 0.5, 0)[0], at(FLOOR, 0.5, 0)[0] + 0.9, mix(VOID, SLATE, 0.5))
    slab(FLOOR, at(FLOOR, 0, 0.5)[1], at(FLOOR, 0, 0.5)[1] + 0.9, mix(VOID, SLATE, 0.5))
    blotch(FLOOR, 4, mix(SLATE_HI, CYAN_SH, 0.5), (3.0, 7.0))     # polish, catching the rig
    grain(FLOOR, 130, (SLATE_HI, GRAPH_LO, VIOLET))

    # FLOOR_EDGE — the perimeter ring of that tiling. Darker and grubbier, and deliberately WITHOUT a
    # gradient toward the wall: the ring runs round all four sides, so a directional wash would point
    # the right way on one side of the room and the wrong way on the other three.
    gradient(FLOOR_EDGE, mix(GRAPH, VIOLET, 0.5), mix(GRAPH, SLATE, 0.4))
    for u in (0.0, 1.0):
        column(FLOOR_EDGE, at(FLOOR_EDGE, u, 0)[0] - 1.0, at(FLOOR_EDGE, u, 0)[0] + 1.0, VOID)
    for v in (0.0, 1.0):
        slab(FLOOR_EDGE, at(FLOOR_EDGE, 0, v)[1] - 1.0, at(FLOOR_EDGE, 0, v)[1] + 1.0, VOID)
    blotch(FLOOR_EDGE, 6, GRAPH_LO, (3.0, 6.5))
    grain(FLOOR_EDGE, 150, (SLATE, GRAPH_LO, VIOLET_LO))

    # MEZZ_FLOOR — the balcony deck, 1.9 m of panel. Same treatment at a finer joint, and uniform for
    # the same reason FLOOR_EDGE is: it also dresses the corner bays, where U and V both run outward.
    gradient(MEZZ_FLOOR, mix(GRAPH, VIOLET, 0.55), mix(GRAPH, VIOLET, 0.25))
    for u in (0.0, 1.0):
        column(MEZZ_FLOOR, at(MEZZ_FLOOR, u, 0)[0] - 0.9, at(MEZZ_FLOOR, u, 0)[0] + 0.9, VOID)
    for v in (0.0, 1.0):
        slab(MEZZ_FLOOR, at(MEZZ_FLOOR, 0, v)[1] - 0.9, at(MEZZ_FLOOR, 0, v)[1] + 0.9, VOID)
    blotch(MEZZ_FLOOR, 5, VIOLET_LO, (2.5, 5.5))
    grain(MEZZ_FLOOR, 120, (VIOLET_HI, GRAPH_LO))

    # PODIUM — the stage top, and a `drum()` cap, so `radial_uv` maps it. Concentric art here would
    # land as concentric rings on a 15 m stage and read as a vinyl record; it gets irregular blobs
    # instead, which is what `_atlas.blob` exists for.
    gradient(PODIUM, mix(PITCH, VIOLET, 0.45), mix(PITCH, GRAPH, 0.5))
    blotch(PODIUM, 9, VOID, (4.0, 9.0))
    blotch(PODIUM, 6, mix(GRAPH_HI, VIOLET_HI, 0.5), (3.0, 6.0))
    blob(draw, rnd, *at(PODIUM, 0.44, 0.52), 7.0, 5.5, mix(GRAPH, MAG_SH, 0.5), lobes=9)
    grain(PODIUM, 130, (GRAPH_HI, VOID, VIOLET))

    # PODIUM_RIM — 4.6 m of stage edge per face, 1.3 m tall. Horizontal, with one thin magenta line
    # under the nosing: a stage a rider is meant to read the height of from across the room needs its
    # edge drawn, and this is the cheapest possible way to draw it.
    gradient(PODIUM_RIM, VOID, mix(GRAPH, VIOLET, 0.45))
    courses(PODIUM_RIM, 11.0, VOID, mix(GRAPH_HI, VIOLET_HI, 0.5))
    slab(PODIUM_RIM, at(PODIUM_RIM, 0, 0.90)[1], at(PODIUM_RIM, 0, 0.86)[1], mix(MAG_MID, MAG_LIT, 0.35))
    slab(PODIUM_RIM, at(PODIUM_RIM, 0, 0.86)[1], at(PODIUM_RIM, 0, 0.80)[1], MAG_SH)
    grain(PODIUM_RIM, 70, (VIOLET_HI, VOID))

    # GRATE — reserve: a floor grate over a service void. Bars both ways, black underneath.
    flat(GRATE, VOID)
    for k in range(11):
        x = GRATE[0] + 2.0 + k * 5.6
        column(GRATE, x, x + 2.4, mix(GRAPH, SLATE, 0.5))
    for k in range(11):
        y = GRATE[1] + 2.0 + k * 5.6
        slab(GRATE, y, y + 1.2, mix(GRAPH_LO, GRAPH, 0.5))
    grain(GRATE, 90, (GRAPH_HI, VOID))

    # LEDGE — the outboard band of the balcony ring, behind the booths. This one CAN take a wash,
    # because it is only ever laid on the ring bands: `top = [(d0, a0), (d1, a0), ...]` puts u=0
    # inboard and u=1 hard against the raked wall on all four sides, so violet gathering at u=1 lands
    # under the rake every time.
    wash_u(LEDGE, mix(GRAPH, VIOLET, 0.4), mix(VIOLET, VOID, 0.35))
    for v in (0.0, 1.0):
        slab(LEDGE, at(LEDGE, 0, v)[1] - 0.9, at(LEDGE, 0, v)[1] + 0.9, VOID)
    column(LEDGE, at(LEDGE, 0.90, 0)[0], at(LEDGE, 0.90, 0)[0] + 1.2, mix(VIOLET_HI, MAG_MID, 0.4))
    grain(LEDGE, 100, (VIOLET_HI, VOID))

    # INLAY — reserve: an inlaid figure in the dance floor.
    gradient(INLAY, mix(SLATE, VIOLET, 0.5), mix(GRAPH, CYAN_SH, 0.4))
    for k in range(4):
        t = 0.10 + 0.11 * k
        column(INLAY, at(INLAY, t, 0)[0], at(INLAY, t, 0)[0] + 1.2, mix(CYAN_SH, CYAN_MID, 0.45))
        column(INLAY, at(INLAY, 1.0 - t, 0)[0], at(INLAY, 1.0 - t, 0)[0] + 1.2,
               mix(CYAN_SH, CYAN_MID, 0.45))
    slab(INLAY, at(INLAY, 0, 0.52)[1], at(INLAY, 0, 0.48)[1], mix(CYAN_MID, ICE_MID, 0.4))
    grain(INLAY, 100, (SLATE_HI, VOID))


# ---- row 4: the bar, along the back wall -----------------------------------------------------------

def counter():
    """Twenty metres of counter, the bottle wall behind it, and the stacks either side of the floor.

    BAR_FRONT is the most stretched panel on the building at 185:1 — one panel over 20 m of length and
    1.15 m of height. Its U is the length, so every line in it runs the whole way along the counter and
    nothing may vary with U at all. That is not a limitation to work around: a bar front IS a run of
    horizontal reveals, and the toe recess, the two body reveals and the shadow under the counter are
    the whole fitting.
    """
    gradient(BAR_FRONT, VOID, mix(GRAPH, VIOLET, 0.4))
    slab(BAR_FRONT, at(BAR_FRONT, 0, 0.16)[1], at(BAR_FRONT, 0, 0.0)[1], VOID)          # toe recess
    slab(BAR_FRONT, at(BAR_FRONT, 0, 0.11)[1], at(BAR_FRONT, 0, 0.08)[1],
         mix(CYAN_SH, CYAN_MID, 0.55))                                                  # its own light
    for v in (0.42, 0.70):
        slab(BAR_FRONT, at(BAR_FRONT, 0, v)[1], at(BAR_FRONT, 0, v - 0.03)[1], VOID)
        slab(BAR_FRONT, at(BAR_FRONT, 0, v + 0.03)[1], at(BAR_FRONT, 0, v)[1],
             mix(GRAPH_HI, VIOLET_HI, 0.4))
    slab(BAR_FRONT, BAR_FRONT[1], at(BAR_FRONT, 0, 0.94)[1], VOID)                      # under the top
    grain(BAR_FRONT, 90, (GRAPH_HI, VOID, VIOLET))

    # BAR_TOP — the panel with no safe axis. It dresses the counter's top face, where V is the 20.4 m
    # length, AND the 11 cm edge band, where U is: whichever way art were drawn it would be stretched
    # forty-two centimetres per pixel one way round. So it carries no structure at all — a dark honed
    # field with a hot line just inside all four sampled edges, which is a light-edged counter seen
    # from above and a lit top-and-bottom reveal seen from the floor.
    gradient(BAR_TOP, mix(SLATE, VIOLET, 0.35), mix(SLATE, CYAN_SH, 0.30))
    blotch(BAR_TOP, 5, mix(SLATE_HI, CYAN_SH, 0.4), (3.0, 6.0))
    grain(BAR_TOP, 120, (SLATE_HI, GRAPH_LO))
    edge_line(BAR_TOP, mix(ICE_LIT, CYAN_LIT, 0.45))

    # BACKBAR — the backlit bottle wall, painted onto the rake rather than modelled, and one of the two
    # panels on this page allowed to be a bright FIELD: it is a light fitting seen face-on, and the
    # club's whole back wall is this. At 37.5 cm/px along U a bottle is 0.2 px wide, so there are no
    # bottles here — there is the RHYTHM of bottles: four horizontal glow rows at 1.08 m centres,
    # modulated across U at a 1.5 m bay with a darker mullion every 4.5 m. The physical shelves in
    # front of it silhouette against this.
    x0, y0, x1, y1 = BACKBAR
    for x in range(x0, x1):
        u = x - x0
        bay = 0.62 + 0.38 * (0.5 + 0.5 * math.cos(2 * math.pi * u / 4.0)) ** 0.7
        if u % 12 < 1.4:
            bay *= 0.34                       # the mullion between bays
        for y in range(y0, y1):
            d = abs(((y - y0 + 6.0) % 12.0) - 6.0) / 6.0
            lit = max(0.0, 1.0 - d) ** 1.6
            base = mix(mix(VIOLET, MAG_SH, 0.4), AMBER_MID, 0.35)
            hue = mix(base, mix(AMBER_LIT, MAG_LIT, 0.18), lit * bay)
            img.putpixel((x, y), mix(hue, (255, 236, 206), max(0.0, lit - 0.86) / 0.14 * bay) + (255,))
    grain(BACKBAR, 150, (mix(AMBER_LIT, EMBER, 0.5), MAG_MID, EMBER))

    # SHELF — 17 m of shelf lip, 12 cm tall, and the same two-long-axes problem as BAR_TOP: the front
    # face runs U long and the shelf's own top face runs V long. Same answer, and it happens to be
    # exactly the glowing shelf edge the fitting wants.
    gradient(SHELF, VOID, mix(GRAPH, VIOLET, 0.35))
    grain(SHELF, 60, (GRAPH_HI, VOID))
    edge_line(SHELF, mix(AMBER_LIT, ICE_LIT, 0.35))

    # BAR_HOOD — the soffit over the counter and its own fascia. Six downlights over 20 m, at v=0.5 so
    # the same rhythm reads as a run of lamps on the underside and as light leaking along the fascia's
    # middle. A pool per 3.3 m of hood.
    gradient(BAR_HOOD, mix(PITCH, VIOLET, 0.4), PITCH)
    for v in (0.0, 1.0):
        slab(BAR_HOOD, at(BAR_HOOD, 0, v)[1] - 0.9, at(BAR_HOOD, 0, v)[1] + 0.9, VOID)
    for k in range(6):
        cx = at(BAR_HOOD, (k + 0.5) / 6.0, 0.5)[0]
        cy = at(BAR_HOOD, 0.0, 0.5)[1]
        pool(BAR_HOOD, cx, cy, 4.6, 9.0, mix(AMBER_MID, EMBER, 0.35), gamma=2.0)
        pool(BAR_HOOD, cx, cy, 1.8, 3.4, AMBER_LIT, gamma=1.4)
    grain(BAR_HOOD, 60, (AMBER_MID, VOID))

    # STOOL — a `drum()` with radial caps top and bottom, so irregular only. Dark leather.
    gradient(STOOL, mix(VOID, VIOLET, 0.5), mix(PITCH, VIOLET, 0.45))
    blotch(STOOL, 6, VOID, (3.0, 6.0))
    blotch(STOOL, 4, mix(VIOLET_HI, MAG_SH, 0.5), (2.0, 4.0))
    grain(STOOL, 90, (VIOLET_HI, VOID))

    # SPK_FACE — the grille. A 6 cm perforation is 1.5 px, so the mesh is drawn as a dot lattice at
    # 3 px, with two horizontal rails and a frame; the same panel dresses stacks of three different
    # sizes, so there is no driver ring in it to come out the wrong size on two of them.
    flat(SPK_FACE, VOID)
    patch(SPK_FACE, 0.06, 0.06, 0.94, 0.94, mix(PITCH, GRAPH, 0.45))
    fx0, fy1 = at(SPK_FACE, 0.06, 0.06)
    fx1, fy0 = at(SPK_FACE, 0.94, 0.94)
    for gy in range(int(fy0) + 1, int(fy1), 3):
        for gx in range(int(fx0) + 1, int(fx1), 3):
            draw.point((gx, gy), fill=VOID)
            draw.point((gx + 1, gy + 1), fill=mix(GRAPH_HI, SLATE, 0.5))
    for v in (0.34, 0.66):
        slab(SPK_FACE, at(SPK_FACE, 0, v)[1], at(SPK_FACE, 0, v)[1] + 1.4, VOID)
    edge_line(SPK_FACE, mix(GRAPH_HI, VIOLET_HI, 0.5))
    grain(SPK_FACE, 60, (GRAPH_HI, VOID))

    # SPK_SIDE — the cabinet. Nearly flat by design: a box that reads as one dark mass is right, and
    # the corner bracing is the only thing on it.
    gradient(SPK_SIDE, mix(VOID, PITCH, 0.6), mix(PITCH, GRAPH, 0.35))
    edge_line(SPK_SIDE, mix(GRAPH, VIOLET_HI, 0.4), thickness=1.4)
    for u in (0.16, 0.84):
        column(SPK_SIDE, at(SPK_SIDE, u, 0)[0], at(SPK_SIDE, u, 0)[0] + 1.0, VOID)
    grain(SPK_SIDE, 80, (GRAPH, VOID))


# ---- row 5: the booths and the balcony rail ---------------------------------------------------------

def table_profile(d, theta):
    """TABLE_TOP: a `drum()` cap, so radially mapped — but a table edge IS a ring, and it is the one
    concentric mark any of the five accidental radial panels is allowed."""
    if d > 1.0:
        return VOID
    if d > 0.90:
        return mix(VIOLET_HI, MAG_MID, 0.45)
    if d > 0.84:
        return VOID
    return mix(PITCH, VIOLET, 0.35 + 0.25 * d)


def upstairs():
    """Four booths a side, their tables, and the glass rail's frame.

    The booths sit against the rake, which is their own ceiling — 2.5 m of headroom at the seat back
    and 5.5 at the table. What that means for the art is that BOOTH_BACK is seen from close range and
    slightly below, so the upholstery is drawn as real 40 cm channels rather than as a texture.
    """
    gradient(BOOTH_BACK, mix(VOID, VIOLET, 0.6), mix(VIOLET, MAG_SH, 0.35))
    flutes(BOOTH_BACK, 6.0, VOID, mix(VIOLET_HI, MAG_SH, 0.5))
    slab(BOOTH_BACK, BOOTH_BACK[1], at(BOOTH_BACK, 0, 0.94)[1], mix(MAG_SH, MAG_MID, 0.5))
    slab(BOOTH_BACK, at(BOOTH_BACK, 0, 0.96)[1], at(BOOTH_BACK, 0, 0.94)[1],
         mix(MAG_MID, MAG_LIT, 0.30))                       # the booth's own bar, just catching the top
    grain(BOOTH_BACK, 90, (VIOLET_HI, VOID))

    # BOOTH_SEAT — the seat cushion and the top of its back. It lands on faces whose long axis runs
    # both ways depending on which box it is, so it gets a quilt: a seam grid reads the same either
    # way round and cannot be stretched into stripes.
    gradient(BOOTH_SEAT, mix(PITCH, VIOLET, 0.5), mix(VIOLET, VIOLET_HI, 0.25))
    for k in range(1, 6):
        column(BOOTH_SEAT, BOOTH_SEAT[0] + k * 10.6, BOOTH_SEAT[0] + k * 10.6 + 0.9, VIOLET_LO)
        slab(BOOTH_SEAT, BOOTH_SEAT[1] + k * 10.6, BOOTH_SEAT[1] + k * 10.6 + 0.9, VIOLET_LO)
    blotch(BOOTH_SEAT, 6, mix(VIOLET_HI, MAG_SH, 0.4), (2.5, 5.0))
    grain(BOOTH_SEAT, 110, (VIOLET_HI, VOID))

    # BOOTH_END — the divider ends, which sit at both +a and -a of every booth and are therefore seen
    # mirrored. Symmetric, or the two ends of one booth do not match.
    gradient(BOOTH_END, mix(VOID, VIOLET, 0.5), mix(PITCH, VIOLET, 0.5))
    for u in (0.10, 0.90):
        column(BOOTH_END, at(BOOTH_END, u, 0)[0], at(BOOTH_END, u, 0)[0] + 1.2,
               mix(VIOLET_HI, MAG_MID, 0.35))
    for u in (0.16, 0.84):
        column(BOOTH_END, at(BOOTH_END, u, 0)[0], at(BOOTH_END, u, 0)[0] + 1.0, VOID)
    grain(BOOTH_END, 70, (VIOLET_HI, VOID))

    radial(TABLE_TOP, table_profile)
    blotch(TABLE_TOP, 5, VOID, (2.5, 5.0))
    blotch(TABLE_TOP, 4, VIOLET_HI, (2.0, 3.5))
    grain(TABLE_TOP, 80, (VIOLET_HI, VOID))

    # TABLE_STEM — the stem's side band and the table's underside cap. Fine vertical grain reads as a
    # turned stem on one and as a brushed underside on the other.
    flat(TABLE_STEM, mix(VOID, PITCH, 0.5))
    flutes(TABLE_STEM, 4.0, VOID, mix(GRAPH, VIOLET_HI, 0.5), symmetric=True)
    grain(TABLE_STEM, 60, (GRAPH, VOID))

    # POST — the rail's mullions: 12 cm of section across U against 1.05 m up V, and every post on the
    # building is seen from both sides. A chamfered section, drawn symmetrically.
    gradient(POST, mix(VOID, PITCH, 0.5), mix(PITCH, GRAPH, 0.5))
    flutes(POST, 16.0, VOID, mix(GRAPH_HI, ICE_MID, 0.35), symmetric=True)
    column(POST, at(POST, 0.5, 0)[0] - 1.0, at(POST, 0.5, 0)[0] + 1.0, mix(GRAPH_HI, ICE_MID, 0.25))
    grain(POST, 50, (GRAPH_HI, VOID))

    # RAIL — reserve: a swept handrail, so `band_uv` and the same vertical-only rule as TRUSS.
    gradient(RAIL, mix(VOID, PITCH, 0.6), mix(GRAPH, ICE_MID, 0.12))
    flutes(RAIL, 12.0, VOID, mix(GRAPH_HI, ICE_MID, 0.22), symmetric=True)
    column(RAIL, at(RAIL, 0.5, 0)[0] - 1.0, at(RAIL, 0.5, 0)[0] + 1.0, mix(GRAPH_HI, ICE_MID, 0.55))
    grain(RAIL, 50, (GRAPH_HI, VOID))

    # NICHE — reserve: the back of a booth alcove, washed by the strip above it.
    gradient(NICHE, mix(VOID, VIOLET, 0.5), mix(VIOLET, MAG_SH, 0.5))
    slab(NICHE, NICHE[1], at(NICHE, 0, 0.90)[1], mix(MAG_SH, MAG_MID, 0.45))
    for k in range(1, 5):
        slab(NICHE, at(NICHE, 0, 0.18 * k)[1], at(NICHE, 0, 0.18 * k)[1] + 1.0, VIOLET_LO)
    grain(NICHE, 80, (VIOLET_HI, VOID))


# ---- row 6: the DJ tower, its canopy and the truss --------------------------------------------------

def tower():
    """The shaft in the middle of the atrium, the vault flaring off it, and the console under it.

    TOWER is one of the few large panels on the building that is neither tapered nor stretched — a
    plain 8 x 6.5 m box face — so it is the one place a real two-way grid is honest, and it carries
    the 1.6 m clad panelling that the pyramid itself cannot.
    """
    gradient(TOWER, mix(PITCH, VIOLET, 0.45), mix(PITCH, GRAPH, 0.4))
    for k in range(7):
        x = TOWER[0] + 2.0 + k * 9.6
        column(TOWER, x, x + 1.1, VOID)
        column(TOWER, x + 1.2, x + 2.0, mix(GRAPH_HI, VIOLET_HI, 0.45))
    for k in range(6):
        y = TOWER[1] + 3.0 + k * 11.9
        slab(TOWER, y, y + 1.1, VOID)
        slab(TOWER, y + 1.2, y + 2.0, mix(GRAPH_HI, VIOLET_HI, 0.35))
    grain(TOWER, 120, (GRAPH_HI, VOID, VIOLET))

    # BEZEL — 7.3 x 9.7 m, and the screen in front of it covers everything but a 35 cm border. So the
    # middle is painted as the dead black it will never be seen as, and all of the fitting is in the
    # 2 px frame: a dark return, a lit inner arris, and nothing in the field to leak round the edge.
    flat(BEZEL, VOID)
    patch(BEZEL, 0.0, 0.0, 1.0, 1.0, mix(PITCH, GRAPH, 0.35))
    patch(BEZEL, 0.055, 0.045, 0.945, 0.955, VOID)
    for u in (0.045, 0.955):
        column(BEZEL, at(BEZEL, u, 0)[0] - 0.6, at(BEZEL, u, 0)[0] + 0.6, mix(GRAPH_HI, ICE_MID, 0.3))
    for v in (0.035, 0.965):
        slab(BEZEL, at(BEZEL, 0, v)[1] - 0.6, at(BEZEL, 0, v)[1] + 0.6, mix(GRAPH_HI, ICE_MID, 0.3))
    grain(BEZEL, 40, (GRAPH, VOID))

    # TRUSS — 44 cm of section across U against 22 m of chord down V, which is 70:1 and the second
    # worst on the page. `band_uv` runs V along the sweep, so the entire fitting is a section drawn
    # across U: a dark tube, a lit edge either side of it, and no variation whatever along its length.
    gradient(TRUSS, mix(VOID, PITCH, 0.5), mix(PITCH, GRAPH, 0.4))
    flutes(TRUSS, 11.0, VOID, mix(GRAPH_HI, ICE_MID, 0.30), symmetric=True)
    column(TRUSS, at(TRUSS, 0.5, 0)[0] - 1.4, at(TRUSS, 0.5, 0)[0] + 1.4, mix(GRAPH, GRAPH_HI, 0.5))
    grain(TRUSS, 60, (GRAPH_HI, VOID))

    # VAULT_UNDER — the canopy's underside, seen from the dance floor. `lathe` runs V from the profile
    # edge's start to its end, and every one of the three edges this dresses runs outward and up, so
    # v=1 is the RIM on all of them: the warm rim glow goes at the top of the panel and gets darker
    # inboard. The rib lines at u=0 and u=1 land on the 16 segment boundaries, which is a real
    # radiating rib pattern for free.
    gradient(VAULT_UNDER, mix(VOID, VIOLET, 0.45), mix(AMBER_MID, VIOLET, 0.5))
    for k in range(1, 6):
        y = at(VAULT_UNDER, 0, 0.16 * k)[1]
        slab(VAULT_UNDER, y - 0.9, y, VOID)
        slab(VAULT_UNDER, y - 1.9, y - 1.0, mix(VIOLET_HI, AMBER_MID, 0.4))
    for u in (0.0, 1.0):
        column(VAULT_UNDER, at(VAULT_UNDER, u, 0)[0] - 1.1, at(VAULT_UNDER, u, 0)[0] + 1.1, VOID)
    slab(VAULT_UNDER, VAULT_UNDER[1], at(VAULT_UNDER, 0, 0.94)[1], mix(AMBER_MID, EMBER, 0.45))
    grain(VAULT_UNDER, 80, (AMBER_MID, VOID))

    # VAULT_TOP — the same collar from above, where nothing is looking. Near-black, ribbed to match.
    gradient(VAULT_TOP, mix(VOID, PITCH, 0.6), mix(PITCH, VIOLET, 0.35))
    for k in range(1, 6):
        slab(VAULT_TOP, at(VAULT_TOP, 0, 0.16 * k)[1] - 0.9, at(VAULT_TOP, 0, 0.16 * k)[1], VOID)
    for u in (0.0, 1.0):
        column(VAULT_TOP, at(VAULT_TOP, u, 0)[0] - 1.1, at(VAULT_TOP, u, 0)[0] + 1.1, VOID)
    grain(VAULT_TOP, 60, (VIOLET_HI, VOID))

    # SPIRE — the mast, the vault's rim band and its inner return. The mast's drum TAPERS 2.1:1, so
    # this is the eighth panel on the horizontal-only list; the collars are what it has instead of a
    # profile.
    gradient(SPIRE, mix(PITCH, VIOLET, 0.4), mix(VOID, CYAN_SH, 0.4))
    courses(SPIRE, 6.4, VOID, mix(GRAPH_HI, CYAN_MID, 0.30), vary=(GRAPH_LO,), chance=0.18)
    for v in (0.30, 0.72):
        slab(SPIRE, at(SPIRE, 0, v)[1], at(SPIRE, 0, v - 0.05)[1], VOID)
        slab(SPIRE, at(SPIRE, 0, v + 0.02)[1], at(SPIRE, 0, v)[1], mix(CYAN_SH, CYAN_MID, 0.5))
    grain(SPIRE, 70, (GRAPH_HI, VOID))

    # DESK — the console's own faces. Horizontal reveals and one magenta line at the knuckle, which is
    # all that is legible at 1.5 cm/px from the floor 1.3 m below it.
    gradient(DESK, VOID, mix(GRAPH, VIOLET, 0.45))
    for v in (0.30, 0.62):
        slab(DESK, at(DESK, 0, v)[1], at(DESK, 0, v - 0.04)[1], VOID)
        slab(DESK, at(DESK, 0, v + 0.03)[1], at(DESK, 0, v)[1], mix(GRAPH_HI, VIOLET_HI, 0.4))
    slab(DESK, at(DESK, 0, 0.86)[1], at(DESK, 0, 0.83)[1], mix(MAG_SH, MAG_MID, 0.5))
    grain(DESK, 80, (GRAPH_HI, VOID))

    # DESK_TOP — the console's working surface. Its U is the 0.95 m depth on all three boxes and +X is
    # the front, so a lit line at u=0.9 lands along the DJ's own edge of every one of them.
    gradient(DESK_TOP, mix(PITCH, VIOLET, 0.4), mix(GRAPH, VIOLET, 0.3))
    for k in range(4):
        patch(DESK_TOP, 0.18, 0.10 + 0.22 * k, 0.74, 0.24 + 0.22 * k, VOID)
        patch(DESK_TOP, 0.22, 0.13 + 0.22 * k, 0.70, 0.21 + 0.22 * k, mix(GRAPH, VIOLET_HI, 0.4))
    column(DESK_TOP, at(DESK_TOP, 0.90, 0)[0], at(DESK_TOP, 0.90, 0)[0] + 1.2,
           mix(ICE_MID, CYAN_LIT, 0.35))
    grain(DESK_TOP, 90, (GRAPH_HI, VOID))


# ---- row 7: the rig, and the faces nobody looks at --------------------------------------------------

def rig():
    """Lamps, hangers, the apex cap, and the filler.

    FIXTURE dresses all six faces of every lamp body on the truss and of the four sweep heads, so its
    lens appears on the sides as well as the front. That is the right trade at 0.7 cm/px: a moving
    head is a black box with a bright eye in it, and a box with an eye on every face still reads as
    one lamp, where a box with no eye at all reads as a crate.
    """
    # TRUSS_NODE — the corner blocks. Seen from every angle, so symmetric: a plate, a gusset shadow,
    # and four bolts.
    gradient(TRUSS_NODE, mix(VOID, PITCH, 0.6), mix(PITCH, GRAPH, 0.45))
    patch(TRUSS_NODE, 0.12, 0.12, 0.88, 0.88, mix(GRAPH, VIOLET, 0.3))
    patch(TRUSS_NODE, 0.20, 0.20, 0.80, 0.80, VOID)
    for u in (0.26, 0.74):
        for v in (0.26, 0.74):
            bx, by = at(TRUSS_NODE, u, v)
            draw.ellipse((bx - 1.6, by - 1.6, bx + 1.6, by + 1.6), fill=mix(GRAPH_HI, ICE_MID, 0.35))
    grain(TRUSS_NODE, 60, (GRAPH_HI, VOID))

    # FIXTURE — the lamp body. Cooling fins across it and a 9 cm lens in the middle: bright, and small
    # enough to stay a line item rather than a lit field.
    gradient(FIXTURE, mix(VOID, PITCH, 0.5), mix(PITCH, GRAPH, 0.5))
    for k in range(6):
        y = at(FIXTURE, 0, 0.10 + 0.16 * k)[1]
        slab(FIXTURE, y - 0.9, y, VOID)
        slab(FIXTURE, y - 1.8, y - 1.0, mix(GRAPH_HI, VIOLET_HI, 0.4))
    lx, ly = at(FIXTURE, 0.5, 0.5)
    pool(FIXTURE, lx, ly, 11.0, 11.0, VOID, gamma=0.7)
    pool(FIXTURE, lx, ly, 9.0, 9.0, mix(CYAN_MID, CYAN_LIT, 0.30), gamma=1.6)
    pool(FIXTURE, lx, ly, 4.0, 4.0, mix(CYAN_LIT, (255, 255, 255), 0.35), gamma=1.2)
    edge_line(FIXTURE, mix(GRAPH, VIOLET_HI, 0.4))
    grain(FIXTURE, 50, (GRAPH_HI, VOID))

    # LENS — reserve, and the second panel allowed to be a bright FIELD, for the same reason BACKBAR
    # is: a lens seen face-on is not architecture, it is the light itself. A dark bezel keeps it from
    # bleeding into whatever it is set into.
    flat(LENS, VOID)
    cx, cy = at(LENS, 0.5, 0.5)
    pool(LENS, cx, cy, 29.0, 29.0, mix(CYAN_SH, CYAN_MID, 0.7), gamma=1.0)
    pool(LENS, cx, cy, 25.0, 25.0, mix(CYAN_MID, CYAN_LIT, 0.75), gamma=0.9)
    pool(LENS, cx, cy, 19.0, 19.0, CYAN_LIT, gamma=0.8)
    pool(LENS, cx, cy, 11.0, 11.0, mix(CYAN_LIT, (255, 255, 255), 0.6), gamma=0.9)
    pool(LENS, cx, cy, 5.0, 5.0, (255, 255, 255), gamma=1.0)
    grain(LENS, 40, (ICE_LIT, GLASSY))

    # DUCT — the hangers dropping off the truss. Swept, so vertical only; near-black, because a cable
    # that reads at all reads as a mistake.
    gradient(DUCT, VOID, mix(VOID, PITCH, 0.7))
    flutes(DUCT, 8.0, VOID, mix(GRAPH, PITCH, 0.5), symmetric=True)
    grain(DUCT, 40, (GRAPH_LO, VOID))

    # OCULUS — the truncated apex, 0.95 m square, capping the pyramid at 37.4 m. Seen only from above
    # and from a long way off; it gets the beacon's own ring and nothing else.
    gradient(OCULUS, mix(PITCH, VIOLET, 0.4), mix(PITCH, CYAN_SH, 0.4))
    ox, oy = at(OCULUS, 0.5, 0.5)
    draw.ellipse((ox - 13, oy - 13, ox + 13, oy + 13), outline=VOID, width=2)
    draw.ellipse((ox - 10, oy - 10, ox + 10, oy + 10), outline=mix(CYAN_SH, CYAN_MID, 0.5), width=1)
    grain(OCULUS, 80, (CYAN_SH, VOID))

    # DARK — plain filler for the faces that exist only to close the solid: the podium's base, the
    # buried annuli, the ramp's back. Never pure black, and never quite flat, because the volume guard
    # cares that these faces exist and the mip chain still averages them into their neighbours.
    gradient(DARK, VOID, PITCH)
    grain(DARK, 90, (PITCH, VOID, GRAPH_LO))

    # MAT — reserve: a ribbed entry mat at the threshold.
    flat(MAT, mix(VOID, PITCH, 0.5))
    for k in range(14):
        y = MAT[1] + 2.0 + k * 4.4
        slab(MAT, y, y + 1.6, VOID)
        slab(MAT, y + 1.7, y + 2.6, mix(GRAPH, VIOLET, 0.4))
    grain(MAT, 90, (GRAPH_LO, VOID))

    # STEP_SIDE — the stair's raked soffit and its stringer: 3 m across U against 25.8 m of run down
    # V, at 43:1. Vertical only, and SYMMETRIC — `mirror_y` copies the second flight with its corner
    # order reversed, so the mirrored flight samples this panel backwards and any asymmetry in it
    # would show as two staircases that do not match.
    gradient(STEP_SIDE, mix(VOID, PITCH, 0.55), mix(PITCH, GRAPH, 0.4))
    flutes(STEP_SIDE, 15.0, VOID, mix(GRAPH_HI, VIOLET_HI, 0.4), symmetric=True)
    column(STEP_SIDE, at(STEP_SIDE, 0.5, 0)[0] - 2.0, at(STEP_SIDE, 0.5, 0)[0] + 2.0,
           mix(GRAPH, VIOLET, 0.35))
    grain(STEP_SIDE, 70, (GRAPH_HI, VOID))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    # Not black: the page is opaque everywhere, and any pixel a face somehow reaches that no panel
    # claimed should still be the building's own near-black rather than a hole.
    draw.rectangle((0, 0, SIZE, SIZE), fill=PITCH)

    shell()
    approach()
    room()
    decks()
    counter()
    upstairs()
    tower()
    rig()

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
