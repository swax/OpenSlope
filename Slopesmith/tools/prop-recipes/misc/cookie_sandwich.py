"""
Chocolate-chip cookie ice cream sandwich — a placeable prop for the ice cream level.

Run INSIDE Blender (the MCP bridge, or Blender's text editor). Pass `__file__`: the recipe derives
its own ROOT from it, and a bare exec raises NameError (../README.md).
    P = r'C:\\your\\checkout\\Slopesmith\\tools\\prop-recipes\\misc\\cookie_sandwich.py'
    exec(open(P).read(), {'__file__': P})

Paint the atlas first with the system Python — Blender's bundled interpreter has no Pillow:
    python Slopesmith/tools/prop-recipes/misc/cookie_sandwich_atlas.py

## Why it is shaped like this

The budget class this sits in, measured off the target platform: 88 v / 120 tris for a machine base,
160 v / 304 tris for the head, ~350 tris for the average GARI prop over its 648-model census. So the
budget here is ~170 triangles, one material, one 128x128 texture — a whole prop, not a part of one.

Two decisions carry the look:

- **12 sides, flat shaded, jittered radius.** A clean lathe reads as CAD; a per-angle radius wobble
  (deterministic, one seed) reads as baked dough. The wobble profile is shared between a puck's top and
  bottom rings, so the rim stays vertical and only the outline is irregular.
- **Chips are modelled AND painted.** Four-triangle pyramids give the silhouette that survives at
  distance; the chips painted into the top panel carry the read up close. Either alone looks wrong —
  geometry-only is too sparse to say "chocolate chip", texture-only goes flat the moment you get near it.

The ice cream is a barrel with a bulged middle ring and no caps: both ends are covered by a cookie, so
capping them would spend 24 triangles on faces nothing can see.

## Frame and scale

glTF is Y-up metres and so is Slopesmith, and the exporter converts from Blender's Z-up, so nothing here
compensates for orientation. 1 unit = 1 metre = 100 raw cm on import. Built base-at-z=0: the importer
recentres horizontally on the bounding box but leaves height alone, reading the lowest vertex to stand
the prop on the terrain.

RADIUS is the knob. 2.0 m gives a 4 m sandwich — boulder-sized, the scale an ice cream level wants its
food at. Re-run with a different value to re-bake, or just shift-scroll it in the editor.

Winding is checked by `_lib.finish` in RAW space, against the convention every shipped prop measures at.
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
from _lib import Build, barrel, finish, panels, puck, pyramid, wobble   # noqa: E402,F401

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'cookie_sandwich.png')
GLB = os.path.join(PROPS, 'CookieSandwich.glb')
NAME = 'CookieSandwich'

N = 12                 # sides — the silhouette/cost trade, and the chunkiness the budget wants
RADIUS = 2.00          # cookie radius in metres (a 4 m sandwich)
R_CREAM = 1.86         # inset, so the cookies overhang the way a real one does
T_COOKIE = 0.34
T_CREAM = 0.72
BULGE = 1.075          # the squeezed-out middle ring
DOME = 0.07            # centre vertex lift, so a cookie is not a flat disc

GRID = panels(2, 2)
P_TOP, P_SIDE = GRID[0][0], GRID[0][1]
P_CREAM, P_CHIP = GRID[1][0], GRID[1][1]

# Chocolate chips on the top cookie: (x, y, half-width, height, yaw). Placed by hand rather than
# scattered, because seven chips is few enough that an even spread beats a random one.
CHIPS = [
    (0.55, 0.35, 0.23, 0.10, 0.3),
    (-0.78, 0.62, 0.21, 0.09, 1.1),
    (0.10, -0.98, 0.24, 0.11, 2.0),
    (1.24, -0.34, 0.20, 0.08, 0.7),
    (-1.02, -0.88, 0.22, 0.10, 2.6),
    (-0.22, 1.18, 0.21, 0.09, 1.7),
    (0.98, 1.02, 0.19, 0.08, 0.4),
]

z0 = 0.0
z1 = z0 + T_COOKIE
z2 = z1 + T_CREAM
z3 = z2 + T_COOKIE

b = Build()
with b.part('cookie (bottom)'):
    puck(b, N, z0, z1, RADIUS, P_SIDE, P_TOP, wobble(N, 11, 0.055), dome=DOME)
with b.part('ice cream'):
    barrel(b, N, z1, z2, R_CREAM, P_CREAM, wobble(N, 23, 0.040), bulge=BULGE)
with b.part('cookie (top)'):
    puck(b, N, z2, z3, RADIUS, P_SIDE, P_TOP, wobble(N, 37, 0.055), dome=DOME)
with b.part('chips'):
    for cx, cy, half, height, yaw in CHIPS:
        # seated a hair into the dough, following the cap's shallow dome, so no gap shows at the join
        surface = z3 + DOME * max(0.0, 1.0 - math.hypot(cx, cy) / RADIUS)
        pyramid(b, cx, cy, surface - 0.025, half, height, yaw, P_CHIP)

finish(b, NAME, TEX, GLB)
