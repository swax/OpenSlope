"""
Paint the light-strip page for The Black Sun — the one bright page on an otherwise near-black building.

256x256 RGBA and FULLY OPAQUE. This is not a cutout page: every strip is a solid bar of geometry with a
lit face, so there is nothing here for alpha to do and a stray transparent pixel would only punch a hole
in a light fitting.

## The row map

Eight full-width horizontal rows of 32 px, row 0 at the TOP of the PNG:

    row 0   cyan        N_CYAN      the cool default — coves, stair nosings, floor inlay
    row 1   magenta     N_MAGENTA
    row 2   violet      N_VIOLET
    row 3   ice-white   N_ICE       handrails, and anything that must read as a LINE not a colour
    row 4   amber       N_AMBER
    row 5   green       N_GREEN
    row 6   crimson     N_CRIMSON
    row 7   chase       N_CHASE     a running sequence of the six chromatic hues

`black_sun.py` holds the other half of that contract as `N_CYAN, ... N_CHASE = range(8)` and builds a
synthetic UV rect straight from the index in `neon(row, length)`. Reordering the rows here without
reordering them there repaints every light on the club and nothing anywhere reports it.

There is deliberately no `_atlas.panels()` call. The grid is rows ONLY — one column, full width — so
`panels(SIZE, 1, 8)` would be a more expensive way of writing `(0, row * 32, 256, row * 32 + 32)`, and
it would imply a column structure that the U axis is not allowed to have (see below).

Row 7 cycles cyan -> violet -> magenta -> crimson -> amber -> green and back, which is the six
CHROMATIC rows in spectral order. Ice-white is left out on purpose: it is a value rather than a hue, and
a white segment in a chase reads as a gap in the chase rather than as another lamp in it.

## Constraint one: the material SCROLLS, so every row has to tile along U

Surface 1 is declared `scroll=(0.45, 0.0)` — 0.45 uv per second along U, forever, on every strip on the
building at once. That imposes both of the README's rules on the art at the same time:

- **It must meet its own opposite edge**, or `RepeatWrapping` drags a seam along every strip once per
  cycle.
- **It must be statistically uniform along U**, because anything that varies with the scroll axis
  TRAVELS: paint one bright flare into the page and that flare sets off down all 45 m of cove and never
  comes back.

So each row is a repeating rhythm at a 64 px period — 256 / 4, an exact divisor, so four whole repeats
land on the page and the wrap is exact rather than nearly exact. It is enforced structurally rather than
by care: each row is painted ONCE into the leftmost 64 px and then stamped across, so the tile is
byte-identical four times over and even the grain repeats. A rhythm that failed to tile would have to be
built out of a `pitch` that does not divide 64, which is the one thing `lamp()` documents against.

What that period is worth in the world: `NEON_PERIOD = 6.0` m of strip per page width, so 2.3 cm/px
along U and one 64 px repeat is 1.5 m of light. At 0.45 uv/s the texture runs 2.7 m/s along a strip and
a repeat passes any given point every 0.56 s — about 1.8 pulses a second, which is club tempo and not
strobe. Every row was tuned against that number; halving the period would double it.

## Constraint two: only the middle 24 px of a row is ever SEEN

The recipe maps a strip through `_lib.rect_uv`, which insets by `_lib.INSET` = 2/128 of the page. On a
256 px page that is 4 px, so a 32 px row shows only its central 24 px and the outer 4 px top and bottom
exist purely so the mip chain has something of this row's own to drag inward.

Hence the section down V, which is the axis that never moves and therefore carries all of the detail:

    dy  0- 3   dark channel    never sampled — this row's OWN dark hue, so mip bleed is invisible
    dy  4- 6   channel wall    the recess the tube sits in
    dy  7- 9   halo            the glow spilling onto the channel wall
    dy 10-21   CORE            12 px of saturated tube
    dy 15-16   peak            white-hot filament down the middle of the core
    dy 22-24   halo
    dy 25-27   channel wall
    dy 28-31   dark channel    never sampled

Those outer bands are the row's own hue darkened, never black and never the neighbour's colour. Black
would put a dark gutter down the middle of every strip the moment the page mips; the neighbour's colour
would tint a cyan cove magenta at distance, on some other part of the building, which is the kind of bug
that gets blamed on the lighting.

What that lands at: `neon_bar(..., r=0.07)` builds a square bar 9.9 cm across a face, so the 24 sampled
px run 0.41 cm/px down V — the 12 px core is a 5 cm tube glowing inside a 10 cm channel, which is a real
cove fitting's proportions.

## Colour

Cores sit at or near 255 and every hue is close to saturated. That is not a stylistic preference, it is
the other half of the building's lighting decision: `fullBright` is per PLACEMENT, so the club cannot be
a lit sign and a shaded building at once, and it ships SHADED. The architecture page runs 12-40 out of
255 and this one runs at the top of the range, so the editor's prop lighting leaves near-black
near-black while saturating the strips.

The rhythms differ row to row on purpose — eight strips on one building all pulsing in lockstep reads as
one animated texture rather than as eight light fittings — but they all repeat at 64 px.

    python Slopesmith/tools/prop-recipes/buildings/black_sun_neon_atlas.py
"""

