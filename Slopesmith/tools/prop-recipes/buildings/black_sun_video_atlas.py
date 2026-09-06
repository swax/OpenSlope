"""
Paint the video-wall page for The Black Sun — the club's 22 screens, all on one 256x256 page.

Slot 2 of the building's four materials (`black_sun.py`). Every screen on the prop wears this page:
four huge ones on the DJ tower's four faces, sixteen let into the raked interior walls, and two
flanking the portal on the way in. One page rather than one per screen, and one PICTURE per screen
rather than a flipbook, because the material SCROLLS and a scroll is materialised the moment the
prop is placed — see the recipe's own note on why the screens are not a frame list.

    python Slopesmith/tools/prop-recipes/buildings/black_sun_video_atlas.py

## The layout: four full-height columns, not a grid

    col 0   x   0- 63   equaliser      stacked level meters, hot cyan and white
    col 1   x  64-127   data glyphs    a lattice of lit and dark cells, magenta and violet
    col 2   x 128-191   oscilloscope   three traces a band, green, with a glow
    col 3   x 192-255   the black sun  a dark disc inside a bright corona, on deep amber

This is deliberately NOT `_atlas.panels()`. A panel grid cuts both axes, and cutting V is the one
thing this page cannot do — so the columns are computed straight off the column index instead, as
`(col * 64, 0, (col + 1) * 64, 256)`, and each one runs the full height of the page. The recipe's
`video(col, reps)` builds the matching UV rect: U spanning exactly one column, V running 0 to
`reps`. The tower's four faces take one column each, so no two sides of the DJ tower are showing the
same picture at the same moment, which is the entire reason there are four of them.

## Why the art is what it is: the material scrolls in V

`surface(VIDEO_TEX, scroll=(0.0, 0.30))` — 0.30 uv per second up V, forever, from the instant the
club is placed. The README's two constraints on a scrolling surface both bite here, and between them
they decide every mark on this page:

**It has to tile along V.** `RepeatWrapping` walks the sampled window off the top and returns it to
0, so any column whose row 255 does not meet its row 0 grows a seam that crawls up all 22 screens
once per cycle. So each column is painted ONCE as a 64 px band and stamped four times up the page.
The repeat period is 64 px — an exact divisor of 256 — which makes the wrap exact by construction
rather than by careful drawing, and it means the band boundaries and the page boundary are the same
kind of join, so there is no privileged seam to get wrong.

**It has to be uniform along V.** Anything that varies down a column travels WITH the texture: paint
one striking band and it marches up every screen in the club forever, arriving on a schedule, which
is exactly the tell that says "texture" instead of "video". That is why the four bands of a column
are identical rather than four different frames — a 256 px period would also wrap exactly, but it
would put one distinctive band on tour up a 9 m screen twice a lap. Where a column wants variety of
FORM, it gets it inside the 64 px band: the oscilloscope column carries three unlike traces stacked
in one band, so any 64 px of travel looks statistically like any other 64 px of travel.

**So the variety lives across U, which never moves.** Four columns, four unrelated pictures, and a
screen picks one. This is the mirror image of the neon page, which scrolls in U and therefore keeps
all of its variety in V; the two pages are the same argument reflected, for the same reason.

The grain is the one thing allowed not to tile. Scanline dimming is on a 4 px pitch (4 divides 64,
so it lands identically in every band) but the speckle dust on top is drawn over the whole column at
once and is spatially uncorrelated, which has no structure to seam and usefully breaks up the
mechanical look of four identical stamps. Row 0 and row 64 of a column are therefore near-identical
rather than byte-identical, and that is the intended result — about 5% of a band's pixels differ
from the band below it, and the join at row 255 -> row 0 measures smoother than the median pair of
adjacent rows inside a band.

## The margins, and why the page is bright

`_lib.rect_uv` insets a mapped face by 2/128 of the page off each edge — 4 px here — so the outer
4 px of every column is never sampled, only mip-bled into. All art is kept inside x0+4 .. x1-4 and
those margins carry nothing but the column's own dark ground. Painting a column band into its own
64x64 image and pasting it makes that structural on the other axis too: `ImageDraw` does not clip,
and a bar drawn 3 px too wide on a page-level draw would land on the NEXT screen's picture, whereas
a tile simply clips at its own edge.

This is one of only two bright pages on the building. The architecture page runs 12-40 out of 255 so
that a shaded placement reads as black stone under free point lights; these screens run at full
saturation on a near-black ground so the same lighting leaves them looking emissive. A club that is
dark everywhere except its light is the whole look, and it is done in the paint because `fullBright`
is per placement and cannot be had for one material.
"""

