"""
Paint the ALPHA-CUTOUT glass page for The Black Sun — the club's mezzanine and booth glazing.

256x256 RGBA, a 4x4 grid of 64px panels, the fourth of the prop's four pages and the only one with a
real alpha channel. `_lib.panels(4, 4)` describes the same grid in UV space, and `black_sun.py` unpacks
it into exactly these names:

    [0][0] G_PANEL   atrium railing, main glass    [0][1] G_ETCH    ...with the black-sun mark
    [0][2] G_BOOTH   private-booth divider         [0][3] G_STAIR   stair balustrade
    [1][0] G_MESH    fine steel grille             [1][1] G_EDGE    OPAQUE lit edge strip
    [1][2] G_FRIT    horizontal frit banding       [1][3] G_DARK    smoked panel
    [2][*] [3][*]    dark tinted glass — unused by the recipe, painted so the page has no raw corners

## Why translucent glass here is a DITHER and not a transparency

There is no alpha blending anywhere in this pipeline. `props/textures.ts` builds *every* prop material
as `MeshLambertMaterial({ side: DoubleSide, alphaTest: 0.4 })`, so a pixel is either fully drawn or
fully cut and there is no third state — an alpha of 128 does not come out half-lit, it comes out
*gone*. A club railing that is supposed to be "smoked glass you can half see the dance floor through"
therefore cannot be painted as one; it has to be BUILT out of holes.

So every glass panel here is an **ordered dither**: a fine, regular lattice of opaque and cut pixels
laid down against an 8x8 Bayer threshold matrix. At range the mip chain averages the lattice back into
a flat haze whose value is exactly the dither's density, which is the translucency you wanted; up close
the lattice resolves and reads as a screen or a frit pattern, which is what real club glazing looks
like anyway. It is a constraint that happens to land on the right aesthetic, so this page leans into it
rather than fighting it.

**Density is the transparency; colour is the light.** Those are kept as two separate controls on
purpose. How much of the room shows through a panel is set by what fraction of its pixels survive —
so that is the only thing the density varies — and how bright the glass looks is set by the RGB of the
pixels that do, which `relight()` changes without touching a single alpha. Mixing the two gives a
panel that goes transparent every time it goes dark, which is not how a lit sheet of glass behaves.

The densities say what each panel is FOR, and that is the whole design of the page:

    G_STAIR   ~45%   uniform, and uniform on purpose — a balustrade climbing a 16.7 deg flight is seen
                     at every rake angle at once, so anything with a direction in it reads as a defect
    G_PANEL   ~35%   the lightest of the four: the atrium railing has 25.8 m of room behind it and the
                     whole point of a glass railing is that the room reads through it
    G_BOOTH   76->30% denser at the bottom, sparser at the top. Privacy where you sit, view where you
                     look — the one panel whose density is a gradient, because a booth divider is the
                     one piece of glass here with a reason to be two different things top and bottom
    G_DARK    ~16%   a smoked panel that is mostly hole

Those are the requested densities. An 8x8 matrix has 64 thresholds, so what actually lands is the next
step up of 1/64 — 35% comes out at 23/64 = 35.9%, 16% at 11/64 = 17.2% — and the measured fractions of
the whole cell are higher again, because the rails below are solid. Measure the interior if you want to
check a density; measuring a cell measures the rails.

## The two traps, both of which are silent

**Transparent pixels are painted in the GLASS's own colour, never black.** Alpha is tested *after*
filtering, so the RGB of an invisible pixel is not invisible — bilinear taps and every mip level
average it into its opaque neighbours, and a transparent-black page bleeds a dark fringe into every
one of the tens of thousands of cut edges a dither has. On art that is half holes by construction that
is not a fringe, it is a wholesale darkening. `new_atlas` therefore gets `bg=GLASS + (0,)`, and
`dither()` goes further and writes each panel's *own* tint into its cut pixels — the booths are lit
violet and the balustrades cyan, and a shared background would drag each toward the other.

**Nothing is drawn antialiased.** A half-alpha edge pixel is a coin flip against a 0.4 test, and it
lands differently at every mip level, so a smoothed edge dissolves into sparkle rather than softening.
Every mark on this page is a hard `point()` or `rectangle()` fill, and every alpha written is 0 or 255
— never anything near `0.4 * 255 = 102`, where the cut would be decided by rounding.

## Scale, and the 4 px that is never seen

`_lib.uv()` insets every mapped face by 2/128 of the page off its panel's edges, which on a 256 page is
4 px — so the outer 4 px of each 64 px cell is never SAMPLED, it only bleeds into the mip chain. A cell
carries 56 usable pixels, and anything that has to land in a known place goes through `at()`.

The stair balustrade is the one panel whose face is already modelled, so it is the one with a real
number against it: `black_sun.py` cuts the flight's glass into 9 quads, each about **2.87 x 0.95 m**
(2.51 m of run, 0.86 m of inboard rake and 1.09 m of rise, against a 0.95 m panel height). Over 56
usable pixels that is **5.1 cm/px across against 1.7 cm/px up — a 3:1 stretch**. Two things follow.
One, a dither dot on this page is a ~5 x 1.7 cm mark on the glass, so the lattice reads as a woven
screen rather than as ceramic frit dots, and it is drawn as one. Two, anything with a vertical edge on
G_STAIR would land three times too wide, which is the other half of why that panel is featureless.

G_ETCH is the exception that has to be drawn round: its black-sun mark is a disc inside a corona ring,
and a ring is the one shape that shows a stretch immediately. It is drawn circular here, so the
railing quad that carries it wants to be near-square — a badly stretched one turns the club's own
emblem into an ellipse, and that is a modelling decision rather than something the paint can fix.

The mark is **etched, not painted**: it is frit at ~94% density laid over the panel's own base dither,
so it is the same lattice run nearly solid rather than a flat sticker sitting on top of the glass. The
6% of holes left in it are what keep it reading as abraded glass.

Every glass panel gets a solid opaque hairline top and bottom — a polished lit edge above, a dark steel
shoe below — drawn from the cell's edge inward past the inset, so the boundary is both visible in the
sampled 56 px and solid in the 4 px that only ever bleeds. Without it a dither simply fades into
nothing at the panel's ends and the glass has no top.

    python Slopesmith/tools/prop-recipes/buildings/black_sun_glass_atlas.py
"""

