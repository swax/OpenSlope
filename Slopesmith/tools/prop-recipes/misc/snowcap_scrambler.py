"""Snowcap Scrambler — a three-car animated mountaintop carnival ride.

    python Slopesmith/tools/prop-recipes/misc/snowcap_scrambler_atlas.py
    python Slopesmith/tools/prop-recipes/check.py snowcap_scrambler
    python Slopesmith/tools/prop-recipes/build_all.py snowcap_scrambler

The platform makes one revolution in ten seconds. Three cars inherit that orbit and add their own
whole-number turns over the same window, which is the hierarchy the RE canaries made safe to author:

    static body
      platform turn  +1 / 10 s
        cyan car     -3 / 10 s
        orange car   +2 / 10 s
        magenta car  -2 / 10 s

Every animated child turns about one plain local axis. The mounts carry the pivots and parent chain;
the channel never has to mix a rest tilt into an Euler rotation the hardware will ignore.

## Budget and page

This is a hero set-piece rather than a forest stamp, but it stays below the shipped 1662-triangle
ELYSIUM snowcat. One 128x128 page serves the entire ride as a repeated trim sheet. The cars are made
legible by their lopsided noses, seat backs and broad painted slashes, because a symmetric tub can spin
perfectly while looking stationary.

## Frame

X/Y are the platform plane, Z is up, base at z=0. The footprint is just under 10 m and the snowflake
mast reaches 3.3 m. Place it as a visual effect host, not a rideable solid: moving prop collision bodies
remain separate work, while the model clip animates in Preview, Unity and a repacked ISO today.
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
from _lib import Build, box, cylinder, emitter, finish, panels, tube   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')
TEX = os.path.join(BUILD, 'snowcap_scrambler.png')
GLB = os.path.join(PROPS, 'SnowcapScrambler.glb')
NAME = 'SnowcapScrambler'

GRID = panels(4, 4)
P_DECK, P_TRIM, P_METAL, P_DARK = GRID[0]
P_CYAN, P_ORANGE, P_MAGENTA, P_SEAT = GRID[1]
P_SNOW, P_LIGHT, P_HAZARD, P_GLASS = GRID[2]

PLATFORM_PIVOT = (0.0, 0.0, 0.61)
CAR_RADIUS = 2.75
CAR_Z = 1.10
CAR_RATES = (-0.30, 0.20, -0.20)
CAR_PANELS = (P_CYAN, P_ORANGE, P_MAGENTA)

b = Build()


@contextlib.contextmanager
def placed(x, y, yaw=0.0):
    """Build around local zero, then rotate/translate the new geometry and its facing claims together."""
    vert0, face0 = len(b.verts), len(b.faces)
    yield
    c, s = math.cos(yaw), math.sin(yaw)
    for i in range(vert0, len(b.verts)):
        vx, vy, vz = b.verts[i]
        b.verts[i] = (x + c * vx - s * vy, y + s * vx + c * vy, vz)
    for i in range(face0, len(b.faces)):
        nx, ny, nz = b.out[i]
        b.out[i] = (c * nx - s * ny, s * nx + c * ny, nz)


def build_car(x, y, yaw, panel):
    """One deliberately lopsided two-seat tub, authored around its own turn pivot."""
    with placed(x, y, yaw):
        # The tapered drum is the broad coloured read. A solid top is intentional at this budget: the
        # dark seat pad and high rear bolster turn it into a cockpit without spending an inner wall.
        cylinder(b, 10, 0.75, 1.34, 0.78, 1.08, panel, panel_cap=P_SEAT,
                 cap_bottom=True, cap_top=True)
        box(b, (0.0, -0.28, 1.40), (1.16, 0.68, 0.13), P_SEAT, taper=(0.94, 0.92))
        box(b, (0.0, -0.60, 1.64), (1.20, 0.18, 0.62), P_SEAT,
            taper=(0.82, 0.92), shear=(0.0, -0.05))

        # A proud nose and a V bumper make the turn readable even when texture filtering erases the slash.
        box(b, (0.0, 0.90, 1.30), (0.86, 0.62, 0.42), panel,
            taper=(0.68, 0.52), shear=(0.0, 0.09))
        tube(b, [(-0.50, 1.04, 1.22), (0.0, 1.22, 1.15), (0.50, 1.04, 1.22)],
             5, 0.055, P_METAL, closed_ends=True)

        # Shared centre handle: chunky enough to survive at 128px, cheap enough to repeat three times.
        tube(b, [(0.0, 0.04, 1.38), (0.0, 0.04, 1.76)], 5, 0.060, P_DARK,
             closed_ends=True)
        tube(b, [(-0.34, 0.04, 1.75), (0.34, 0.04, 1.75)], 5, 0.045, P_METAL,
             closed_ends=True)


# ---- the stationary machine ----------------------------------------------------------------------

with b.part('snow plinth'):
    cylinder(b, 16, 0.0, 0.20, 4.90, 4.74, P_SNOW, panel_cap=P_SNOW,
             cap_bottom=True, cap_top=True)

with b.part('base housing'):
    cylinder(b, 16, 0.20, 0.48, 4.70, 4.56, P_HAZARD, panel_cap=P_DARK,
             cap_bottom=True, cap_top=True)

with b.part('centre mast'):
    cylinder(b, 8, 0.46, 3.10, 0.22, 0.14, P_HAZARD, panel_cap=P_LIGHT, cap_top=True)
    cylinder(b, 8, 2.92, 3.18, 0.30, 0.24, P_LIGHT, panel_cap=P_LIGHT,
             cap_bottom=True, cap_top=True)

with b.part('snowflake crown'):
    # Three bars, rather than twelve tiny branches: at course distance they merge into one bright asterisk.
    for yaw in (0.0, math.pi / 3, 2 * math.pi / 3):
        with placed(0.0, 0.0, yaw):
            tube(b, [(-0.70, 0.0, 3.20), (0.70, 0.0, 3.20)], 5, 0.065, P_LIGHT,
                 closed_ends=True)


# ---- the moving hierarchy ------------------------------------------------------------------------

with b.spin(PLATFORM_PIVOT, (0.0, 0.0, 1.0), 0.10) as platform:
    with b.part('turntable'):
        cylinder(b, 16, 0.50, 0.72, 4.35, 4.35, P_TRIM, panel_cap=P_DECK,
                 cap_bottom=True, cap_top=True)
        cylinder(b, 12, 0.72, 1.02, 0.58, 0.46, P_METAL, panel_cap=P_LIGHT,
                 cap_bottom=True, cap_top=True)

    with b.part('sweep arms'):
        for i in range(3):
            a = 2 * math.pi * i / 3
            x, y = CAR_RADIUS * math.cos(a), CAR_RADIUS * math.sin(a)
            tube(b, [(0.0, 0.0, 0.80), (x, y, 0.80)], 6, 0.12, P_METAL,
                 closed_ends=True)

    for i, (rate, panel) in enumerate(zip(CAR_RATES, CAR_PANELS)):
        a = 2 * math.pi * i / 3
        x, y = CAR_RADIUS * math.cos(a), CAR_RADIUS * math.sin(a)
        # Local +Y initially points away from the centre. The nested context makes `platform` the
        # implicit parent, so this car first orbits around zero and then spins at its own pivot.
        with b.spin((x, y, CAR_Z), (0.0, 0.0, 1.0), rate):
            with b.part(('cyan', 'orange', 'magenta')[i] + ' car'):
                build_car(x, y, a - math.pi / 2, panel)


finish(b, NAME, TEX, GLB, emitters=[emitter(
    at=(0.0, 0.0, 3.22),
    aim=(0.0, 0.0, 1.0),
    speed=4.2,
    spread=(1.5, 1.5, 0.8),
    gravity=-1.2,
    life=(3.0, 0.8),
    size=(0.20, 0.10),
    count=40,
    jitter=(0.18, 0.18, 0.08),
    sprite='snfl',
)])
