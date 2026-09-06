"""
Snag — a dead standing trunk, snapped off partway up, with broken branch stubs.

    python Slopesmith/tools/prop-recipes/trees/snag_atlas.py    # paint the atlas (system Python)
    exec(open(P).read(), {'__file__': P})                       # build (inside Blender)

## The cheapest realism in the set

A burnt snag is worth almost nothing in triangles, and the platform's own budget agrees: 26 for a
bare trunk, plus four separate 22-42 triangle stubs placed against
it. Dead wood is what stops a treeline reading as a plantation, and it costs a fraction of a live tree
because there is no canopy to build.

The one SOLID tree in the set, so it is also the one that gets the strong guard. Every other tree here
is alpha-cut sheets, which enclose no volume and can only be checked face by face; this one is closed
tubes and could be volume-tested — except its stubs are open where they meet the trunk, so it declares
`closed=False` and leans on the per-face check like the rest. Capping the buried ends purely to satisfy
a guard would be spending triangles on faces nothing can see.

## Shape

Broken, not tapered to a point: the trunk keeps most of its girth to the break (0.165 down to 0.105 m,
against a live tree's taper to 0.03), because a snapped trunk stops rather than thins. Three splinter
spikes on the top and four stubs at mixed heights and angles, the lower ones longer — the fine upper
branches rot off first, so what survives on an old snag is the heavy lower structure.

## Frame

+Z up, base at z=0. 1.07 W x 0.73 L x 4.28 H m, 125 tris — far under the 272-384 band, as it should be.
"""

import math
import os
import sys

# Derived, not hardcoded, so the folders can move. `exec(open(p).read(), {'__file__': p})` is
# what makes this work — a bare exec() defines no __file__.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # _lib, _atlas, build/ and props/ live one level up, shared by every prop
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
import importlib          # noqa: E402
import _lib               # noqa: E402
importlib.reload(_lib)    # Blender stays open between runs and would otherwise hold a stale library
from _lib import Build, finish, panels, pyramid, tapered_trunk, tube   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'snag.png')
GLB = os.path.join(PROPS, 'Snag.glb')
NAME = 'Snag'

GRID = panels(2, 2)
P_BARK, P_SPLINTER = GRID[0][0], GRID[0][1]
P_GRAIN, P_SILVER = GRID[1][0], GRID[1][1]

TRUNK_SIDES, TRUNK_SEGS = 5, 4
TRUNK_TOP = 4.10
TRUNK_R0, TRUNK_R1 = 0.165, 0.105       # barely tapered: a snapped trunk stops, it does not thin

# (height, yaw in degrees, length, rise in degrees, radius) — lower stubs survive longest and run
# longest, because the fine upper branches rot off an old snag first.
#
# Short and THICK. A stub is the broken butt of a limb, not the limb: it wants to read as a stump
# against the trunk it grew from, and anything slender enough to look like a branch reads as a rod
# stuck through the tree. These run 0.05-0.075 m radius against the trunk's 0.165 — roughly a third of
# its girth, which is about what a real limb junction is.
STUBS = (
    (1.32, 24.0, 0.52, 16.0, 0.075),
    (2.05, 152.0, 0.44, 24.0, 0.066),
    (2.78, 268.0, 0.34, 32.0, 0.057),
    (3.44, 76.0, 0.26, 40.0, 0.048),
)


def radius(z):
    return TRUNK_R0 + (TRUNK_R1 - TRUNK_R0) * (z / TRUNK_TOP)


b = Build()

with b.part('trunk'):
    tapered_trunk(b, TRUNK_SIDES, TRUNK_SEGS, 0.0, TRUNK_TOP, TRUNK_R0, TRUNK_R1,
                  P_BARK, panel_cap=P_GRAIN, cap_top=True)

with b.part('stubs'):
    for z, yaw_deg, length, rise_deg, r in STUBS:
        yaw, rise = math.radians(yaw_deg), math.radians(rise_deg)
        inner = radius(z) - 0.03          # start inside the bark so the joint is not a floating ring
        tip = inner + length * math.cos(rise)
        tube(b, [(inner * math.cos(yaw), inner * math.sin(yaw), z),
                 (tip * math.cos(yaw), tip * math.sin(yaw), z + length * math.sin(rise))],
             4, r, P_SILVER, closed_ends=True)

with b.part('splinters'):
    # The break itself. Four stubby spikes of raw wood off the end grain at different heights, so the
    # top reads as snapped rather than sawn — a flat cap is the clearest tell of a cut stump. Stubby,
    # not sharp: one tall spike is a sharpened pencil, several short uneven ones are a fracture.
    for k, (dx, dy, half, height) in enumerate(((0.034, 0.016, 0.055, 0.19),
                                                (-0.030, 0.036, 0.048, 0.13),
                                                (-0.010, -0.042, 0.042, 0.09),
                                                (0.014, -0.014, 0.038, 0.15))):
        pyramid(b, dx, dy, TRUNK_TOP - 0.01, half, height, k * 0.9, P_SPLINTER)

finish(b, NAME, TEX, GLB, roughness=0.96, closed=False, alpha=False)
