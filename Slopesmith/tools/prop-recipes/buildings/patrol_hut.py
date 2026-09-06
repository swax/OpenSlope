"""
Ski patrol hut — a placeable prop for the ski-resort library.

    python Slopesmith/tools/prop-recipes/buildings/patrol_hut_atlas.py   # paint the atlas (system Python)
    python Slopesmith/tools/prop-recipes/check.py patrol_hut             # validate, no Blender needed

## Budget

Measured off the shipped levels, buildings are the CHEAPEST thing in them — they are background mass
and the texture does all of the work:

    Mdl_PhotoBooth_3001           (MERQUER)     86 tris    2.6 x 1.5 x 2.6 m kiosk
    Mdl_Building_DockWarehouseA_3 (MERQUER)    162 tris    a whole warehouse
    Mdl_Building_ACafe_1003       (MERQUER)    208 tris    a whole cafe
    Mdl_ShrineBase_Wood_3000      (SNOW)       376 tris    the nearest shipped TIMBER structure
    GARI's 648-model average                  ~350 tris

This is a placeable prop rather than scenery, so it gets looked at from two metres away and can afford
the shrine's end of that range. It lands at 323, and the split is the point: walls and roof together
are 22 triangles, and all the rest is detail that survives close inspection — deck, posts, corner
trim, fascia, flue, firewood.

## Frame

X = along the ridge, +X = the door end, Z = up, base at z=0. Roughly 5.2 x 3.9 m over the eaves on a
3.2 x 2.8 m heated box, 3.75 m to the ridge and 4.5 to the top of the flue. A real slopeside shack at
real-world scale, the way the snowmobile is a real sled.

## The shape decisions, in the order they matter

**The roof is a single tapered box.** `taper=(1.0, RIDGE_W / (2 * ROOF_Y))` collapses the top face to a
ridge cap, which turns one primitive into both slopes, both gable ends and the ridge — twelve triangles
for the entire roof. The cross hangs on those gable ends as its own board, for the UV reason set out
where it is built.

**The overhang is asymmetric.** The roof runs 0.7 m past the back wall and 1.3 m past the front, so the
front overhang becomes a porch hood over the deck without a separate roof. Two posts carry it. A
symmetric roof plus a bolted-on porch costs more triangles and reads as two buildings.

**A knife-edge roof looks like cardboard.** The tapered box meets the eave at zero thickness, so a
fascia board hangs 0.20 m below each eave. It is 24 triangles and it is most of what makes the
silhouette read as a building rather than a folded net.

**The hut sits IN the snow.** A wobbled 9-sided drift banks against the walls, deep along them and
thinning at the corners the way wind actually leaves it. Without it the walls meet the terrain on a
hard line and the whole prop reads as a sticker.

## Orientation

Everything here is a closed solid, so the raw-space volume guard is the authority and there is no sheet
to aim the wrong way. Every skipped face sits at z=0 — the wall box's floor, the corner posts' feet,
the deck's underside — and a face in the ground plane maps into the plane through the raw origin, so
it contributes nothing to the volume sum either way. Skipping a face anywhere ELSE would quietly
corrupt that sum, which is why nothing else is skipped even where it is buried.
"""

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
from _lib import Build, box, cylinder, finish, panels, tube, wobble   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender,
                                        # so build/ stays scratch and this is the deliverable
TEX = os.path.join(BUILD, 'patrol_hut.png')
GLB = os.path.join(PROPS, 'PatrolHut.glb')
NAME = 'PatrolHut'
SEED = 70325

GRID = panels(4, 4)
P_WALL, P_WALL_DOOR, P_SIGN, P_GABLE = GRID[0]
P_ROOF, P_GEAR, P_SOFFIT, P_WALL_BACK = GRID[1]
P_DECK, P_TIMBER, P_SNOW, P_DOOR = GRID[2]
P_WINDOW, P_METAL, P_BARK, P_LOGEND = GRID[3]

WALL_X, WALL_Y = 3.20, 2.80        # the heated box
EAVE, RIDGE_Z = 2.25, 3.75         # wall top / ridge. 1.5 m of rise over 1.8 of run is a 40 deg pitch
ROOF_X0, ROOF_X1 = -2.30, 2.90     # 0.7 m over the back wall, 1.3 over the front: the porch hood
ROOF_Y = 1.90                      # half-span out to the eaves
RIDGE_W = 0.22                     # the ridge cap the taper leaves behind, in metres
DECK_TOP = 0.30

rnd = random.Random(SEED)
b = Build()

with b.part('drift'):
    # Deep along the walls and thin at the corners: the plateau laps 28 cm up the middle of every wall
    # at r=1.82, while the corners at r=2.13 break through and the bank slopes away from them. That is
    # where wind actually leaves it, and it is also what stops this reading as a plate — a drift that
    # only reaches the ground plane is a puddle, and it has to climb the walls to be a drift.
    cylinder(b, 9, 0.0, 0.28, 2.14, 1.82, P_SNOW, panel_cap=P_SNOW,
             factors=wobble(9, SEED, 0.15), cap_top=True)

with b.part('walls'):
    box(b, (0.0, 0.0, EAVE / 2), (WALL_X, WALL_Y, EAVE),
        [P_WALL, P_WALL, P_WALL, P_WALL, P_WALL_DOOR, P_WALL_BACK], skip=(0,))