import math
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, panels, speckle, stripes   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'black_sun_glass.png')

# `_lib.uv()` insets every mapped face by 2/128 of the page off its panel's edges — 4 px here — so the
# outer 4 px of a cell is never seen, only mip-blended. RAIL is how much of the hairline lands INSIDE
# that, i.e. how thick the panel's edge actually reads: 3 px of 56 is ~5 cm on the stair glass.
INSET = 4
RAIL = 3

CELL = SIZE // 4
INNER = CELL - 2 * (INSET + RAIL)          # 50 px: what is left of a cell inside the inset and rails

GRID = panels(SIZE, 4, 4)
G_PANEL, G_ETCH, G_BOOTH, G_STAIR = GRID[0]
G_MESH, G_EDGE, G_FRIT, G_DARK = GRID[1]
FIELD = GRID[2] + GRID[3]          # the eight cells the recipe does not name

# The club is black and its glass is lit from BEHIND by the neon, so an opaque pixel here is a light
# source rather than a surface — these run far brighter than the near-black architecture page.
GLASS = (118, 168, 200)            # the page's own colour, and what a cut glass pixel is painted
GLASS_LIT = (156, 206, 232)
GLASS_DEEP = (74, 118, 150)
GLASS_EDGE = (206, 240, 250)       # the polished free edge: the brightest thing on the page
FRIT = (198, 228, 240)             # the etched mark
FRIT_LO = (150, 186, 206)
BOOTH = (140, 138, 178)            # violet-warm: the booths sit under the magenta cove, not the cyan
BOOTH_LIT = (178, 168, 208)
BOOTH_DEEP = (92, 88, 124)
MESH = (128, 146, 158)             # brushed steel wire
MESH_LIT = (172, 190, 200)
MESH_DEEP = (70, 84, 94)
SMOKE = (60, 78, 96)               # the smoked panel, dark but never black
SMOKE_LIT = (92, 114, 134)
TINT = (34, 50, 62)                # the unused cells: dark tinted glass rather than raw page
TINT_LIT = (54, 74, 90)
TINT_DEEP = (22, 34, 44)

# The booth divider's two ends, as dither densities. These are the numbers the panel exists for, so
# they are named rather than buried in the curve that interpolates them.
BOOTH_DENSE = 0.76         # at the seat: you are not on display while you are sitting down
BOOTH_OPEN = 0.30          # at eye level: you can still see the floor you paid to be above