import math
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import bars, new_atlas, speckle   # noqa: E402

SIZE = 256
TILE = 64                      # the vertical repeat, and the column width. 256 / 64 = 4 of each.
COLS = SIZE // TILE
OUT = os.path.join(ROOT, 'build', 'black_sun_video.png')
SEED = 20260818                # the recipe's own seed: one club, one reproducible look

# A column grid, not `panels()` — V is the scroll axis and must not be cut.
COLUMN = [(col * TILE, 0, (col + 1) * TILE, SIZE) for col in range(COLS)]

# `_lib.rect_uv` insets 2/128 of the page off each edge: 4 px here. Inside a 64 px band that leaves
# x 4..59 as the part a screen actually shows, so every column's art is drawn between these.
INSET = 4
SAFE0, SAFE1 = INSET, TILE - INSET

# ---- palette -------------------------------------------------------------------------------------
# Hot and saturated over a near-black ground of the column's own hue. The ground is what fills the
# never-sampled margins, so it is a real colour choice rather than plain black.

GROUND = [(2, 8, 12, 255), (8, 2, 14, 255), (2, 12, 10, 255), (40, 10, 6, 255)]

EQ_TRACK = (6, 34, 44)         # the unlit meter channel, so a short bar still reads as a meter
EQ_LIT = (0, 190, 226)
EQ_HOT = (120, 236, 250)
EQ_PEAK = (238, 252, 255)
EQ_SEGS = 11                   # 4 px segments on a 5 px pitch from x=5: the last starts at x=55
EQ_ROWS = 8                    # 8 px a row over the band, so the rows land at the same y every band

GL_GRID = (26, 8, 42)          # the lattice between cells
GL_DIM = (52, 14, 80)          # a cell that is off
GL_LIT = (196, 34, 178)
GL_VIO = (128, 60, 240)
GL_HOT = (255, 130, 236)
GL_CELL = 8                    # 7 cells across the safe band, 8 down the band

SC_GRAT = (14, 52, 44)         # graticule and zero line
SC_GLOW = (24, 150, 110)
SC_CORE = (170, 255, 190)
SC_AMP = 6                     # trace amplitude; +/-2 more for the glow, so a trace owns 16 px
SC_TRACES = ((10, 'sine'), (31, 'pulse'), (52, 'noise'))

# The mark, painted from the outside in. Radius 27 off a centre at 32 lands the halo at x 5..59,
# which is inside the safe band by a pixel at each side.
SUN_HALO = (86, 22, 10)
SUN_RINGS = ((25, (92, 22, 8)), (23, (140, 40, 10)), (21, (214, 96, 20)), (19, (255, 176, 62)),
             (17, (255, 236, 176)), (15, (18, 6, 6)), (12, (8, 3, 3)))

# Grain: a dim and a hot dot per column, close enough to the column's own hue to read as panel noise
# rather than as sparkle.
GRAIN = (((4, 30, 40), (96, 180, 200)), ((28, 8, 44), (170, 80, 190)),
         ((6, 34, 26), (90, 190, 140)), ((60, 16, 8), (170, 70, 24)))
GRAIN_N = 120
SCAN_PITCH = 4                 # divides 64, so the scanlines land identically in every band
SCAN_KEEP = 0.70

rnd = random.Random(SEED)
img, draw = new_atlas(SIZE)

BAND = (SAFE0, 0, SAFE1, TILE)     # the drawable rect of a band, in the band's own coordinates


