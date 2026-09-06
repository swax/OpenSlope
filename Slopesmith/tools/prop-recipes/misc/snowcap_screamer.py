"""Snowcap Screamer — a three-car roller-coaster train for a Spline mover.

    python Slopesmith/tools/prop-recipes/misc/snowcap_screamer_atlas.py
    python Slopesmith/tools/prop-recipes/check.py snowcap_screamer
    python Slopesmith/tools/prop-recipes/build_all.py snowcap_screamer

Unlike every other recipe here this prop declares no motion of its own. It is posed by the **Spline
mover** (SSF MainType 2 / SubType 1), which rebuilds the placement's matrix from an authored motion
path every tick — so the ride is the route, drawn in the Effects editor over whatever terrain it
crosses, and the model only has to be built the way that node expects to find it.

## The frame the mover expects

Three facts out of `Trailmap/specs/230-level-ssf.md` shape the whole model, and each of them is a
silent wrong-looking-prop if it is missed:

- **+Y is the nose.** Yaw is `(yaw offset + pi/2) - the tangent's compass angle`, so at a zero offset
  the image of raw model **+Y** is the tangent. Raw +Y is Blender +Y here, so the train is built
  pointing down +Y and the mover needs no yaw offset at all. (The shipped MERQUER subway authors 1.62
  rad because its long axis is X; that is a lead-axis selector, not a trim.)
- **Pitch is applied about model X**, and is not re-derived from the yaw offset. A vehicle laid out
  along X would therefore ROLL on every gradient instead of pitching — which is why the subway
  disables pitch entirely. Laid out along Y, orientation mode 0 (follow yaw + pitch) is correct and
  the train noses into a dive.
- **Roll is hard-zeroed** and the spline's normal is never computed, so the train does not bank. Do
  not author a banked route expecting the cars to lean into it; they will not.

## Where z=0 is

The mover overwrites the placement's translation wholesale from the curve, so the model's own origin
IS the point that rides the rail. The importer re-centres a model horizontally on its bounding box
and leaves height alone, so that origin lands mid-train at whatever z=0 the recipe chose. The wheels
are therefore built resting exactly on z=0 and the train rides with its wheels on the route line —
`check.py`'s `base z=` reading is load-bearing here for a different reason than usual.

The train is symmetric about y=0 on purpose. The bounding-box re-centring would otherwise shift the
origin a few centimetres off mid-train, and a mover puts the origin on the curve: the whole train
would sit slightly ahead of or behind where the path was drawn.

## Making it a ride

Draw a motion path (**Effects → + Add motion path**), select the train, **+ Add effect → Spline
mover**, which binds to the path. Then: end mode 1 (loop), orientation mode 0 (follow yaw + pitch),
speed to taste — 15 m/s is a brisk coaster, the shipped subway runs 35.

**Instance count is how you get more trains.** Copies share the one model and are spaced by
`arc length / count`, so 2 or 3 puts that many trains blocked evenly around the circuit, exactly as
Snowdream circulates 15 gondola chairs on one wire. Preview draws one copy for an authored prop
(`docs/026`); the disc and Unity draw them all.

## Budget and page

580 triangles — a third of ELYSIUM's 1662-triangle snowcat, spent almost entirely on three
repetitions of one car. One 128x128 page serves the train as a trim sheet. The lead car takes the
cream flank so the front is readable at distance, which matters more here than on a static prop: a
mover that reads as travelling backwards looks broken rather than stylised.

## Frame

+Y is the nose, +X across, Z up, wheels at z=0.
"""

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
from _lib import Build, box, extrude_profile, finish, panels, tube   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')
TEX = os.path.join(BUILD, 'snowcap_screamer.png')
GLB = os.path.join(PROPS, 'SnowcapScreamer.glb')
NAME = 'SnowcapScreamer'

GRID = panels(4, 4)
P_FLANK, P_BAND, P_STEEL, P_RUBBER = GRID[0]
P_SEAT, P_CHROME, P_SNOW, P_LAMP = GRID[1]
P_CREAM, P_HAZARD, P_GRILLE, P_DARK = GRID[2]