rnd = random.Random(30366)
img, draw = new_atlas(SIZE, bg=GLASS + (0,))


def bayer(n):
    """The n x n ordered-dither threshold matrix, n a power of two, holding every value 0..n*n-1 once.

    Built by the standard recursive doubling rather than written out, so the size is one constant. What
    makes Bayer the right matrix for this — as against blue noise or a random threshold — is that its
    thresholds are maximally SPREAD at every density: at 1/2 it resolves to a 1 px checkerboard, at 1/4
    to a regular quarter-grid, and at no density does it clump. Clumping is what would show, because a
    clump big enough to survive the mip chain becomes a blotch on the glass instead of haze.
    """
    m = [[0]]
    size = 1
    while size < n:
        m = ([[4 * v for v in row] + [4 * v + 2 for v in row] for row in m]
             + [[4 * v + 3 for v in row] + [4 * v + 1 for v in row] for row in m])
        size *= 2
    return m


BAYER_N = 8
BAYER = bayer(BAYER_N)
LEVELS = BAYER_N * BAYER_N         # 64 distinct densities — enough for a gradient without banding


def at(rect, u, v):
    """A panel's own 0-1 space to a page pixel, honouring the inset every mapped face gets."""
    x0, y0, x1, y1 = rect
    return (x0 + INSET + u * (x1 - x0 - 2 * INSET), y1 - INSET - v * (y1 - y0 - 2 * INSET))


def dither(rect, density, opaque, cut):
    """Lay an ordered dither over one panel. This is the only thing on the page that makes glass.

    `density` is the fraction of pixels that survive — a float, or a callable `(v, k)` for a panel whose
    translucency varies up its height, where `v` is 0 at the panel's BOTTOM (matching UV's V, the way
    `at()` reads it) and `k` is the same thing as a row count. Every pixel is written explicitly: the
    survivors at alpha 255 in one of `opaque`, and everything else at alpha 0 in `cut`.

    Writing the cut pixels rather than leaving the page's background showing is the point. Alpha is
    tested after filtering, so the RGB under a hole still reaches the screen through every mip level —
    `cut` is therefore the panel's own tint, and a violet booth divider does not bleed cyan.
    """
    x0, y0, x1, y1 = rect
    span = y1 - y0
    for y in range(y0, y1):
        k = y1 - 1 - y
        d = density(k / (span - 1), k) if callable(density) else density
        threshold = d * LEVELS
        row = BAYER[y % BAYER_N]
        for x in range(x0, x1):
            if row[x % BAYER_N] < threshold:
                draw.point((x, y), fill=rnd.choice(opaque) + (255,))
            else:
                draw.point((x, y), fill=cut + (0,))


def relight(rect, colour):
    """Re-tint the pixels inside `rect` that are already OPAQUE, leaving every alpha exactly as it was.

    A highlight on glass is a change in what comes through, not in how much — so a specular streak is
    painted here and never dithered. Doing it the other way round makes the bright part of the panel
    also the transparent part, which reads as a hole rather than as a reflection.
    """
    x0, y0, x1, y1 = rect
    for y in range(y0, y1):
        for x in range(x0, x1):
            if img.getpixel((x, y))[3] == 255:
                draw.point((x, y), fill=colour + (255,))


def rails(rect, top=GLASS_EDGE, shoe=MESH_DEEP, lit=MESH_LIT):
    """The panel's top and bottom hairlines, so a sheet of glass has an edge instead of trailing off.

    Both run from the cell's true edge inward past the inset: the 4 px that is never sampled is painted
    solid too, so mip filtering at a panel's ends pulls rail rather than the neighbouring cell's holes.

    They are deliberately not the same. A balustrade's top is a polished free edge catching the cove
    light, and its bottom is clamped into a steel shoe with a lit top face — which also tells you which
    way up a panel is from across the room, at a cost of six pixels.
    """
    x0, y0, x1, y1 = rect
    draw.rectangle((x0, y0, x1 - 1, y0 + INSET + RAIL - 1), fill=top + (255,))
    draw.rectangle((x0, y1 - INSET - RAIL, x1 - 1, y1 - 1), fill=shoe + (255,))
    draw.rectangle((x0, y1 - INSET - RAIL, x1 - 1, y1 - INSET - RAIL), fill=lit + (255,))