def equaliser():
    """col 0 — eight stacked level meters, each lit to its own length, with a detached peak hold.

    An equaliser's bars normally stand UP, and here they cannot: a bar whose length runs along V is a
    feature that varies down the column, and it would ride the scroll. Turned on its side the same
    reading survives — segmented, hard-edged, hot at the tip — and the length now varies along U,
    which is the axis that stays still. The rows are on an 8 px pitch so eight of them fill the band
    exactly and the next stamp continues the ladder without a double gap.
    """
    tile, td = new_atlas(TILE, GROUND[0])
    bars(td, BAND, EQ_TRACK, EQ_ROWS, 5.0)
    for k in range(EQ_ROWS):
        cy = TILE * (k + 0.5) / EQ_ROWS
        level = rnd.randint(2, EQ_SEGS)
        for s in range(level):
            x = SAFE0 + 1 + s * 5
            lit = EQ_LIT if s < EQ_SEGS - 4 else EQ_HOT if s < EQ_SEGS - 2 else EQ_PEAK
            td.rectangle((x, cy - 2.5, x + 3, cy + 2.5), fill=lit)
        # The peak hold is DROPPED rather than clamped when it runs off the end. Clamping it parks
        # every loud row's marker on the last segment, and eight of those stack into a solid white
        # stripe down the column edge that reads as a border rather than as a meter.
        peak = level + rnd.randint(1, 3)
        if peak < EQ_SEGS:
            td.rectangle((SAFE0 + 1 + peak * 5, cy - 2.5, SAFE0 + 4 + peak * 5, cy + 2.5),
                         fill=EQ_PEAK)
    speckle(td, rnd, BAND, 36, (EQ_LIT, EQ_TRACK), size=(1, 1))
    return tile


