"""Snowcap Pirate Ship — an animated mountaintop pendulum ride.

    python Slopesmith/tools/prop-recipes/misc/snowcap_pirate_ship_atlas.py
    python Slopesmith/tools/prop-recipes/check.py snowcap_pirate_ship
    python Slopesmith/tools/prop-recipes/build_all.py snowcap_pirate_ship

The static blue A-frame carries one moving assembly: hangers, hull, benches and rails swing ±55 degrees
about the crosswise axle over a 4.8-second native model clip. The authored pose is the bottom crossing,
so attaching or looping the effect never pops the ship to an apex.

## Budget and frame

This is a hero set-piece in the same class as the Snowcap Scrambler, but still targets the shipped
snowcat budget rather than modern fairground-detail density. One 128x128 trim sheet serves the ride.

X is bow-to-stern, Y is across the deck and Z is up. The rest footprint is about 8 x 4.6 m, the axle is
5.45 m high, and the raised ship reaches roughly 10 m while animated. It is a visual-effect host; moving
collision remains separate work.
"""

import contextlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
import importlib          # noqa: E402
import _lib               # noqa: E402
importlib.reload(_lib)
from _lib import Build, box, extrude_profile, finish, panels, quad, tube   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')
TEX = os.path.join(BUILD, 'snowcap_pirate_ship.png')
GLB = os.path.join(PROPS, 'SnowcapPirateShip.glb')
NAME = 'SnowcapPirateShip'

GRID = panels(4, 4)
P_HULL, P_RED, P_WOOD, P_STEEL = GRID[0]
P_GOLD, P_DECK, P_SEAT, P_ROPE = GRID[1]
P_SNOW, P_LIGHT, P_SKULL, P_DARK = GRID[2]
P_SUPPORT, P_HAZARD, P_FLAG = GRID[3][:3]

PIVOT = (0.0, 0.0, 5.45)
SWING_DEGREES = 55.0
SWING_SECONDS = 4.8

# Side silhouette of the hull, typed stern-to-bow around the keel and back along the gunwale. It is
# swept across the width then yawed so the profile becomes X/Z and the sweep becomes Y.
HULL = [(-3.25, 2.64), (-2.90, 1.90), (-2.20, 1.56), (-1.10, 1.36), (0.0, 1.27),
        (1.10, 1.36), (2.20, 1.56), (2.90, 1.90), (3.25, 2.64), (2.54, 2.43),
        (-2.54, 2.43)]

b = Build()


@contextlib.contextmanager
def placed(x=0.0, y=0.0, yaw=0.0):
    """Rotate/translate new recipe geometry and its expected-facing vectors together."""
    vert0, face0 = len(b.verts), len(b.faces)
    yield
    c, s = math.cos(yaw), math.sin(yaw)
    for i in range(vert0, len(b.verts)):
        vx, vy, vz = b.verts[i]
        b.verts[i] = (x + c * vx - s * vy, y + s * vx + c * vy, vz)
    for i in range(face0, len(b.faces)):
        nx, ny, nz = b.out[i]
        b.out[i] = (c * nx - s * ny, s * nx + c * ny, nz)


# ---- stationary frame -----------------------------------------------------------------------------

with b.part('snow plinth'):
    box(b, (0.0, 0.0, 0.12), (7.9, 4.6, 0.24), P_SNOW, taper=(0.96, 0.94))

with b.part('footings'):
    for y in (-1.72, 1.72):
        for x in (-2.08, 2.08):
            box(b, (x, y, 0.34), (0.78, 0.72, 0.44), P_HAZARD, taper=(0.82, 0.82))

with b.part('a-frame supports'):
    for y in (-1.72, 1.72):
        tube(b, [(-2.08, y, 0.48), (0.0, y, PIVOT[2])], 7, 0.15, P_SUPPORT,
             closed_ends=True)
        tube(b, [(2.08, y, 0.48), (0.0, y, PIVOT[2])], 7, 0.15, P_SUPPORT,
             closed_ends=True)
        tube(b, [(-1.48, y, 1.88), (1.48, y, 1.88)], 6, 0.075, P_STEEL,
             closed_ends=True)
        tube(b, [(-1.05, y, 2.95), (1.05, y, 2.95)], 6, 0.070, P_STEEL,
             closed_ends=True)

