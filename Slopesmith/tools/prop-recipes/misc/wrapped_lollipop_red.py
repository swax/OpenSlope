"""Slightly larger-than-a-person tricolour swirl lollipop in a square clear wrapper.

Paint first:
    python Slopesmith/tools/prop-recipes/misc/wrapped_lollipop_red_atlas.py

Build through `tools/prop-recipes/build_all.py wrapped_lollipop_red` or execute this file inside Blender.
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
import importlib  # noqa: E402
import _lib  # noqa: E402
importlib.reload(_lib)
from _lib import Build, finish, panels, rect_uv, tube, uv  # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')
TEX = os.path.join(BUILD, 'wrapped_lollipop_red.png')
GLB = os.path.join(PROPS, 'WrappedLollipopRed.glb')
NAME = 'WrappedLollipopSwirl'

GRID = panels(2, 2)
P_CANDY_FACE, P_CANDY_EDGE = GRID[0]
P_STICK, P_WRAPPER = GRID[1]

N = 16
STICK_RADIUS = 0.045
STICK_TOP = 1.95
CANDY_RADIUS = 0.46
CANDY_HALF_DEPTH = 0.065
WRAPPER_HALF = 0.59


def candy_disk(b):
    """A low-poly cylinder standing in X/Z, with its axis along Y."""
    front_y, back_y = -CANDY_HALF_DEPTH, CANDY_HALF_DEPTH
    centre_front = b.vert(0, front_y, STICK_TOP)
    centre_back = b.vert(0, back_y, STICK_TOP)
    front, back = [], []
    for i in range(N):
        a = 2 * math.pi * i / N
        x, z = CANDY_RADIUS * math.cos(a), STICK_TOP + CANDY_RADIUS * math.sin(a)
        front.append(b.vert(x, front_y, z))
        back.append(b.vert(x, back_y, z))
    centre_uv = uv(P_CANDY_FACE, 0.5, 0.5)
    ring_uv = [uv(P_CANDY_FACE, 0.5 + 0.5 * math.cos(2 * math.pi * i / N),
                  0.5 + 0.5 * math.sin(2 * math.pi * i / N)) for i in range(N)]
    for i in range(N):
        j = (i + 1) % N
        b.face((centre_front, front[i], front[j]), (centre_uv, ring_uv[i], ring_uv[j]), (0, -1, 0))
        b.face((centre_back, back[j], back[i]), (centre_uv, ring_uv[j], ring_uv[i]), (0, 1, 0))
        t0, t1 = i / N, (i + 1) / N
        b.face((front[i], back[i], back[j], front[j]),
               (uv(P_CANDY_EDGE, t0, 0), uv(P_CANDY_EDGE, t0, 1),
                uv(P_CANDY_EDGE, t1, 1), uv(P_CANDY_EDGE, t1, 0)),
               (math.cos((i + 0.5) * 2 * math.pi / N), 0,
                math.sin((i + 0.5) * 2 * math.pi / N)))


def wrapper_sheet(b):
    """A centred sheet: the solid candy hides its middle while the clear square corners project past it."""
    y = 0.0
    z0, z1 = STICK_TOP - WRAPPER_HALF, STICK_TOP + WRAPPER_HALF
    base = len(b.verts)
    for point in ((-WRAPPER_HALF, y, z0), (WRAPPER_HALF, y, z0),
                  (WRAPPER_HALF, y, z1), (-WRAPPER_HALF, y, z1)):
        b.vert(*point)
    b.face((base, base + 1, base + 2, base + 3), rect_uv(P_WRAPPER), (0, -1, 0))


b = Build()
with b.part('white stick'):
    tube(b, [(0, 0, -0.14), (0, 0, STICK_TOP - 0.10)], 8, STICK_RADIUS, P_STICK, closed_ends=True)
with b.part('red yellow green swirl candy disk'):
    candy_disk(b)
with b.part('clear square wrapper'):
    wrapper_sheet(b)

finish(b, NAME, TEX, GLB, roughness=0.45, alpha=True)