def glyphs():
    """col 1 — a lattice of small cells, most of them off. Data, not decoration.

    7 cells across the safe band and 8 down, on the same 8 px pitch both ways so the lattice crosses
    the band boundary without a widened row. The mix of full cells, bars and rings is what stops it
    reading as a checkerboard: a grid of identical lit squares is a pattern, a grid of unlike ones is
    a readout.
    """
    tile, td = new_atlas(TILE, GROUND[1])
    td.rectangle((SAFE0, 0, SAFE1 - 1, TILE - 1), fill=GL_GRID)
    for j in range(TILE // GL_CELL):
        for i in range((SAFE1 - SAFE0) // GL_CELL):
            x, y = SAFE0 + i * GL_CELL, j * GL_CELL
            cell = (x + 1, y + 1, x + 6, y + 6)
            roll = rnd.random()
            if roll < 0.34:
                td.rectangle(cell, fill=GL_DIM)
            elif roll < 0.58:
                td.rectangle(cell, fill=GL_LIT)
            elif roll < 0.70:
                td.rectangle(cell, fill=GL_VIO)
            elif roll < 0.82:
                td.rectangle((x + 1, y + 3, x + 6, y + 4), fill=GL_HOT)       # a half-lit bar
            elif roll < 0.91:
                td.rectangle((x + 3, y + 1, x + 4, y + 6), fill=GL_HOT)       # ...and on its end
            else:
                td.rectangle(cell, fill=GL_LIT)
                td.rectangle((x + 3, y + 3, x + 4, y + 4), fill=GL_GRID)      # a ring
    speckle(td, rnd, BAND, 36, (GL_VIO, GL_GRID), size=(1, 1))
    return tile


def trace(cy, shape):
    """One trace's y for each x across the safe band, centred on cy and held inside +/-SC_AMP."""
    ys = []
    walk = 0.0
    for x in range(SAFE0, SAFE1):
        t = x - SAFE0
        if shape == 'sine':
            y = -SC_AMP * math.sin(2 * math.pi * t / 14.0)
        elif shape == 'pulse':
            # A square wave, drawn as two levels. The vertical edges come for free from stroking
            # between consecutive samples rather than from a second pass.
            y = -SC_AMP if (t // 8) % 2 == 0 else SC_AMP
        else:
            walk = max(-SC_AMP, min(SC_AMP, walk + rnd.uniform(-3.4, 3.4)))
            y = walk if rnd.random() > 0.12 else rnd.choice((-SC_AMP, SC_AMP))   # the odd spike
        ys.append(cy + y)
    return ys


def stroke(td, ys, colour, pad):
    """Draw a trace as one vertical span per column of pixels, joining each sample to the last.

    Per-column spans rather than `line()` because the pulse train's edges are vertical and a polyline
    of width 3 leaves notches at them — and because a span is trivially clamped, which is what keeps
    a trace inside its own 16 px lane instead of into its neighbour's.
    """
    prev = ys[0]
    for i, x in enumerate(range(SAFE0, SAFE1)):
        y = ys[i]
        td.rectangle((x, min(prev, y) - pad, x, max(prev, y) + pad), fill=colour)
        prev = y


def scope():
    """col 2 — three unlike traces stacked in one band: a sine, a pulse train and a noisy walk.

    The variety of trace shape lives INSIDE the 64 px band on purpose. Giving each of the four bands
    its own shape would still wrap exactly at 256, but it would send one recognisable trace touring
    up every screen; three shapes in one repeated band means any 64 px of scroll carries the same
    mix as any other. Each trace owns a 16 px lane — 6 px of swing plus 2 px of glow either side.
    """
    tile, td = new_atlas(TILE, GROUND[2])
    bars(td, BAND, SC_GRAT, 7, 1.0, horizontal=False)
    for cy, shape in SC_TRACES:
        td.rectangle((SAFE0, cy, SAFE1 - 1, cy), fill=SC_GRAT)      # the zero line under the trace
        ys = trace(cy, shape)
        stroke(td, ys, SC_GLOW, 2)                                  # glow first...
        stroke(td, ys, SC_CORE, 0)                                  # ...then the core over it
    speckle(td, rnd, BAND, 30, (SC_GLOW, SC_GRAT), size=(1, 1))
    return tile


def sun():
    """col 3 — the club's own mark, four times up the column: the black sun itself.

    Concentric and exactly centred, which everywhere else on this building would be a mistake — the
    oculus disc is mapped radially and `radial_uv` warns that rings there land as rings on the prop.
    Here the panel is a flat screen and the rings are the point. Painted outside in as filled discs,
    so the corona is a bright annulus left over between the halo and the dark disc rather than a ring
    that has to be stroked at a width.
    """
    tile, td = new_atlas(TILE, GROUND[3])
    c = TILE // 2
    td.ellipse((c - 27, c - 27, c + 27, c + 27), outline=SUN_HALO, width=1)
    for r, colour in SUN_RINGS:
        td.ellipse((c - r, c - r, c + r, c + r), fill=colour)
    speckle(td, rnd, BAND, 30, ((74, 20, 8), (150, 48, 14)), size=(1, 1))
    return tile


def scanlines(rect):
    """Dim every SCAN_PITCH-th row of a column, so the screens read as emissive panels.

    Done as a multiply on the pixels already there rather than as dark lines drawn over them: an
    opaque line would flatten the art it crosses to one colour, and a translucent fill is not
    available — `ImageDraw` replaces rather than blends on an RGBA page, and a fill carrying alpha
    would punch holes in a page that has to come out fully opaque. `putalpha` restates that.
    """
    x0, y0, x1, y1 = rect
    for y in range(y0, y1, SCAN_PITCH):
        row = img.crop((x0, y, x1, y + 1)).point(lambda v: int(v * SCAN_KEEP))
        row.putalpha(255)
        img.paste(row, (x0, y))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    for col, paint in enumerate((equaliser, glyphs, scope, sun)):
        band = paint()
        for k in range(SIZE // TILE):
            img.paste(band, (col * TILE, k * TILE))     # the exact wrap, by construction
        # Scanlines run the full column — they only ever darken, so the margins can take them. The
        # dust stops at the inset: a bright dot in a margin is never SEEN, but it is exactly what
        # mip filtering drags into the visible edge, which is the one thing the margin is there for.
        x0, y0, x1, y1 = COLUMN[col]
        scanlines(COLUMN[col])
        speckle(draw, rnd, (x0 + INSET, y0, x1 - INSET, y1), GRAIN_N, GRAIN[col], size=(1, 1))

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