import math
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
from _atlas import new_atlas, speckle   # noqa: E402

SIZE = 256
OUT = os.path.join(ROOT, 'build', 'black_sun_neon.png')

ROWS = 8
ROW_H = SIZE // ROWS        # 32 px per colour row
CENTRE = ROW_H / 2.0

# The U repeat. 64 divides 256 exactly, so four whole repeats land on the page and the scroll's wrap
# falls on a repeat boundary instead of mid-pulse.
PERIOD = 64

# `_lib.uv()` insets every mapped face by 2/128 of the page, which is 4 px here. The outer INSET px of a
# row are never sampled; the sampled band is the 24 px between them.
INSET = 4
LIT_TOP, LIT_BOT = 8, 24    # the halo-and-core band, where the filament grain goes


def mix(a, b, t):
    """Linear blend between two RGB triples, clamped."""
    t = max(0.0, min(1.0, t))
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def dim(rgb, k, lift=0):
    """A darker version of a hue — the channel it is recessed into, and the grain that sits on it.

    `lift` keeps every component off zero. A hue with a near-zero component darkens to BLACK, and black
    is the one thing the outer 4 px of a row must not be: it is what the mip chain pulls inward.
    """
    return tuple(max(2, min(255, int(round(c * k)) + lift)) for c in rgb)


def palette(core, peak):
    """Everything one strip colour needs, derived from its two bright values.

    Keeping `chan` and the grain pairs DERIVED rather than hand-picked is what stops a row drifting: a
    channel that is not this row's own hue, or a grain colour a shade too far off the core, both read as
    dirt on a light fitting rather than as a light fitting.
    """
    return {
        'core': core,
        'peak': peak,
        'chan': dim(core, 0.11, lift=3),
        'lit': (dim(core, 0.84), mix(core, peak, 0.30)),
        'dark': (dim(core, 0.19, lift=2), dim(core, 0.06, lift=2)),
    }


CYAN = palette((40, 248, 255), (212, 255, 255))
MAGENTA = palette((255, 46, 214), (255, 202, 244))
VIOLET = palette((152, 72, 255), (228, 210, 255))
ICE = palette((234, 248, 255), (255, 255, 255))
AMBER = palette((255, 170, 26), (255, 238, 192))
GREEN = palette((88, 255, 96), (218, 255, 218))
CRIMSON = palette((255, 42, 58), (255, 198, 202))

# Row 7's run: the six chromatic palettes in spectral order, closing green -> cyan so the cycle has no
# jump in it. Ice-white is not in the list — see the docstring.
CHASE_SEGS = 6
CHASE_PAL = (CYAN, VIOLET, MAGENTA, CRIMSON, AMBER, GREEN)
# 64 / 6 is not an integer and does not need to be: the boundaries are rounded ONCE, here, and both the
# hue lookup and the rhythm read them from this list. Derive them twice and they disagree by a pixel,
# which shows up as a one-px sliver of the previous hue at every segment head.
CHASE_X = [round(k * PERIOD / CHASE_SEGS) for k in range(CHASE_SEGS + 1)]

rnd = random.Random(41168)
img, draw = new_atlas(SIZE)