with b.part('axle + marquee'):
    tube(b, [(0.0, -2.02, PIVOT[2]), (0.0, 2.02, PIVOT[2])], 10, 0.20, P_STEEL,
         closed_ends=True)
    box(b, (0.0, 0.0, 5.72), (1.28, 0.42, 0.34), P_GOLD, taper=(0.86, 0.90))
    # Three oversized bulbs on each face read as a lit crown without spending geometry on tiny spheres.
    for x in (-0.42, 0.0, 0.42):
        box(b, (x, -0.225, 5.73), (0.18, 0.08, 0.18), P_LIGHT)
        box(b, (x, 0.225, 5.73), (0.18, 0.08, 0.18), P_LIGHT)


# ---- one rigid pendulum assembly -------------------------------------------------------------------

with b.swing(PIVOT, (0.0, 1.0, 0.0), SWING_DEGREES, SWING_SECONDS):
    with b.part('pendulum hangers'):
        for y in (-0.66, 0.66):
            tube(b, [(0.0, y, PIVOT[2]), (-1.16, y, 2.54)], 7, 0.085, P_GOLD,
                 closed_ends=True)
            tube(b, [(0.0, y, PIVOT[2]), (1.16, y, 2.54)], 7, 0.085, P_GOLD,
                 closed_ends=True)
        tube(b, [(0.0, -0.84, PIVOT[2]), (0.0, 0.84, PIVOT[2])], 8, 0.225, P_DARK,
             closed_ends=True)

    with b.part('hull'):
        with placed(yaw=math.pi / 2):
            extrude_profile(b, HULL, 0.72, P_RED, P_HULL)
        box(b, (0.0, 0.0, 2.48), (5.10, 1.30, 0.14), P_DECK)
        # Gold rub rails sharpen the long silhouette and make its changing angle obvious at course distance.
        for y in (-0.75, 0.75):
            tube(b, [(-2.72, y, 2.45), (2.72, y, 2.45)], 5, 0.045, P_GOLD,
                 closed_ends=True)

    with b.part('skull medallions'):
        # Opposite winding on the two sides keeps both plaques facing away from the hull.
        quad(b, (-0.48, 0.755, 1.48), (-0.48, 0.755, 2.23), (0.48, 0.755, 2.23),
             (0.48, 0.755, 1.48), P_SKULL, (0.0, 1.0, 0.0))
        quad(b, (-0.48, -0.755, 2.23), (-0.48, -0.755, 1.48), (0.48, -0.755, 1.48),
             (0.48, -0.755, 2.23), P_SKULL, (0.0, -1.0, 0.0))

    with b.part('benches'):
        for x in (-1.78, -0.90, 0.0, 0.90, 1.78):
            box(b, (x, 0.0, 2.70), (0.18, 1.14, 0.40), P_SEAT, taper=(0.92, 0.96))

    with b.part('guard rails'):
        for y in (-0.69, 0.69):
            # Three straight tubes meet cleanly; one sharply bent sweep folds its inside corner.
            tube(b, [(-2.54, y, 2.54), (-2.36, y, 3.12)], 5, 0.045, P_ROPE, closed_ends=True)
            tube(b, [(-2.36, y, 3.12), (2.36, y, 3.12)], 5, 0.045, P_ROPE, closed_ends=True)
            tube(b, [(2.36, y, 3.12), (2.54, y, 2.54)], 5, 0.045, P_ROPE, closed_ends=True)
            for x in (-1.75, -0.88, 0.0, 0.88, 1.75):
                tube(b, [(x, y, 2.50), (x, y, 3.11)], 5, 0.032, P_STEEL,
                     closed_ends=True)

    with b.part('prow + stern'):
        for sign in (-1.0, 1.0):
            box(b, (sign * 2.78, 0.0, 2.80), (0.52, 1.12, 0.54), P_HULL,
                taper=(0.56, 0.82), shear=(sign * 0.12, 0.0))
            tube(b, [(sign * 2.58, 0.0, 2.82), (sign * 3.18, 0.0, 3.34)], 6, 0.070,
                 P_GOLD, closed_ends=True)
        # One crooked red pennant breaks the otherwise mirrored silhouette and sells the pirate theme.
        tube(b, [(2.96, 0.0, 3.18), (2.96, 0.0, 3.88)], 5, 0.035, P_STEEL,
             closed_ends=True)
        box(b, (3.15, 0.0, 3.70), (0.42, 0.07, 0.28), P_FLAG, taper=(0.35, 1.0),
            shear=(0.08, 0.0))


finish(b, NAME, TEX, GLB)