with b.part('corner posts'):
    # Proud of the walls on both faces, so they read as corner trim from any angle rather than
    # disappearing into the siding at three-quarters.
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(b, (sx * (WALL_X / 2 + 0.02), sy * (WALL_Y / 2 + 0.04), EAVE / 2),
                (0.18, 0.18, EAVE), P_TIMBER, skip=(0,))

with b.part('roof'):
    box(b, ((ROOF_X0 + ROOF_X1) / 2, 0.0, (EAVE + RIDGE_Z) / 2),
        (ROOF_X1 - ROOF_X0, 2 * ROOF_Y, RIDGE_Z - EAVE),
        [P_SOFFIT, P_SNOW, P_ROOF, P_ROOF, P_GABLE, P_GABLE],
        taper=(1.0, RIDGE_W / (2 * ROOF_Y)))

with b.part('cross sign'):
    # The cross is a BOARD rather than paint on the gable, and that is a UV decision, not a styling
    # one. The gable is the tapered box's end face — a trapezoid 3.8 m wide at the eave and 0.22 at
    # the ridge — and its panel is stretched onto that. Pre-distorting for the taper is possible
    # (draw the bar flaring outward as it rises and it comes out square), but the face is a QUAD and
    # the exporter triangulates it, so U interpolates affinely on each half and kinks along the
    # diagonal. Horizontal siding survives that because V still maps to height on both triangles;
    # anything with a vertical edge does not. A flat board carries its own undistorted panel.
    for x, face in ((ROOF_X1 + 0.025, 4), (ROOF_X0 - 0.025, 5)):
        skin = [P_TIMBER] * 6
        skin[face] = P_SIGN
        box(b, (x, 0.0, 2.88), (0.05, 0.88, 0.88), skin)

with b.part('fascia'):
    for sy in (-1, 1):
        box(b, ((ROOF_X0 + ROOF_X1) / 2, sy * ROOF_Y, EAVE - 0.10),
            (ROOF_X1 - ROOF_X0, 0.12, 0.20), P_SOFFIT)

with b.part('deck'):
    # Solid to the ground rather than a slab on posts: a thin deck floating at knee height needs
    # joists and skirting under it to look supported, and packing it out costs nothing — its floor
    # lands at z=0 and gets skipped like every other face down there.
    box(b, (2.25, 0.0, DECK_TOP / 2), (1.35, 2.20, DECK_TOP),
        [P_TIMBER, P_DECK, P_TIMBER, P_TIMBER, P_TIMBER, P_TIMBER], skip=(0,))

with b.part('porch posts'):
    for sy in (-1, 1):
        box(b, (2.72, sy * 0.94, (DECK_TOP + EAVE) / 2), (0.14, 0.14, EAVE - DECK_TOP), P_TIMBER)

with b.part('door'):
    # Proud of the wall by 6 cm, standing on the deck. The cased opening around it is painted into
    # the wall panel, sized off these same numbers.
    box(b, (WALL_X / 2 + 0.03, 0.0, DECK_TOP + 0.85), (0.06, 0.84, 1.70),
        [P_TIMBER, P_TIMBER, P_TIMBER, P_TIMBER, P_DOOR, P_TIMBER])

with b.part('windows'):
    # One per long wall, offset opposite ways so the two sides are not a mirrored pair.
    for sy, face in ((1, 3), (-1, 2)):
        skin = [P_TIMBER] * 6
        skin[face] = P_WINDOW
        box(b, (sy * -0.45, sy * (WALL_Y / 2 + 0.03), 1.44), (0.95, 0.10, 0.78), skin)

with b.part('chimney'):
    # Rising from inside the roof solid, out through the slope short of the ridge. Square rather than
    # a round pipe because a box is 12 triangles against a 6-sided tube's 24 and reads the same at
    # four metres up. Snow sits on the cap.
    box(b, (-0.60, -0.55, 3.45), (0.26, 0.26, 1.80), P_METAL)
    box(b, (-0.60, -0.55, 4.42), (0.40, 0.40, 0.14),
        [P_METAL, P_SNOW, P_METAL, P_METAL, P_METAL, P_METAL])

with b.part('skis'):
    # Planted in the snow beside the deck, crossed. Two four-sided tubes: at 10 cm across, a ski IS
    # about this angular, and the lean is what makes the pair read from a distance.
    tube(b, [(2.30, -1.44, 0.02), (2.58, -1.70, 1.80)], 4, 0.065, P_GEAR, closed_ends=True)
    tube(b, [(2.58, -1.44, 0.02), (2.30, -1.70, 1.80)], 4, 0.065, P_GEAR, closed_ends=True)

with b.part('woodpile'):
    # Split billets under the back overhang, stacked 2-2-1. Jittered off the seeded stream: five
    # identical boxes on an exact grid read as manufactured well before anyone counts them.
    for lx, lz in ((-1.77, 0.38), (-2.01, 0.38), (-1.77, 0.60), (-2.01, 0.60), (-1.89, 0.82)):
        box(b, (lx + rnd.uniform(-0.02, 0.02), rnd.uniform(-0.07, 0.07), lz),
            (0.22, 1.44 * rnd.uniform(0.90, 1.0), 0.20),
            [P_BARK, P_BARK, P_LOGEND, P_LOGEND, P_BARK, P_BARK])

finish(b, NAME, TEX, GLB)