def build_section():
    """The strip's cross-section, as (hue ramp, white-hot) per scanline of a row.

    Piecewise rather than a smooth falloff, because a light strip seen edge-on is not a gaussian — it is
    a hard-edged extrusion with a tube in it, and the flat-topped core is what makes it read as a fitting
    with a lens rather than as an airbrushed smear.
    """
    section = []
    for dy in range(ROW_H):
        d = abs(dy + 0.5 - CENTRE)
        if d > 12.0:
            t = 0.0                                          # the 4 px that only ever bleed
        elif d > 8.5:
            t = 0.06 + 0.36 * (12.0 - d) / 3.5               # channel wall, catching a little light
        elif d > 6.0:
            t = 0.42 + 0.58 * (8.5 - d) / 2.5                # halo
        else:
            t = 1.0                                          # 12 px of core
        section.append((t, max(0.0, 1.0 - d / 2.4) * 0.92))  # ...with the filament down its middle
    return section


SECTION = build_section()


# ---- the U rhythms -------------------------------------------------------------------------------
#
# Every one of these is a function of a column and repeats at PERIOD. They return a gain in 0-1 that is
# multiplied over the painted section, so a gain of 0 leaves the column at its own channel colour and
# the strip goes dark there rather than turning some other hue.

def ring(u, centre, pitch):
    """Distance from `centre` on a ring of `pitch` px — the wrap that makes these tile."""
    d = (u - centre) % pitch
    return min(d, pitch - d)


def lamp(u, centre, length, soft, pitch=PERIOD):
    """A lit run `length` px long with `soft` px of falloff at each end, repeating every `pitch`.

    `pitch` MUST divide PERIOD, or the row stops tiling and the scroll drags a seam along every strip
    drawn from it once per cycle.
    """
    d = ring(u, centre, pitch)
    half = length / 2.0
    if d <= half - soft:
        return 1.0
    if d >= half + soft:
        return 0.0
    return 0.5 + 0.5 * math.cos(math.pi * (d - half + soft) / (2 * soft))


def swell(u, centre, width):
    """A smooth cosine hump reaching `width` px either side of `centre`."""
    d = ring(u, centre, PERIOD)
    return 0.0 if d >= width else 0.5 + 0.5 * math.cos(math.pi * d / width)


def ripple(u, pitch):
    """A fine cosine wobble. `pitch` divides PERIOD."""
    return 0.5 + 0.5 * math.cos(2 * math.pi * u / pitch)


def flare(u, head, rise, fall):
    """Sharp head, long tail — a filament coming up fast and dying slowly, once per repeat.

    Asymmetry is the point: it gives the row a DIRECTION, which a symmetric pulse cannot, and the scroll
    then reads as travel rather than as blinking.
    """
    d = (u - head) % PERIOD
    if d > PERIOD / 2:
        d -= PERIOD
    if d < 0:
        return max(0.0, 1.0 + d / rise)
    return max(0.0, 1.0 - d / fall) ** 1.4


def cyan_gain(u):
    """Always lit, with one slow swell running the length of it. The building's baseline strip, so it is
    the one that must never look like it is flashing."""
    return 0.64 + 0.36 * swell(u, 18.0, 24.0)


def magenta_gain(u):
    """Four short lamps a repeat, glow bleeding across the gaps rather than a hard on/off."""
    return 0.16 + 0.84 * lamp(u, 8.0, 10.0, 2.6, pitch=16)


def violet_gain(u):
    """Two long lamps a repeat with soft ends — half the count of magenta, so the two never beat against
    each other where they run side by side up the stair."""
    return 0.20 + 0.80 * lamp(u, 16.0, 21.0, 6.0, pitch=32)


def ice_gain(u):
    """Near-continuous with a fine 8 px ripple and one flare. Ice is used on handrails, where a dashed
    strip would read as a broken rail rather than a lit one."""
    return min(1.0, 0.70 + 0.10 * ripple(u, 8) + 0.26 * swell(u, 46.0, 12.0))


def amber_gain(u):
    """One asymmetric surge a repeat — the slowest rhythm on the page."""
    return 0.34 + 0.66 * flare(u, 20.0, 6.0, 30.0)


def green_gain(u):
    """Long, short, medium: an irregular run that never lines up with the even-pitch rows."""
    return 0.18 + 0.82 * max(lamp(u, 10.0, 18.0, 2.5),
                             lamp(u, 32.0, 6.0, 2.0),
                             lamp(u, 46.0, 10.0, 2.5))


def crimson_gain(u):
    """Two unequal swells with a deep trough between them — a heartbeat rather than a metronome."""
    return min(1.0, 0.26 + 0.74 * max(swell(u, 12.0, 13.0), swell(u, 40.0, 17.0)))


