"""
Snowmobile — a placeable prop for the ski-resort library.

    python Slopesmith/tools/prop-recipes/misc/snowmobile_atlas.py                                   # paint the atlas (system Python)
    P = r'C:\\your\\checkout\\Slopesmith\\tools\\prop-recipes\\misc\\snowmobile.py'  # build (inside Blender);
    exec(open(P).read(), {'__file__': P})                                           # __file__ is required (../README.md)

## Budget

Measured off the shipped levels, hero props run far heavier than the ~350-triangle average:

    Mdl_Vehicle_SnowCat  (ELYSIUM)   1662 tris
    Mdl_Vehicle_SnowCatB (GARI)      3216 tris
    Mdl_Prepbench        (GARI)      3384 tris

So a sled has room for real skis, a real track and handlebars rather than faked ones. It should still
land well under the groomers it parks next to — it is a smaller machine and should read as one.

## Frame

X = width, +Y = forward, Z = up, base at z=0. glTF is Y-up metres and Slopesmith is too; Blender's
exporter does the Z-up→Y-up turn, so nothing here compensates for orientation.

Roughly 1.2 m wide, 3.0 m long, 1.3 m tall — a real sled, not a scaled-up one. Shift-scroll resizes in
the editor; `SCALE` below re-bakes.

## Symmetry

Skis, spindles and their mounts are built on the +X side ONLY and mirrored with `mirror_x`, which
reverses the copied faces' index order. That reversal is the whole reason the helper exists: a mirror
is orientation-reversing, so a naive copy would leave the entire right-hand side wound inside-out and
therefore lit ambient-only dark, exactly the way a whole batch of GLB imports once shipped.
"""

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
from _lib import (Build, box, extrude_profile, finish, mirror_x,   # noqa: E402
                  panels, quad, tube)

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'snowmobile.png')
GLB = os.path.join(PROPS, 'Snowmobile.glb')
NAME = 'Snowmobile'

GRID = panels(4, 4)
P_BODY, P_DARK, P_TRACK, P_SEAT = GRID[0][0], GRID[0][1], GRID[0][2], GRID[0][3]
P_SKI, P_METAL, P_GLASS, P_LIGHT = GRID[1][0], GRID[1][1], GRID[1][2], GRID[1][3]
P_TUNNEL, P_VENT = GRID[2][0], GRID[2][1]

# Everything that gives a sled its silhouette is a SIDE view, so the big masses are swept profiles
# rather than stacked boxes: a real machine is a wedge — low and flat at the tail, rising through the
# cowling to the handlebars, nose dropping away. Boxes of comparable height read as a pile of crates.

# The track loop: a long flat ground run, only ~0.3 m tall, ramped at the front and rounded at the tail.
TRACK = [(-1.34, 0.02), (0.24, 0.02), (0.40, 0.10), (0.44, 0.22), (0.36, 0.30),
         (-1.28, 0.30), (-1.44, 0.22), (-1.48, 0.10)]

# The cowling: rises from the footwell to the bar riser, then falls away over the nose.
BODY = [(-0.15, 0.42), (0.78, 0.42), (1.12, 0.38), (1.20, 0.56), (0.98, 0.80), (0.56, 0.96),
        (0.06, 0.99), (-0.15, 0.82)]

# The seat: a wedge sloping down toward the tail, not a slab.
SEAT = [(-1.30, 0.44), (-0.08, 0.44), (-0.04, 0.64), (-0.26, 0.80), (-1.08, 0.74), (-1.32, 0.60)]

# One ski, +X side. Flat bottom, upturned tip, thin.
SKI = [(-0.40, 0.00), (0.46, 0.00), (0.66, 0.08), (0.74, 0.20), (0.60, 0.20), (0.40, 0.10),
       (-0.40, 0.06)]

b = Build()

with b.part('track'):
    extrude_profile(b, TRACK, 0.21, P_TRACK, P_DARK)

with b.part('tunnel'):
    # a thin plate over the track, plus the running boards the rider stands on
    box(b, (0.0, -0.52, 0.375), (0.46, 1.64, 0.15), P_TUNNEL)
    box(b, (0.0, -0.26, 0.32), (0.92, 1.00, 0.06), P_DARK)
    # rear snow flap. Corner order runs bottom-edge first so the face looks BACK, not into the track.
    quad(b, (-0.24, -1.46, 0.18), (0.24, -1.46, 0.18), (0.24, -1.32, 0.45), (-0.24, -1.32, 0.45),
         P_DARK, (0.0, -0.9, 0.45))

with b.part('body'):
    extrude_profile(b, BODY, 0.40, P_BODY, P_BODY)
    # Side vents on the cowling flanks, a hair proud of the surface so they do not z-fight. The two
    # sides are wound in opposite orders — the same reason mirror_x reverses, written out by hand
    # because these two faces are not a mirrored pair of anything.
    quad(b, (0.405, 0.30, 0.46), (0.405, 0.66, 0.46), (0.405, 0.66, 0.62), (0.405, 0.30, 0.62),
         P_VENT, (1.0, 0.0, 0.0))
    quad(b, (-0.405, 0.30, 0.62), (-0.405, 0.66, 0.62), (-0.405, 0.66, 0.46), (-0.405, 0.30, 0.46),
         P_VENT, (-1.0, 0.0, 0.0))

with b.part('seat'):
    extrude_profile(b, SEAT, 0.27, P_SEAT, P_SEAT)

with b.part('windshield'):
    # mounted on the cowling's top-rear lip, leaning back over the bars
    quad(b, (-0.19, -0.06, 1.22), (0.19, -0.06, 1.22), (0.23, 0.09, 1.00), (-0.23, 0.09, 1.00),
         P_GLASS, (0.0, 0.82, 0.57))

with b.part('headlight'):
    quad(b, (-0.17, 1.21, 0.62), (0.17, 1.21, 0.62), (0.19, 1.25, 0.44), (-0.19, 1.25, 0.44),
         P_LIGHT, (0.0, 0.55, 0.84))

with b.part('handlebars'):
    tube(b, [(-0.34, 0.06, 1.02), (-0.11, 0.13, 1.11), (0.11, 0.13, 1.11), (0.34, 0.06, 1.02)],
         6, 0.028, P_METAL, closed_ends=True)
    tube(b, [(0.0, 0.18, 0.96), (0.0, 0.14, 1.10)], 6, 0.036, P_METAL)

with b.part('skis + suspension'):
    right = len(b.faces)                       # everything from here is mirrored to the left side
    extrude_profile(b, SKI, 0.055, P_SKI, P_SKI, x=0.48, y=0.66, z=0.0)
    tube(b, [(0.48, 0.66, 0.06), (0.44, 0.62, 0.28), (0.31, 0.55, 0.48)], 6, 0.034, P_METAL)
    tube(b, [(0.48, 0.66, 0.16), (0.16, 0.42, 0.44)], 5, 0.026, P_METAL)
    mirror_x(b, right)

finish(b, NAME, TEX, GLB)
