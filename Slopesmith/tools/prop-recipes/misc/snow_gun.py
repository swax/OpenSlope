"""
Snow gun — a tower fan gun for the ski-resort library, and the prop that throws PARTICLES.

    python Slopesmith/tools/prop-recipes/misc/snow_gun_atlas.py   # paint the page (system Python)
    python Slopesmith/tools/prop-recipes/check.py snow_gun        # validate, no Blender needed

## The spray

The snow is a real emitter, not painted geometry: `emitter()` writes SSX's OWN `type2Sub0` payload — the
same field bag `Effects.json` stores — so the editor's particle runtime plays it unchanged and an
exported level ships an emitter rather than a trick. It rides in the GLB's glTF `extras`, which makes
the model self-describing: placing it attaches the effect instead of the effect being re-authored
against every gun someone stamps down.

Calibrated against a shipped emitter (COLLISION_LAB), which measures U20=1200 (12 m/s) and U32=-300
(-3 m/s^2): the engine runs its sprays well under true gravity, because a light particle has drag the sim
does not model, and at -9.8 the arc collapses to a stone's throw.

The muzzle is the only thing the geometry contributes to the spray — `MOUTH` and `THROW` are shared by
the barrel and the emitter, so the snow leaves the hole it is aimed out of.

## Budget

    Mdl_SnowBlower_Bottom (SNOW)   120 tris   the shipped snow blower's base
    Mdl_SnowBlower_Top    (SNOW)   320 tris   two objects, one of them animated
    GARI's 648-model average      ~350 tris

Guns line a piste in numbers, so this is deliberately at the light end — the detail budget goes into the
silhouette (mast, barrel, yoke) rather than into surface trim nothing will read from the middle of a run.

## Frame

+X is the THROW direction, Z is up, base at z=0.

About 1.5 m across the skid and 4.4 m to the top of the barrel — a real tower gun.
"""

import math
import os
import random
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
from _lib import (Build, box, cylinder, emitter, finish, panels,   # noqa: E402
                  tapered_trunk, tube, wobble)

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'snow_gun.png')
GLB = os.path.join(PROPS, 'SnowGun.glb')
NAME = 'SnowGun'
SEED = 9114

GRID = panels(4, 4)
P_STEEL, P_BARREL, P_FAN, P_SKID = GRID[0]
P_BOX, P_CABLE, P_SNOW, P_HAZARD = GRID[1]

# The spray leaves the barrel at this elevation and the barrel is built along the same axis, so the
# snow looks thrown by the muzzle rather than merely near it.
THROW = math.radians(24.0)
MOUTH = (1.44, 0.0, 3.92)

rnd = random.Random(SEED)
b = Build()

with b.part('drift'):
    cylinder(b, 8, 0.0, 0.22, 1.18, 0.94, P_SNOW, panel_cap=P_SNOW,
             factors=wobble(8, SEED, 0.14), cap_top=True)

with b.part('skid'):
    # The hazard stripe belongs on the skid's flanks, at the height someone walks into it. On the mast
    # it just makes a four-metre yellow pole, because that panel is stretched 12:1 up there and the
    # diagonals pull out into stripes.
    box(b, (0.0, 0.0, 0.19), (1.30, 0.95, 0.38),
        [P_SKID, P_SKID, P_HAZARD, P_HAZARD, P_HAZARD, P_HAZARD], skip=(0,))

with b.part('mast'):
    # A trunk is 5 sides x 4 segments; a mast wants the roundness more than the taper, so
    # this spends the same triangles the other way round.
    tapered_trunk(b, 8, 2, 0.38, 3.05, 0.20, 0.15, P_STEEL, panel_cap=P_STEEL)

with b.part('yoke'):
    box(b, (0.0, 0.0, 3.18), (0.46, 0.34, 0.26), P_STEEL)
    for sy in (-1, 1):
        box(b, (0.30, sy * 0.30, 3.44), (0.60, 0.08, 0.62), P_STEEL)

with b.part('barrel'):
    axis = (math.cos(THROW), 0.0, math.sin(THROW))
    back = tuple(MOUTH[i] - axis[i] * 1.34 for i in range(3))
    tube(b, [back, MOUTH], 10, 0.46, P_BARREL)

with b.part('fan'):
    # The fan sits just inside the mouth, as its own short capped tube. `tube(closed_ends=True)` fans
    # its panel as N identical wedges about the axis, which turns one drawn blade into a whole disc —
    # so the cheapest disc available is also the right shape for this.
    hub = tuple(MOUTH[i] - axis[i] * 0.30 for i in range(3))
    hub_back = tuple(MOUTH[i] - axis[i] * 0.42 for i in range(3))
    # And it TURNS, about the barrel's own axis through the middle of the hub. Slow for a fan on
    # purpose: the disc is eight identical wedges, so it repeats every 45 degrees and shows eight
    # times its own rate — 0.75 rev/s already reads as six flickers a second, and the engine's own
    # snow blower head, which has the same problem, runs at 2.
    fan_mid = tuple((hub[i] + hub_back[i]) / 2 for i in range(3))
    with b.spin(fan_mid, axis, 0.75):
        tube(b, [hub_back, hub], 8, 0.41, P_FAN, closed_ends=True)

with b.part('control box'):
    box(b, (0.0, -0.30, 1.30), (0.34, 0.26, 0.52), P_BOX)

with b.part('cable'):
    # Draped, not straight: a cable that leaves in a clean line reads as a pipe.
    tube(b, [(0.0, -0.42, 1.12), (0.16, -0.62, 0.72), (0.30, -0.66, 0.26), (0.52, -0.58, 0.06)],
         4, 0.045, P_CABLE)

# The particles are the whole point of the prop: they are what makes it read as a working machine
# rather than a sculpture of one, and they are visible from across the map.
PLUME_AIM = (math.cos(THROW), 0.0, math.sin(THROW))

finish(b, NAME, TEX, GLB,
       emitters=[emitter(
           at=MOUTH,
           aim=PLUME_AIM,
           speed=15.0,              # m/s out of the barrel
           spread=(2.6, 3.4, 2.2),  # a cone rather than a line, widest across the throw
           gravity=-3.4,            # the engine's own figure: what makes it arc instead of drop
           life=(2.6, 0.9),
           size=(0.55, 0.30),
           count=64,
           jitter=(0.10, 0.55, 0.55),   # born across the muzzle, not at one point
           sprite='snfl',           # the snowflake in the shared particle bank
       )])