def etched_sun(rect, disc=12.0, ring=(19.0, 23.0), density=0.94):
    """The club's mark: a black-sun disc inside its corona, ETCHED into the panel rather than painted.

    Etched glass is abraded glass — it scatters the light behind it instead of passing it, so the mark
    comes out BRIGHTER than the sheet it is cut into, not darker. Here that is the same lattice as the
    rest of the panel run to ~94%: nearly solid frit with a few holes still in it, which is what keeps
    it reading as worked glass instead of a decal stuck on the outside.

    Drawn round, and drawn strictly inside the rails and the inset — the mark is the one thing on this
    page with a location, so it is the one thing that must not touch either.
    """
    x0, y0, x1, y1 = rect
    cx = x0 + (x1 - x0) / 2.0
    cy = y0 + INSET + RAIL + (y1 - y0 - 2 * (INSET + RAIL)) / 2.0
    threshold = density * LEVELS
    for y in range(y0 + INSET + RAIL, y1 - INSET - RAIL):
        row = BAYER[y % BAYER_N]
        for x in range(x0, x1):
            r = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            if r > disc and not (ring[0] <= r <= ring[1]):
                continue
            on = row[x % BAYER_N] < threshold
            draw.point((x, y), fill=(FRIT + (255,)) if on else (FRIT_LO + (0,)))


def weave(rect, pitch=6):
    """A fine steel grille — a real woven lattice, not a dither, because it is a real woven lattice.

    1 px wires on a 6 px pitch leaves it about 70% hole, which is what a grille in front of a light is.
    The verticals go down first and the horizontals over them, so every crossing takes the horizontal
    wire's colour and the mesh reads as woven rather than as a printed grid.
    """
    x0, y0, x1, y1 = rect
    draw.rectangle(rect, fill=MESH_DEEP + (0,))
    for x in range(x0, x1, pitch):
        draw.rectangle((x, y0, x, y1 - 1), fill=MESH + (255,))
    for y in range(y0, y1, pitch):
        draw.rectangle((x0, y, x1 - 1, y), fill=MESH_LIT + (255,))


def edge_strip(rect):
    """The one FULLY OPAQUE cell on the page: the lit edge of a glass sheet, seen end-on.

    A dithered edge strip would be a mistake of a particular kind — the strip is only a few centimetres
    wide on the model, so its holes would not average into haze at any distance, they would just make
    the brightest line in the club flicker. Value gradient across it, alpha 255 everywhere including
    the 4 px that is never sampled.
    """
    x0, y0, x1, y1 = rect
    half = (y1 - y0) / 2.0
    for y in range(y0, y1):
        t = min(1.0, abs(y + 0.5 - (y0 + half)) / half)
        c = tuple(int(round(a + (b - a) * t)) for a, b in zip(GLASS_EDGE, GLASS_DEEP))
        draw.rectangle((x0, y, x1 - 1, y), fill=c + (255,))
    stripes(draw, rect, GLASS_LIT + (255,), 4, horizontal=True, width=(0.6, 1.6), rnd=rnd)
    stripes(draw, rect, GLASS_DEEP + (255,), 3, horizontal=True, width=(0.5, 1.2), rnd=rnd)


def booth_density(v, k):
    """The booth divider's gradient: dense at the seat, open at eye level.

    Measured over the VISIBLE interior rather than over the whole cell. The rails eat 7 px off each
    end, so a gradient run across the full 64 px spends both of its endpoints under them and only the
    middle 78% of the curve ever reaches the glass — the panel then arrives on the model at 33-70%
    having been authored for 30-76%, which is a quiet 20% loss of the one thing this panel is for.

    The exponent is just over 1, which keeps the change slow through the top half and stacks it low:
    the privacy arrives at shoulder height rather than as a band across the middle.
    """
    t = min(1.0, max(0.0, (k - INSET - RAIL) / (INNER - 1.0)))
    return BOOTH_OPEN + (BOOTH_DENSE - BOOTH_OPEN) * (1.0 - t) ** 1.25