CAR_PITCH = 1.62
CARS = (CAR_PITCH, 0.0, -CAR_PITCH)        # index 0 is the lead car, at the +Y end
FLANKS = (P_CREAM, P_FLANK, P_FLANK)       # the lead car inverts the paint, so the nose reads
HALF_W = 0.46

WHEEL_N = 5
WHEEL_R = 0.12
WHEEL_X = 0.50
WHEEL_Y = 0.46
# A polygonal wheel has no vertex at its lowest angle unless the count happens to put one there, so
# the centre height is derived from the ring rather than assumed to be the radius. This is what makes
# `base z` exactly 0.00 — and on a mover that is not cosmetic: z=0 is the rail line the wheels ride.
WHEEL_Z = -WHEEL_R * min(math.sin(2 * math.pi * i / WHEEL_N) for i in range(WHEEL_N))

# The car's side silhouette, in (y, z). `extrude_profile` sweeps this along X, so the two CAP faces are
# the flanks — the broad surfaces anyone watching the ride from below actually reads — and the side
# faces are the thin band running over nose, roof, tail and belly. The seat well between (-0.26, 0.62)
# and (0.14, 0.60) makes the outline concave, which the library's ear-clipper handles; a fan from
# point 0 would silently invert two cap triangles there and ship them ambient-only dark.
CAR = [
    (-0.74, 0.26), (-0.74, 0.88), (-0.56, 1.02), (-0.32, 0.96),
    (-0.26, 0.62), (0.14, 0.60), (0.34, 0.78), (0.58, 0.80),
    (0.72, 0.62), (0.74, 0.40), (0.60, 0.26),
]

b = Build()

with b.part('chassis'):
    # Wide enough to reach over the wheels and hide their top halves, which is what turns four
    # outboard tubes into a bogie instead of four blocks bolted to the sides of a box.
    for y in CARS:
        box(b, (0.0, y, 0.235), (1.06, 1.16, 0.11), P_STEEL)

with b.part('bodies'):
    for y, flank in zip(CARS, FLANKS):
        extrude_profile(b, CAR, HALF_W, P_BAND, flank, y=y)

with b.part('seats'):
    for y in CARS:
        box(b, (0.0, y - 0.06, 0.645), (0.66, 0.40, 0.06), P_SEAT)

with b.part('lap bars'):
    for y in CARS:
        # Both ends are buried inside the body below the seat pan, so the tube is left open — capping
        # them would spend eight triangles a car on faces sealed inside solid geometry.
        tube(b, [(-0.30, y - 0.14, 0.58), (-0.26, y - 0.02, 0.98),
                 (0.26, y - 0.02, 0.98), (0.30, y - 0.14, 0.58)], 4, 0.045, P_CHROME)

with b.part('wheels'):
    for y in CARS:
        for dy in (WHEEL_Y, -WHEEL_Y):
            for side in (1.0, -1.0):
                x = side * WHEEL_X
                tube(b, [(x - side * 0.06, y + dy, WHEEL_Z), (x + side * 0.06, y + dy, WHEEL_Z)],
                     WHEEL_N, WHEEL_R, P_RUBBER, closed_ends=True)

with b.part('snow crust'):
    # On the headrest crest only. Snow settles on the silhouette, and at speed the roof line is the
    # one horizontal surface a viewer below the course ever sees.
    for y in CARS:
        box(b, (0.0, y - 0.50, 1.035), (0.60, 0.24, 0.045), P_SNOW, taper=(0.84, 0.78))

with b.part('couplings'):
    for lead, trail in zip(CARS, CARS[1:]):
        tube(b, [(0.0, trail + 0.74, 0.42), (0.0, lead - 0.74, 0.42)], 4, 0.055, P_STEEL)

with b.part('nose lamp'):
    box(b, (0.0, CARS[0] + 0.76, 0.56), (0.20, 0.14, 0.12), P_LAMP)

with b.part('tail cap'):
    # Matches the lamp's overhang exactly. Not decoration: the bounding box is what the importer
    # re-centres on, and a nose that reaches 9 cm further than the tail would put the origin — and so
    # the whole train — that far behind the curve it is supposed to be riding.
    box(b, (0.0, CARS[2] - 0.76, 0.56), (0.20, 0.14, 0.12), P_GRILLE)


finish(b, NAME, TEX, GLB)