def chase_seg(u):
    """Which of row 7's six segments column `u` falls in."""
    u %= PERIOD
    for k in range(CHASE_SEGS):
        if u < CHASE_X[k + 1]:
            return k
    return CHASE_SEGS - 1


def chase_gain(u):
    """Each segment lit from a dark gap, brightest just past its head and fading to its tail — so the
    run reads as six separate lamps handing off, not as a rainbow band."""
    k = chase_seg(u)
    x0, x1 = CHASE_X[k], CHASE_X[k + 1]
    p, w = (u % PERIOD) - x0, float(x1 - x0)
    gate = max(0.0, min(1.0, p / 1.7, (w - p) / 1.7))
    # Overdriven and then clamped, so the head of a segment reaches a FULL-brightness core rather than
    # 94% of one. Row 7 lands on the truss and the sweep beams — the two places on the club where the
    # light is meant to be looked straight at — and it is the only row whose gain never sits at 1.0 by
    # construction, so it is the only one that needs saying.
    return min(1.0, 0.10 + 0.98 * gate * (1.0 - 0.38 * p / w))


ROW_GAIN = (cyan_gain, magenta_gain, violet_gain, ice_gain,
            amber_gain, green_gain, crimson_gain, chase_gain)


# ---- painting ------------------------------------------------------------------------------------

def zone_at(zones, dx):
    """The palette covering column `dx`. Rows 0-6 hand in one zone spanning the whole repeat; row 7
    hands in six."""
    for x0, x1, pal in zones:
        if x0 <= dx < x1:
            return pal
    return zones[-1][2]


def strip(row, zones):
    """Paint one colour row, in four passes, and stamp the result across the page.

    The order matters. The section goes down at FULL brightness first and the grain lands on top of it,
    and only then is the U rhythm multiplied over the lot — so a speck sitting in a dark gap comes out
    dark. Draw the rhythm first and the grain floats over it as bright dots in the gaps, which at 1x
    looks like noise and on the model looks like a failing tube.

    Everything is confined to the leftmost PERIOD px and then copied, which is what makes the tiling
    structural: there is no way for a rhythm, or for a grain dot, to disagree with its own wrap.
    """
    y0 = row * ROW_H
    gain = ROW_GAIN[row]

    for dx in range(PERIOD):
        pal = zone_at(zones, dx)
        for dy in range(ROW_H):
            t, w = SECTION[dy]
            c = mix(mix(pal['chan'], pal['core'], t), pal['peak'], w)
            draw.point((dx, y0 + dy), fill=c + (255,))

    # Grain, per zone so row 7's specks take the colour of the segment they land on. `speckle` stays
    # inside the rect it is given; every rect here is inside this row, because ImageDraw does not clip
    # and a dot one pixel low is another strip's colour on some other part of the building.
    for x0, x1, pal in zones:
        wide = x1 - x0
        speckle(draw, rnd, (x0, y0 + LIT_TOP, x1, y0 + LIT_BOT),
                max(3, round(wide * 0.42)), pal['lit'], size=(1, 1))
        speckle(draw, rnd, (x0, y0, x1, y0 + INSET + 2),
                max(1, round(wide * 0.14)), pal['dark'], size=(1, 1))
        speckle(draw, rnd, (x0, y0 + ROW_H - INSET - 2, x1, y0 + ROW_H),
                max(1, round(wide * 0.14)), pal['dark'], size=(1, 1))

    for dx in range(PERIOD):
        g = gain(dx)
        chan = zone_at(zones, dx)['chan']
        for dy in range(ROW_H):
            r, gr, b, _ = img.getpixel((dx, y0 + dy))
            img.putpixel((dx, y0 + dy), mix(chan, (r, gr, b), g) + (255,))

    tile = img.crop((0, y0, PERIOD, y0 + ROW_H))
    for k in range(1, SIZE // PERIOD):
        img.paste(tile, (k * PERIOD, y0))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    solid = (CYAN, MAGENTA, VIOLET, ICE, AMBER, GREEN, CRIMSON)
    for row, pal in enumerate(solid):
        strip(row, [(0, PERIOD, pal)])
    strip(7, [(CHASE_X[k], CHASE_X[k + 1], CHASE_PAL[k]) for k in range(CHASE_SEGS)])

    img.save(OUT)
    print(f'wrote {OUT} {img.size} {img.mode}')


if __name__ == '__main__':
    main()
