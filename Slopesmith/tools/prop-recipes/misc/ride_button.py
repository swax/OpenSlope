"""
Ride-over button — a floor fixture whose material switches state when a rider crosses it.

Run INSIDE Blender (the MCP bridge, or Blender's text editor):
    P = r'C:\\your\\checkout\\Slopesmith\\tools\\prop-recipes\\misc\\ride_button.py'
    exec(open(P).read(), {'__file__': P})

Paint the atlas first with the system Python — Blender's bundled interpreter has no Pillow:
    python Slopesmith/tools/prop-recipes/misc/ride_button_atlas.py

## Why it is shaped like this

Tokyo Megaplex's buttons are flat decals lying on the deck, invisible until you are on top of one. That
works there because the level is built around them; a PLACEABLE prop has to be findable from up the
slope, so this is a raised fixture instead: a hazard-striped housing plate with a lamp set proud of it.
The silhouette is what a rider steers at, and the lamp colour is what they read once they are close.

Two 8-sided pucks, 64 triangles all in. The budget class it sits in, measured off the target platform:
120 tris for a machine base, 86 for a whole photo booth, ~350 for the average GARI prop. A floor fitting
should cost a fraction of a booth, and this is well under it.

Eight sides rather than twelve because the housing reads as a plate, not a disc — the facets are the
style, and at 1.2 m across nobody is counting them. Both caps come radially mapped (`_lib.puck` uses
`radial_uv`), which is normally a hazard: concentric texture art lands as concentric rings and reads as
a vinyl record. Here that inverts, because a button IS concentric — the mapping paints the lamp's glow
ring and the plate's tread bands exactly where they belong with no per-vertex UV work.

## The flipbook

`finish(frames=2)` declares the material a two-frame STATE list, and the atlas is painted as a filmstrip
to match. What the prop does NOT declare is any playback: a frame list is a state list, and what plays
it is an SSF effect authored against the placement ([Trailmap: 410-texture-animation]). Attach the
editor's **Ride-over button** effect and crossing it flashes frame 1 and settles back the way the
megaplex ones do; attach nothing and it simply rests on green, which is also correct. That split is the
whole reason the recipe declares a count and no rate.

## Frame and scale

glTF is Y-up metres and so is Slopesmith, and the exporter converts from Blender's Z-up, so nothing here
compensates for orientation. 1 unit = 1 metre = 100 raw cm on import. Built base-at-z=0: the importer
recentres horizontally on the bounding box but leaves height alone, reading the lowest vertex to stand
the prop on the terrain — so the plate sits ON the snow and the lamp stands proud of it.

RADIUS is the knob. 0.62 m gives a 1.24 m fixture: wide enough that a rider crossing at speed cannot
thread past it, small enough to read as a fitting rather than a platform.

Winding is checked by `_lib.finish` in RAW space, against the convention every shipped prop measures at.
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
from _lib import Build, finish, panels, puck   # noqa: E402,F401

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'ride_button.png')
GLB = os.path.join(PROPS, 'RideButton.glb')
NAME = 'RideButton'

N = 8                  # sides — the plate reads as a fitting, and the facets are the style
FRAMES = 2             # the material's state list: rest, and what a crossing pulses to
RADIUS = 0.62          # housing radius in metres (a 1.24 m fixture)
R_LAMP = 0.46          # the lamp inset, so a ring of hazard-striped plate stays visible around it
H_PLATE = 0.05         # low enough to ride straight over
H_LAMP = 0.045         # proud of the plate, so the fixture has a silhouette from up the slope
DOME = 0.012           # a slight crown on the lamp, so it catches the light as a lens rather than a disc

GRID = panels(2, 2)
P_LAMP, P_LAMP_RIM = GRID[0][0], GRID[0][1]
P_PLATE, P_PLATE_RIM = GRID[1][0], GRID[1][1]

b = Build()
with b.part('plate'):
    puck(b, N, 0.0, H_PLATE, RADIUS, P_PLATE_RIM, P_PLATE)
with b.part('lamp'):
    # Seated ON the plate rather than sunk into it: the shared face would z-fight, and the plate's top
    # cap is a full fan anyway, so nothing is saved by cutting a hole for this to drop through.
    puck(b, N, H_PLATE, H_PLATE + H_LAMP, R_LAMP, P_LAMP_RIM, P_LAMP, dome=DOME)

finish(b, NAME, TEX, GLB, frames=FRAMES)