def frit_density(v, k):
    """Ceramic frit in courses up the panel: 8 dense rows, 8 open, repeating.

    The pitch is 8 px and not some more interesting number **because the Bayer tile is 8 px**. An
    ordered dither only reproduces its requested density over a whole tile, so a course that spans some
    other number of rows samples a biased slice of the matrix — a nominally 15% course comes out at 8%
    where it lands on one phase and 25% where it lands on another, and with a pitch coprime to 8 every
    course lands on a different phase and no two bands on the panel match. Aligning the course to the
    tile makes every course identical and both densities exact. `k` counts up from the panel's bottom
    and the cell is a whole number of tiles, so `k // 8` and the row's Bayer phase move together.

    8 px is ~14 cm on the stair glass: banding you read as a pattern from the dance floor and as
    individual courses from the walkway.
    """
    return 0.85 if (k // BAYER_N) % 2 == 0 else 0.18


def tinted_field(rect):
    """One of the eight cells the recipe never maps. Dark tinted glass, fully opaque.

    `patrol_hut_atlas` fills its spare cells with timber for the same reason: an unused corner still
    bleeds into the mip chain and still gets sampled the day someone adds a face, and both of those go
    better as plausible dark glazing than as raw page. Opaque, so a stray face gets a surface rather
    than a hole.
    """
    draw.rectangle(rect, fill=TINT + (255,))
    stripes(draw, rect, TINT_LIT + (255,), 6, horizontal=False, width=(0.8, 2.6), rnd=rnd)
    stripes(draw, rect, TINT_DEEP + (255,), 5, horizontal=False, width=(0.6, 2.0), rnd=rnd)
    speckle(draw, rnd, rect, 36, (TINT_LIT + (255,), TINT_DEEP + (255,)), size=(1, 1))


def reflections(rect):
    """Two vertical specular streaks down a railing panel — the cove light on the sheet's face.

    Value only: `relight` cannot change an alpha, so the panel is exactly as see-through under a streak
    as beside it. Placed through `at()`, which is what keeps both bands inside the 4 px that is never
    sampled — a streak running off the edge of a cell is drawn into the neighbouring panel, and
    `ImageDraw` has no clip region to stop it.
    """
    _, y0, _, y1 = rect
    top, bottom = y0 + INSET + RAIL, y1 - INSET - RAIL
    for u0, u1, colour in ((0.23, 0.31, GLASS_LIT), (0.61, 0.65, GLASS_EDGE)):
        relight((int(at(rect, u0, 0.0)[0]), top, int(at(rect, u1, 0.0)[0]), bottom), colour)


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    # The atrium railing — the lightest glass in the club. 25.8 m of atrium is behind it and a railing
    # that reads as a wall would close the one room the whole pyramid exists to hold open.
    glass_ink = (GLASS, GLASS, GLASS, GLASS, GLASS_LIT, GLASS_DEEP)
    dither(G_PANEL, 0.35, glass_ink, GLASS)
    reflections(G_PANEL)
    rails(G_PANEL)

    # ...and the same panel carrying the mark. Same base density, so a railing can run G_PANEL round
    # the ring and drop G_ETCH in every few bays without the glass changing weight where it lands.
    dither(G_ETCH, 0.35, glass_ink, GLASS)
    reflections(G_ETCH)
    etched_sun(G_ETCH)
    rails(G_ETCH)

    # The booth divider: the only graded panel, and the only one lit violet rather than cyan.
    dither(G_BOOTH, booth_density, (BOOTH, BOOTH, BOOTH, BOOTH, BOOTH_LIT, BOOTH_DEEP), BOOTH)
    rails(G_BOOTH, top=BOOTH_LIT, shoe=(58, 54, 74), lit=BOOTH_DEEP)

    # The stair balustrade. Uniform, and featureless on purpose: it climbs a 16.7 deg flight in 9
    # quads, so it is seen at every rake at once and its cell is stretched 3:1 across against up.
    dither(G_STAIR, 0.45, glass_ink, GLASS)
    rails(G_STAIR)

    weave(G_MESH)
    rails(G_MESH, top=MESH_LIT, shoe=MESH_DEEP, lit=MESH)

    edge_strip(G_EDGE)

    dither(G_FRIT, frit_density, (FRIT, FRIT, FRIT_LO, GLASS_LIT), GLASS)
    rails(G_FRIT)

    dither(G_DARK, 0.16, (SMOKE, SMOKE, SMOKE, SMOKE_LIT, GLASS_DEEP), SMOKE)
    rails(G_DARK, top=SMOKE_LIT, shoe=MESH_DEEP, lit=MESH)

    for cell in FIELD:
        tinted_field(cell)

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
