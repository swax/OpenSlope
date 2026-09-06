"""
The Black Sun — a three-level black-pyramid nightclub you ride into up a fanned ramp.

    python Slopesmith/tools/prop-recipes/buildings/black_sun_atlas.py         # the four pages
    python Slopesmith/tools/prop-recipes/buildings/black_sun_neon_atlas.py
    python Slopesmith/tools/prop-recipes/buildings/black_sun_video_atlas.py
    python Slopesmith/tools/prop-recipes/buildings/black_sun_glass_atlas.py
    python Slopesmith/tools/prop-recipes/check.py black_sun                   # validate, no Blender

## Frame

+X is the FRONT — the ramp and the main portal. Z is up, base at z=0. A 60 x 60 m square base
rising 38 m, with the ramp reaching 24 m further out in +X.

## The section, which is the whole design

    z = 38.0   apex
    z = 33.0   OCULUS — the black sun disc hangs in it at 32.15, ringed with light
    z = 24.6   the DJ tower's ribbed vault flares out over the atrium
    z = 17.0   LEVEL 3 — mezzanine ring of private booths, middle open, glass railing
    z =  7.2   LEVEL 2 — dance floor, DJ tower, bar at the back. THE ENTRANCE IS HERE
    z =  0.0   terrain. Level 1 is SOLID podium — there is no ground-floor room

Level 2's ceiling is the mezzanine soffit at 17.0 (9.8 m clear) everywhere except the middle, which
is open all the way to the oculus at 33.0 — **25.8 m of atrium** over the dance floor. That is the
whole point of putting a club in a pyramid, and it is why the interior walls are RAKED rather than
stepped: a vertical wall can only ever be as wide as the pyramid is at the ceiling above it, so
boxing level 2 in would have cost 20 m of floor. Raked walls keep the 45 m room and hand the rake
back as booth alcoves upstairs.

## The ramp, and why it is a solid wedge

The entrance sits a storey up, so the approach is a ramp rather than a door: 24 m of run for 7.2 m
of rise (16.7 deg — a green-run pitch you can carry speed up), fanning from 16 m wide at the
threshold to 32 m at the snow. It is modelled CLOSED — deck, two flanks, an underside and a back
buried in the podium — so a rider cannot get under it, and so its own mass, rather than a stilted
platform, is what meets uneven terrain.

The fan is a curve, not a cone: half-width goes as `t**1.7`, which flares late and reads as a skirt
laid on the slope instead of a wedge of cheese.

## Materials — four pages, and each one earns its slot

| slot | page | why it cannot share |
|---|---|---|
| 0 | `black_sun.png` 512 | the architecture: static, opaque, 8x8 panels |
| 1 | `black_sun_neon.png` 256 | **scrolls in U** — every light strip, cove, handrail and dance tile |
| 2 | `black_sun_video.png` 256 | **scrolls in V** — all 22 screens, running upward |
| 3 | `black_sun_glass.png` 256 | **alpha cutout** — the mezzanine and booth glass |

Effects attach per MATERIAL, so a surface that moves cannot share a slot with one that does not
(docs/032). Two of these move in different directions, which is a third slot again.

**The neon page is eight horizontal colour rows, and a strip's U is its LENGTH in metres over
`NEON_PERIOD`.** That is what makes scrolling legal here: the art has to tile along the scroll axis
and be uniform along it, so the page is uniform in U by construction and all the variety lives in V,
which never moves. A 45 m cove strip simply runs U from 0 to 7.5 and `RepeatWrapping` does the rest.

**The screens scroll instead of flipbooking**, which is a deliberate swap. A flipbook is a STATE
list and needs an SSF effect authored against the placement to advance it (docs/032) — so a
flipbooked screen ships showing frame 0 forever until someone remembers. A declared scroll is
materialised by `attachModelEffectsToProp` the moment the prop is placed, so the video walls are
running as soon as the club lands. Both need the top bar's **Effects** toggle on.

## Lighting: dark architecture, bright paint

A placement is self-lit or it is not — `fullBright` is per PLACEMENT, not per material — so a club
cannot be a lit sign and a shaded building at once. This one is built to be placed SHADED, and the
split is done in the paint instead: the architecture page runs 12-40 out of 255 while the neon and
video pages run at full saturation. Under the editor's own prop lighting a 3x tint on near-black is
still near-black while the same tint saturates a cyan strip, so dropping free point lights inside
(docs/013) lights the club without washing the building out. Turning `fullBright` on is still there
if you want texture-true neon and a flat black shell.

## The four spins are the moving lights

`MAX_IMPORT_SPINS = 4`, and they go where motion reads hardest: four sweep heads on the truss ring
over the dance floor, each turning about its own vertical at 0.11 rev/s with a visible tapered beam
on the neon page. A beam is a single arm rather than a symmetric disc, so it does not strobe the way
a fan does, and the sweep is aimed to clear the mezzanine slab and land on the dance floor.
"""

import math
import os
import random
import sys

# Derived, not hardcoded, so the folders can move. `exec(open(p).read(), {'__file__': p})` is
# what makes this work — a bare exec() defines no __file__.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # _lib, _atlas, build/ and props/ live one level up
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
import importlib          # noqa: E402
import _lib               # noqa: E402
importlib.reload(_lib)    # Blender stays open between runs and would otherwise hold a stale library
from _lib import Build, box, finish, panels, quad, surface   # noqa: E402

BUILD = os.path.join(ROOT, 'build')
PROPS = os.path.join(ROOT, 'props')     # the GLBs are CHECKED IN: rebuilding one needs Blender
TEX = os.path.join(BUILD, 'black_sun.png')
NEON_TEX = os.path.join(BUILD, 'black_sun_neon.png')
VIDEO_TEX = os.path.join(BUILD, 'black_sun_video.png')
GLASS_TEX = os.path.join(BUILD, 'black_sun_glass.png')
GLB = os.path.join(PROPS, 'BlackSun.glb')
NAME = 'BlackSun'
SEED = 20260818

# ---- the shell ---------------------------------------------------------------------------------

HALF = 30.0          # exterior base half-width: a 60 m square footprint
APEX = 38.0          # exterior apex height. 30:38 is a 51.7 deg face — Giza's angle
IN_HALF = 28.4       # the interior cone's virtual base half-width
IN_APEX = 36.0       # ...and its apex, which lands the wall at a near-constant 1.6 m thick
L2 = 7.2             # main floor: the podium's top face
L3 = 17.0            # mezzanine floor
MEZZ_BOT = 16.7      # its soffit — 0.3 m of slab
OCULUS = 33.0        # where the atrium stops and the solid apex block begins
ATRIUM = 7.6         # the hole in the mezzanine, half-width

PORTAL_HY = 7.0      # the entrance opening: 14 m wide...
PORTAL_TOP = 13.6    # ...and 6.4 m tall, sitting on a band boundary so the cut is two quads

# Exterior bands. The seams are where the horizontal light courses go, so they are not arbitrary:
# 13.6 is the portal head and 33.0 is the oculus, and both have to be band boundaries or the face
# they cut needs splitting.
EXT_Z = [0.0, L2, PORTAL_TOP, 20.4, 27.0, OCULUS, 37.4]
IN_Z = [L2, PORTAL_TOP, 20.4, 27.0, OCULUS]

QUARTER = [(1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)]     # +X, +Y, -X, -Y


def out_half(z):
    """The exterior face's distance from the axis at height z."""
    return HALF * (1.0 - z / APEX)


def in_half(z):
    """The interior face's distance from the axis at height z."""
    return IN_HALF * (1.0 - z / IN_APEX)


def wall_xy(k, d, a):
    """Quarter k's own frame — `d` out from the axis, `a` along the wall — into world (x, y).

    This is a rotation by k * 90 deg, which is orientation-PRESERVING, so a winding worked out for
    quarter 0 stays correct in all four. That is the only reason the whole building can be written
    once and stamped four times.
    """
    c, s = QUARTER[k]
    return (d * c - a * s, d * s + a * c)


def _unit(v):
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / n for c in v)


def ext_normal(k):
    """Outward normal of exterior face k. The plane is d*APEX + z*HALF = HALF*APEX."""
    c, s = QUARTER[k]
    return _unit((APEX * c, APEX * s, HALF))


def in_normal(k):
    """Inward normal of interior face k — pointing into the room, which is also DOWNWARD, because
    the raked wall overhangs whoever is standing under it."""
    c, s = QUARTER[k]
    return _unit((-IN_APEX * c, -IN_APEX * s, -IN_HALF))


def ext_point(k, z, a, off=0.0):
    """A point on exterior face k, `off` metres proud of it."""
    x, y = wall_xy(k, out_half(z), a)
    n = ext_normal(k)
    return (x + n[0] * off, y + n[1] * off, z + n[2] * off)


def in_point(k, z, a, off=0.0):
    """A point on interior face k, `off` metres into the room."""
    x, y = wall_xy(k, in_half(z), a)
    n = in_normal(k)
    return (x + n[0] * off, y + n[1] * off, z + n[2] * off)


# ---- the pages --------------------------------------------------------------------------------
#
# Architecture: 512 px, an 8x8 grid of 64 px panels. A building this size wears far more distinct
# surfaces than the 4x4 a hut needs, and 512 is the importer's per-edge cap.

GRID = panels(8, 8)
P_EXT_BASE, P_EXT_FACE, P_EXT_HIGH, P_EXT_RIB, P_JAMB, P_EXT_VENT, P_SUN_DISC, P_SUN_RAY = GRID[0]
P_RAMP_DECK, P_RAMP_FLANK, P_RAMP_UNDER, P_APRON, P_THRESH, P_SKIRT, P_RISER, P_TREAD = GRID[1]
P_WALL_LO, P_WALL_MID, P_WALL_UP, P_WALL_TOP, P_SOFFIT, P_BEAM, P_FASCIA, P_COVE = GRID[2]
P_FLOOR, P_FLOOR_EDGE, P_MEZZ_FLOOR, P_PODIUM, P_PODIUM_RIM, P_GRATE, P_LEDGE, P_INLAY = GRID[3]
P_BAR_FRONT, P_BAR_TOP, P_BACKBAR, P_SHELF, P_BAR_HOOD, P_STOOL, P_SPK_FACE, P_SPK_SIDE = GRID[4]
P_BOOTH_BACK, P_BOOTH_SEAT, P_BOOTH_END, P_TABLE_TOP, P_TABLE_STEM, P_POST, P_RAIL, P_NICHE = GRID[5]
P_TOWER, P_BEZEL, P_TRUSS, P_VAULT_UNDER, P_VAULT_TOP, P_SPIRE, P_DESK, P_DESK_TOP = GRID[6]
P_TRUSS_NODE, P_FIXTURE, P_LENS, P_DUCT, P_OCULUS, P_DARK, P_MAT, P_STEP_SIDE = GRID[7]

# Neon: 256 px, eight full-width colour rows. A strip's U is its own LENGTH divided by this, so one
# page-width of pattern spans NEON_PERIOD metres of strip whatever the strip is — which is what
# keeps a 45 m cove and a 2 m booth bar looking like the same light fitting.
NEON_ROWS = 8
NEON_PERIOD = 6.0
N_CYAN, N_MAGENTA, N_VIOLET, N_ICE, N_AMBER, N_GREEN, N_CRIMSON, N_CHASE = range(8)

# Video: 256 px, four full-height columns. V is the scroll axis, so the art is uniform down a column
# and the variety is across U — the mirror image of the neon page's layout, for the same reason.
VIDEO_COLS = 4

GLASS = panels(4, 4)
G_PANEL, G_ETCH, G_BOOTH, G_STAIR = GLASS[0]
G_MESH, G_EDGE, G_FRIT, G_DARK = GLASS[1]


def neon(row, length):
    """A synthetic panel rect for a light strip of `length` metres on colour row `row`.

    `rect_uv` insets by 2/128 of the page, so a row's outer 12% is never sampled — the atlas keeps
    its bright core in the middle of each 32 px band for exactly that reason.
    """
    return (0.0, 1.0 - (row + 1) / NEON_ROWS, max(length, 0.05) / NEON_PERIOD, 1.0 - row / NEON_ROWS)


def video(col, reps=1.0):
    """A synthetic panel rect for a screen: one column of the page, repeated `reps` times up V."""
    return (col / VIDEO_COLS, 0.0, (col + 1) / VIDEO_COLS, reps)


# ---- geometry the shared library has no primitive for -------------------------------------------

def face4(p0, p1, p2, p3, panel, out):
    """One free quad. `quad()` from _lib, but taking points positionally so the winding argument
    order reads the same everywhere below."""
    quad(b, p0, p1, p2, p3, panel, out)


def tri(p0, p1, p2, uvs, out):
    """One free triangle — the ramp's flanks taper to nothing, and a zero-area quad there would be
    a degenerate face rather than a cheap one."""
    base = len(b.verts)
    for v in (p0, p1, p2):
        b.vert(*v)
    b.face((base, base + 1, base + 2), uvs, out)


def tri_uv(panel):
    return (_lib.uv(panel, 0.0, 0.0), _lib.uv(panel, 1.0, 0.0), _lib.uv(panel, 0.5, 1.0))


def piece(k, z0, z1, a_lo, a_hi, panel, out, inward=False):
    """Part of a frustum band on side k, spanning `a_lo(h)` to `a_hi(h)` — both callables of the
    band's half-width, so a piece can either follow the arris or stop at a fixed offset.

    One helper for the whole shell because the portal is the only cut in it, and writing that cut as
    its own winding is how a wall ends up with two faces looking the wrong way.
    """
    h0, h1 = (out_half(z0), out_half(z1)) if not inward else (in_half(z0), in_half(z1))
    lo0, hi0, lo1, hi1 = a_lo(h0), a_hi(h0), a_lo(h1), a_hi(h1)
    pts = ([(h0, hi0, z0), (h0, lo0, z0), (h1, lo1, z1), (h1, hi1, z1)] if inward
           else [(h0, lo0, z0), (h0, hi0, z0), (h1, hi1, z1), (h1, lo1, z1)])
    face4(*[wall_xy(k, d, a) + (z,) for d, a, z in pts], panel, out)


def band(k, z0, h0, z1, h1, panel, out, inward=False):
    """One MITRED trapezoid of a square frustum's side k, from (z0, h0) up to (z1, h1).

    The corners run to the frustum's own arrises — (h, +/-h) rather than (h, +/-something) — so the
    four sides of a band meet on the diagonal with no gap and no overlap, which is what lets the
    pyramid be four quads per band instead of a lathe.
    """
    if inward:
        pts = [(h0, +h0, z0), (h0, -h0, z0), (h1, -h1, z1), (h1, +h1, z1)]
    else:
        pts = [(h0, -h0, z0), (h0, +h0, z0), (h1, +h1, z1), (h1, -h1, z1)]
    face4(*[wall_xy(k, d, a) + (z,) for d, a, z in pts], panel, out)


def annulus(k, z, h_in, h_out, panel, up=True):
    """One mitred trapezoid of a horizontal square annulus — a floor ring, a wall's top or bottom
    face. Same corner order as `band`, which is why up is up."""
    pts = [(h_out, -h_out), (h_out, +h_out), (h_in, +h_in), (h_in, -h_in)]
    if not up:
        pts.reverse()
    face4(*[wall_xy(k, d, a) + (z,) for d, a in pts], panel, (0.0, 0.0, 1.0 if up else -1.0))


def ring_at(n, cx, cy, r, z, phase=0.0):
    return [(cx + r * math.cos(phase + 2 * math.pi * i / n),
             cy + r * math.sin(phase + 2 * math.pi * i / n), z) for i in range(n)]


def drum(cx, cy, z0, z1, r0, r1, n, panel, cap_top=None, cap_bot=None, phase=0.0):
    """A tapered tube anywhere in the plan — `_lib.cylinder` only ever stands on the axis, and this
    building has stools, table stems and a podium that do not."""
    base = len(b.verts)
    lo, hi = ring_at(n, cx, cy, r0, z0, phase), ring_at(n, cx, cy, r1, z1, phase)
    for v in lo + hi:
        b.vert(*v)
    for i in range(n):
        j = (i + 1) % n
        a = phase + 2 * math.pi * (i + 0.5) / n
        b.face((base + i, base + j, base + n + j, base + n + i),
               _lib.band_uv(panel), (math.cos(a), math.sin(a), 0.0))
    if cap_top is not None:
        disc(cx, cy, z1, r1, n, cap_top, up=True, phase=phase)
    if cap_bot is not None:
        disc(cx, cy, z0, r0, n, cap_bot, up=False, phase=phase)


def disc(cx, cy, z, r, n, panel, up=True, phase=0.0):
    """A horizontal fan. Radial UVs, so anything concentric in the panel lands as concentric rings —
    which is wrong for a table top and exactly right for the black sun."""
    base = len(b.verts)
    pts = ring_at(n, cx, cy, r, z, phase)
    for v in pts:
        b.vert(*v)
    c = b.vert(cx, cy, z)
    for i in range(n):
        j = (i + 1) % n
        ring = (base + i, base + j) if up else (base + j, base + i)
        uvs = [_lib.radial_uv(panel, pts[m][0] - cx, pts[m][1] - cy, r)
               for m in ((i, j) if up else (j, i))]
        b.face(ring + (c,), tuple(uvs) + (_lib.uv(panel, 0.5, 0.5),),
               (0.0, 0.0, 1.0 if up else -1.0))


def neon_bar(p0, p1, r, row, cap=True):
    """A square light bar between two points, with U following its length on `row`."""
    beam(p0, p1, r, r, neon(row, math.dist(p0, p1)), cap=cap, along=True)


def beam(p0, p1, r0, r1, panel, cap=True, along=False):
    """A tapered square shaft from p0 to p1 — a light beam, a rib, a hanger.

    Its own frame is built from the axis, and (u, v, axis) is kept RIGHT-handed so the ring runs the
    same way round as `_lib.cylinder`'s does. Get that backwards and every side of every beam ships
    ambient-only dark while still drawing perfectly.
    """
    axis = _unit(tuple(p1[i] - p0[i] for i in range(3)))
    ref = (0.0, 0.0, 1.0) if abs(axis[2]) < 0.9 else (1.0, 0.0, 0.0)
    u = _unit((axis[1] * ref[2] - axis[2] * ref[1],
               axis[2] * ref[0] - axis[0] * ref[2],
               axis[0] * ref[1] - axis[1] * ref[0]))
    v = (axis[1] * u[2] - axis[2] * u[1],
         axis[2] * u[0] - axis[0] * u[2],
         axis[0] * u[1] - axis[1] * u[0])
    base = len(b.verts)
    for p, r in ((p0, r0), (p1, r1)):
        for i in range(4):
            t = math.pi * 0.5 * i + math.pi * 0.25
            b.vert(*[p[m] + r * (math.cos(t) * u[m] + math.sin(t) * v[m]) for m in range(3)])
    for i in range(4):
        j = (i + 1) % 4
        t = math.pi * 0.5 * (i + 0.5) + math.pi * 0.25
        out = tuple(math.cos(t) * u[m] + math.sin(t) * v[m] for m in range(3))
        # `band_uv` runs V along the sweep, which is right for a striped pipe and wrong for a neon
        # bar: the light rows are horizontal, so U has to be the one that follows the length.
        uvs = ((_lib.uv(panel, 0.0, 0.0), _lib.uv(panel, 0.0, 1.0),
                _lib.uv(panel, 1.0, 1.0), _lib.uv(panel, 1.0, 0.0)) if along
               else _lib.band_uv(panel))
        b.face((base + i, base + j, base + 4 + j, base + 4 + i), uvs, out)
    if cap:
        b.face(tuple(base + 4 + i for i in range(4)), _lib.rect_uv(panel), axis)


# box() face order is 0=-Z 1=+Z 2=-Y 3=+Y 4=+X 5=-X. Which of those is "the face toward the room"
# depends on the quarter, so the mapping is tabulated once: (far, near, along+, along-).
FACES = {0: (4, 5, 3, 2), 1: (3, 2, 5, 4), 2: (5, 4, 2, 3), 3: (2, 3, 4, 5)}


def wall_box(k, d, a, z0, z1, depth, along, near=None, far=None, side=None,
             top=None, bot=None, skip=()):
    """An axis-aligned box placed in quarter k's frame, with its panels named by ROLE.

    A box is axis-aligned whatever the quarter, so stamping the same furniture round four walls only
    needs the size components swapped and the panel list permuted — which is exactly what this does,
    and why a booth is written once instead of four times.
    """
    x, y = wall_xy(k, d, a)
    size = (depth, along, z1 - z0) if k % 2 == 0 else (along, depth, z1 - z0)
    skin = [bot or P_DARK, top or P_DARK] + [P_DARK] * 4
    far_i, near_i, plus_i, minus_i = FACES[k]
    skin[far_i], skin[near_i] = far or P_DARK, near or P_DARK
    skin[plus_i] = skin[minus_i] = side or P_DARK
    box(b, (x, y, (z0 + z1) / 2), size, skin, skip=skip)


def wall_quad(k, d, a0, a1, z0, z1, panel, inward=True):
    """A flat panel standing at a fixed distance `d` from the axis — a railing infill, a booth
    divider. `inward` faces it at the middle of the building."""
    pts = [(a1, z0), (a0, z0), (a0, z1), (a1, z1)]
    if not inward:
        pts.reverse()
    face4(*[wall_xy(k, d, a) + (z,) for a, z in pts], panel,
          tuple((-1.0 if inward else 1.0) * c for c in QUARTER[k]) + (0.0,))


def skin_quad(k, z0, z1, a_lo, a_hi, panel, off, outside=False, u_up=False):
    """A panel lying ON the pyramid's raked skin, `off` metres proud of it — a wall screen, a light
    course, an arris strip.

    `u_up` runs the texture's U up the slope instead of across it, which is what a light strip
    climbing an arris needs and what a screen must NOT have. Rotating the corner cycle rather than
    reversing it is what keeps the winding while moving where U starts.
    """
    at = ext_point if outside else in_point
    h0, h1 = (out_half(z0), out_half(z1)) if outside else (in_half(z0), in_half(z1))
    lo0, hi0, lo1, hi1 = a_lo(h0), a_hi(h0), a_lo(h1), a_hi(h1)
    cyc = ([(z0, lo0), (z0, hi0), (z1, hi1), (z1, lo1)] if outside
           else [(z0, hi0), (z0, lo0), (z1, lo1), (z1, hi1)])
    if u_up:
        cyc = cyc[1:] + cyc[:1]
    face4(*[at(k, z, a, off) for z, a in cyc], panel,
          ext_normal(k) if outside else in_normal(k))


def lathe(profile, n, panels_by_edge, cx=0.0, cy=0.0):
    """Sweep a CLOSED 2D outline in the (r, z) half-plane around the axis.

    `_lib` has no rotational sweep — `extrude_profile` goes along X — and the DJ tower's vault is a
    flared collar whose section is the whole design. The outline is wound CCW in (r, z), so each
    edge's outward normal is `(dz, -dr)` lifted to 3D; get that convention wrong and the vault reads
    as a hole rather than a canopy, while still drawing perfectly.
    """
    rings = []
    for r, z in profile:
        base = len(b.verts)
        for p in ring_at(n, cx, cy, r, z):
            b.vert(*p)
        rings.append(base)
    m = len(profile)
    for e in range(m):
        f = (e + 1) % m
        (r0, z0), (r1, z1) = profile[e], profile[f]
        dr, dz = r1 - r0, z1 - z0
        for i in range(n):
            j = (i + 1) % n
            t = 2 * math.pi * (i + 0.5) / n
            b.face((rings[e] + i, rings[e] + j, rings[f] + j, rings[f] + i),
                   _lib.band_uv(panels_by_edge[e]),
                   (dz * math.cos(t), dz * math.sin(t), -dr))


def mirror_y(start_face):
    """`_lib.mirror_x` across y=0 instead. The two stair flights are mirror images, and a mirror is
    orientation-REVERSING, so the copy's corner order goes with it or the whole second flight ships
    dark."""
    remap = {}
    for fi in range(start_face, len(b.faces)):
        corners, uvs, out = b.faces[fi], b.uvs[fi], b.out[fi]
        was_mat, was_spin = b.mats[fi], b.face_spin[fi]
        new = []
        for vi in corners:
            if vi not in remap:
                x, y, z = b.verts[vi]
                remap[vi] = b.vert(x, -y, z)
            new.append(remap[vi])
        prev_mat, prev_spin = b._mat, b._spin
        b._mat, b._spin = was_mat, was_spin
        b.face(tuple(reversed(new)), tuple(reversed(uvs)), (out[0], -out[1], out[2]))
        b._mat, b._spin = prev_mat, prev_spin


rnd = random.Random(SEED)
b = Build()

# ---- the shell ----------------------------------------------------------------------------------

EXT_PANEL = [P_EXT_BASE, P_EXT_FACE, P_EXT_FACE, P_EXT_HIGH, P_EXT_HIGH, P_EXT_HIGH]
IN_PANEL = [P_WALL_LO, P_WALL_MID, P_WALL_UP, P_WALL_TOP]

with b.part('exterior'):
    # The base at z=0 contributes nothing to the raw volume — it maps into the plane through the raw
    # origin — but it costs two triangles and it is what makes the shell provably closed, which is
    # the claim the volume guard is actually testing.
    face4((-HALF, -HALF, 0.0), (-HALF, HALF, 0.0), (HALF, HALF, 0.0), (HALF, -HALF, 0.0),
          P_DARK, (0.0, 0.0, -1.0))
    for k in range(4):
        for i in range(len(EXT_Z) - 1):
            z0, z1 = EXT_Z[i], EXT_Z[i + 1]
            h0, h1 = out_half(z0), out_half(z1)
            if k == 0 and z0 == L2 and z1 == PORTAL_TOP:
                # The portal is cut out of exactly one band of one face, which is why its head was
                # put on a band boundary: the cut is two quads instead of a re-tessellation.
                piece(0, z0, z1, lambda h: -h, lambda h: -PORTAL_HY, EXT_PANEL[i], ext_normal(0))
                piece(0, z0, z1, lambda h: PORTAL_HY, lambda h: h, EXT_PANEL[i], ext_normal(0))
                continue
            band(k, z0, h0, z1, h1, EXT_PANEL[i], ext_normal(k))
    # The apex is truncated at 37.4 rather than run to a point: four degenerate triangles up there
    # would be four faces the guards cannot judge, and the flat top is where the beacon sits.
    h = out_half(37.4)
    face4((-h, -h, 37.4), (h, -h, 37.4), (h, h, 37.4), (-h, h, 37.4), P_OCULUS, (0.0, 0.0, 1.0))

with b.part('interior'):
    # The room's own surfaces, wound to face INTO it. Their normals point inward AND downward,
    # because a raked wall overhangs whoever stands under it.
    for k in range(4):
        for i in range(len(IN_Z) - 1):
            z0, z1 = IN_Z[i], IN_Z[i + 1]
            h0, h1 = in_half(z0), in_half(z1)
            if k == 0 and z0 == L2 and z1 == PORTAL_TOP:
                piece(0, z0, z1, lambda h: -h, lambda h: -PORTAL_HY,
                      IN_PANEL[i], in_normal(0), inward=True)
                piece(0, z0, z1, lambda h: PORTAL_HY, lambda h: h,
                      IN_PANEL[i], in_normal(0), inward=True)
                continue
            band(k, z0, h0, z1, h1, IN_PANEL[i], in_normal(k), inward=True)
    # Bottom annulus at L2 and top annulus at the oculus. Both are buried — the first inside the
    # podium's top cap, the second inside the apex block — and both exist so the wall shell is a
    # CLOSED solid rather than a pair of skins whose volume sum means nothing.
    for k in range(4):
        annulus(k, L2, in_half(L2), out_half(L2), P_DARK, up=False)
        annulus(k, OCULUS, in_half(OCULUS), out_half(OCULUS), P_DARK, up=True)

with b.part('portal'):
    # The reveal: four quads tying the outer opening to the inner one through 1.6 m of wall.
    o0, i0 = out_half(L2), in_half(L2)
    o1, i1 = out_half(PORTAL_TOP), in_half(PORTAL_TOP)
    face4((i0, -PORTAL_HY, L2), (o0, -PORTAL_HY, L2), (o0, PORTAL_HY, L2), (i0, PORTAL_HY, L2),
          P_THRESH, (0.0, 0.0, 1.0))                                     # the threshold underfoot
    face4((i1, PORTAL_HY, PORTAL_TOP), (o1, PORTAL_HY, PORTAL_TOP),
          (o1, -PORTAL_HY, PORTAL_TOP), (i1, -PORTAL_HY, PORTAL_TOP),
          P_JAMB, (0.0, 0.0, -1.0))                                      # the head
    for sign in (-1, 1):
        pts = [(i0, sign * PORTAL_HY, L2), (o0, sign * PORTAL_HY, L2),
               (o1, sign * PORTAL_HY, PORTAL_TOP), (i1, sign * PORTAL_HY, PORTAL_TOP)]
        if sign < 0:
            pts.reverse()
        face4(*pts, P_JAMB, (0.0, -sign, 0.0))

with b.part('apex block'):
    # Sunk 0.6 m into the shell so its underside and the wall's top annulus are never coplanar.
    # Coincident opposite-facing faces are the one thing that z-fights in a way no amount of
    # material work fixes.
    hb = out_half(32.4)
    face4((-hb, hb, 32.4), (hb, hb, 32.4), (hb, -hb, 32.4), (-hb, -hb, 32.4),
          P_DARK, (0.0, 0.0, -1.0))

with b.part('ramp'):
    # A closed wedge, not a deck on legs: 24 m of run for 7.2 m of rise, fanning 8 m -> 16 m
    # half-width on a t**1.7 curve so the flare arrives late and reads as a skirt.
    RAMP_X0, RAMP_RUN = out_half(L2), 24.0
    RAMP_W0, RAMP_W1, RAMP_BANDS = 8.0, 16.0, 6
    RAMP_N = _unit((L2, 0.0, RAMP_RUN))          # the deck plane's own normal

    def ramp_x(t):
        return RAMP_X0 + RAMP_RUN * t

    def ramp_z(t):
        return L2 * (1.0 - t)

    def ramp_w(t):
        return RAMP_W0 + (RAMP_W1 - RAMP_W0) * t ** 1.7

    for i in range(RAMP_BANDS):
        t0, t1 = i / RAMP_BANDS, (i + 1) / RAMP_BANDS
        x0, x1, z0, z1, w0, w1 = ramp_x(t0), ramp_x(t1), ramp_z(t0), ramp_z(t1), ramp_w(t0), ramp_w(t1)
        face4((x0, w0, z0), (x0, -w0, z0), (x1, -w1, z1), (x1, w1, z1), P_RAMP_DECK, RAMP_N)
        face4((x0, -w0, 0.0), (x0, w0, 0.0), (x1, w1, 0.0), (x1, -w1, 0.0),
              P_RAMP_UNDER, (0.0, 0.0, -1.0))
        dx, dw = x1 - x0, w1 - w0
        for s in (1, -1):
            flank = _unit((-dw, s * dx, 0.0))
            pts = [(x0, s * w0, z0), (x1, s * w1, z1), (x1, s * w1, 0.0), (x0, s * w0, 0.0)]
            if z1 <= 1e-9:                       # the last band lands on the snow: a triangle, not
                pts = [pts[0], pts[2], pts[3]]   # a quad with two coincident corners
                if s < 0:
                    pts.reverse()
                tri(*pts, tri_uv(P_RAMP_FLANK), flank)
            else:
                if s < 0:
                    pts.reverse()
                face4(*pts, P_RAMP_FLANK, flank)
    face4((RAMP_X0, RAMP_W0, 0.0), (RAMP_X0, -RAMP_W0, 0.0),
          (RAMP_X0, -RAMP_W0, L2), (RAMP_X0, RAMP_W0, L2), P_DARK, (-1.0, 0.0, 0.0))

with b.part('floor'):
    # The podium's top cap IS the dance-floor level, and it has to span the full footprint or the
    # podium below it is not a closed solid. Tiled 8x8 rather than laid as one quad so a 64 px panel
    # covers 6 m instead of 48.
    FH, FN = out_half(L2), 8
    for ix in range(FN):
        for iy in range(FN):
            x0, x1 = -FH + 2 * FH * ix / FN, -FH + 2 * FH * (ix + 1) / FN
            y0, y1 = -FH + 2 * FH * iy / FN, -FH + 2 * FH * (iy + 1) / FN
            edge = ix in (0, FN - 1) or iy in (0, FN - 1)
            face4((x0, y0, L2), (x1, y0, L2), (x1, y1, L2), (x0, y1, L2),
                  P_FLOOR_EDGE if edge else P_FLOOR, (0.0, 0.0, 1.0))

with b.part('entry medallion'):
    # The club's mark inlaid in the floor just inside the door, where the dance tiles stop — so the
    # first thing you see on the way in off the ramp is the thing the place is named after. Radial
    # UVs again, and again on purpose.
    disc(18.6, 0.0, L2 + 0.04, 3.60, 20, P_INLAY, up=True)

with b.surface(1):
    with b.part('sun corona'):
        # The halo goes BEHIND the disc and has to be smaller than the hole it hangs in, which is the
        # whole trick: the oculus is only 3.03 m of half-width at this height, so a corona sized off
        # the disc rather than off the OPENING plugs the hole and is never seen from the floor at all.
        # Radially mapped onto a neon row, so the light strip's own cross-section becomes the halo's
        # rings — the one place `radial_uv`'s concentric warning is the effect being asked for.
        disc(0.0, 0.0, 32.28, 2.95, 20, neon(N_ICE, 6.0), up=False)

with b.part('black sun'):
    # ...and the disc itself in front of it, deliberately smaller than the opening so a ring of that
    # light survives all the way round. This is what the club is named after, seen from 25 m below.
    disc(0.0, 0.0, 32.15, 2.10, 20, P_SUN_DISC, up=False)

POD_R, POD_TOP = 7.5, 8.5
SHAFT_H, SHAFT_TOP = 4.0, 21.5
SCREEN_Z0, SCREEN_Z1, SCREEN_HY = 10.5, 19.5, 3.3

with b.part('dj podium'):
    # Two concentric steps rather than one slab: a stage a rider can read the height of from across
    # the room needs an edge partway up it, and the lower ring is where the monitors sit.
    drum(0.0, 0.0, L2, L2 + 0.45, 8.7, 8.7, 12, P_PODIUM_RIM, cap_top=P_PODIUM)
    drum(0.0, 0.0, L2, POD_TOP, POD_R, POD_R, 12, P_PODIUM_RIM, cap_top=P_PODIUM)

with b.part('dj desk'):
    # Facing +X, at the entrance. A straight console with two swept-back wings — three boxes read as
    # a curve at this size and cost a third of what a real lathe would.
    box(b, (2.30, 0.0, POD_TOP + 0.52), (0.95, 4.60, 1.04),
        [P_DARK, P_DESK_TOP, P_DESK, P_DESK, P_DESK, P_DESK], skip=(0,))
    for sy in (-1, 1):
        box(b, (1.55, sy * 3.05, POD_TOP + 0.48), (0.85, 1.80, 0.96),
            [P_DARK, P_DESK_TOP, P_DESK, P_DESK, P_DESK, P_DESK], skip=(0,))
        box(b, (1.10, sy * 4.35, POD_TOP + 0.62), (0.70, 0.70, 1.24), P_SPK_FACE, skip=(0,))

with b.part('dj tower'):
    # Two stacked boxes, not one: the shaft is 13 m tall and a single panel over that runs 20 cm to
    # the pixel, which is coarser than anything else on the building.
    for i in range(2):
        z0 = SHAFT_TOP - (2 - i) * (SHAFT_TOP - POD_TOP) / 2
        z1 = z0 + (SHAFT_TOP - POD_TOP) / 2
        box(b, (0.0, 0.0, (z0 + z1) / 2), (2 * SHAFT_H, 2 * SHAFT_H, z1 - z0), P_TOWER)

VAULT_R0, VAULT_R1, VAULT_R2 = 4.10, 6.00, 7.40
VAULT_Z0, VAULT_Z1, VAULT_Z2 = SHAFT_TOP, 23.20, 24.60
VAULT_RIBS = 12

with b.part('dj vault'):
    # A RIBBED vault, solid only for its inner third — and that is a sightline decision, not a
    # styling one. As a full shell flaring to 7.8 m it read beautifully and blocked the oculus from
    # every point anyone can stand: the ray from the mezzanine walkway to the black sun crosses the
    # underside at r = 6.6, and from the dance floor the tower shaft blocks it first. Ribs with air
    # between them keep the canopy over the DJ and let the disc show through, which is the whole
    # reason the atrium is 25 m tall.
    WEB = [(VAULT_R0, VAULT_Z0), (VAULT_R1, VAULT_Z1), (VAULT_R1, VAULT_Z1 + 0.55),
           (VAULT_R0, VAULT_Z0 + 0.70)]
    lathe(WEB, VAULT_RIBS * 2, [P_VAULT_UNDER, P_SPIRE, P_VAULT_TOP, P_SPIRE])
    for i in range(VAULT_RIBS):
        t = 2 * math.pi * i / VAULT_RIBS
        c, s = math.cos(t), math.sin(t)

        def at(r, z, drop=0.0):
            return (r * c, r * s, z - drop)

        beam(at(VAULT_R0, VAULT_Z0, 0.16), at(VAULT_R1, VAULT_Z1, 0.16), 0.19, 0.16,
             P_VAULT_TOP, cap=False)
        beam(at(VAULT_R1, VAULT_Z1, 0.16), at(VAULT_R2, VAULT_Z2), 0.16, 0.13, P_VAULT_TOP)
    for i in range(VAULT_RIBS):
        t0 = 2 * math.pi * i / VAULT_RIBS
        t1 = 2 * math.pi * (i + 1) / VAULT_RIBS
        beam((VAULT_R2 * math.cos(t0), VAULT_R2 * math.sin(t0), VAULT_Z2),
             (VAULT_R2 * math.cos(t1), VAULT_R2 * math.sin(t1), VAULT_Z2), 0.14, 0.14,
             P_TRUSS, cap=False)

with b.part('spire'):
    # It rises out of the vault, through the oculus, and stops inside the black sun disc — so the
    # thing the club is named after is visibly hung off the thing the DJ stands under.
    # Slim on purpose. At 3.4 m of base radius it silhouetted across the disc from the mezzanine and
    # ate the thing it is supposed to be delivering you to; 2.5 still reads as a mast from the floor.
    drum(0.0, 0.0, SHAFT_TOP, 32.15, 2.50, 1.15, 8, P_SPIRE, cap_top=P_SPIRE)

with b.surface(2):
    with b.part('tower screens'):
        for k in range(4):
            p = [(SCREEN_Z0, -SCREEN_HY), (SCREEN_Z0, SCREEN_HY),
                 (SCREEN_Z1, SCREEN_HY), (SCREEN_Z1, -SCREEN_HY)]
            face4(*[wall_xy(k, SHAFT_H + 0.14, a) + (z,) for z, a in p],
                  video(k, 2.0), QUARTER[k] + (0.0,))

with b.part('tower bezels'):
    for k in range(4):
        p = [(SCREEN_Z0 - 0.35, -SCREEN_HY - 0.35), (SCREEN_Z0 - 0.35, SCREEN_HY + 0.35),
             (SCREEN_Z1 + 0.35, SCREEN_HY + 0.35), (SCREEN_Z1 + 0.35, -SCREEN_HY - 0.35)]
        face4(*[wall_xy(k, SHAFT_H + 0.07, a) + (z,) for z, a in p],
              P_BEZEL, QUARTER[k] + (0.0,))

MEZZ_OUT = in_half(MEZZ_BOT)
MEZZ_D = [ATRIUM, 10.6, 13.4, MEZZ_OUT]      # walkway | booths | cove ledge behind them
MEZZ_SEGS = 8
# The two stair flights arrive through the ring, so the ring has a hole where each one comes up.
# Only the OUTER two depth bands are cut — the walkway stays continuous all the way round, which is
# what keeps the atrium railing an unbroken line.
STAIR_SKIP = {1: (4, 5, 6, 7), 3: (0, 1, 2, 3)}
MEZZ_TOP_PANEL = [P_MEZZ_FLOOR, P_MEZZ_FLOOR, P_LEDGE]


def mezz_a(s):
    return -ATRIUM + 2 * ATRIUM * s / MEZZ_SEGS


with b.part('mezzanine'):
    for k in range(4):
        for m in range(3):
            for s in range(MEZZ_SEGS):
                if m > 0 and s in STAIR_SKIP.get(k, ()):
                    continue
                d0, d1, a0, a1 = MEZZ_D[m], MEZZ_D[m + 1], mezz_a(s), mezz_a(s + 1)
                top = [(d0, a0), (d1, a0), (d1, a1), (d0, a1)]
                face4(*[wall_xy(k, d, a) + (L3,) for d, a in top],
                      MEZZ_TOP_PANEL[m], (0.0, 0.0, 1.0))
                face4(*[wall_xy(k, d, a) + (MEZZ_BOT,) for d, a in reversed(top)],
                      P_SOFFIT, (0.0, 0.0, -1.0))
        # ...and the corner it shares with side k+1, which is where a flight lands.
        for p in range(2):
            for q in range(2):
                d0, d1 = ATRIUM + p * (MEZZ_OUT - ATRIUM) / 2, ATRIUM + (p + 1) * (MEZZ_OUT - ATRIUM) / 2
                a0, a1 = ATRIUM + q * (MEZZ_OUT - ATRIUM) / 2, ATRIUM + (q + 1) * (MEZZ_OUT - ATRIUM) / 2
                top = [(d0, a0), (d1, a0), (d1, a1), (d0, a1)]
                face4(*[wall_xy(k, d, a) + (L3,) for d, a in top], P_MEZZ_FLOOR, (0.0, 0.0, 1.0))
                face4(*[wall_xy(k, d, a) + (MEZZ_BOT,) for d, a in reversed(top)],
                      P_SOFFIT, (0.0, 0.0, -1.0))

with b.part('mezzanine fascia'):
    # The slab's edge over the atrium, and the two cut faces of each stair opening. The outer edge
    # is buried in the raked wall and deliberately has none.
    for k in range(4):
        face4(wall_xy(k, ATRIUM, ATRIUM) + (MEZZ_BOT,), wall_xy(k, ATRIUM, -ATRIUM) + (MEZZ_BOT,),
              wall_xy(k, ATRIUM, -ATRIUM) + (L3,), wall_xy(k, ATRIUM, ATRIUM) + (L3,),
              P_FASCIA, tuple(-c for c in QUARTER[k]) + (0.0,))
        skip = STAIR_SKIP.get(k)
        if not skip:
            continue
        a_edge = mezz_a(skip[0]) if skip[0] > 0 else mezz_a(skip[-1] + 1)
        s = 1.0 if skip[0] > 0 else -1.0
        # The transverse cut across the ring. Wound d-then-up it faces -a whichever side the hole is
        # on, so the half whose hole lies at +a has to be reversed — the two flights are mirrored in
        # world space but NOT in their own quarter frames, which is the whole reason this asymmetry
        # exists.
        cut = [wall_xy(k, MEZZ_D[1], a_edge) + (MEZZ_BOT,), wall_xy(k, MEZZ_OUT, a_edge) + (MEZZ_BOT,),
               wall_xy(k, MEZZ_OUT, a_edge) + (L3,), wall_xy(k, MEZZ_D[1], a_edge) + (L3,)]
        if s > 0:
            cut.reverse()
        face4(*cut, P_FASCIA, wall_xy(k, 0.0, s) + (0.0,))
        # ...and the long one facing the walkway
        a0, a1 = (a_edge, ATRIUM) if s > 0 else (-ATRIUM, a_edge)
        face4(wall_xy(k, MEZZ_D[1], a1) + (MEZZ_BOT,), wall_xy(k, MEZZ_D[1], a0) + (MEZZ_BOT,),
              wall_xy(k, MEZZ_D[1], a0) + (L3,), wall_xy(k, MEZZ_D[1], a1) + (L3,),
              P_FASCIA, tuple(-c for c in QUARTER[k]) + (0.0,))

# ---- the stairs ----------------------------------------------------------------------------------

STAIR_STEPS = 34
STAIR_X0, STAIR_X1 = 15.0, -ATRIUM
STAIR_W, STAIR_GAP, SOFFIT_DROP = 3.0, 0.02, 0.60
STAIR_RISE = (L3 - L2) / STAIR_STEPS
STAIR_GO = (STAIR_X0 - STAIR_X1) / STAIR_STEPS


def stair_y(z, inner=False):
    """The flight hugs the raked wall, so its edges move inboard as it climbs — which is what makes
    it read as 'following the pyramid up' rather than as a staircase that happens to be near one."""
    return in_half(z) - STAIR_GAP - (STAIR_W if inner else 0.0)


flight_start = len(b.faces)
with b.part('stairs'):
    for i in range(STAIR_STEPS):
        xa, xb = STAIR_X0 - i * STAIR_GO, STAIR_X0 - (i + 1) * STAIR_GO
        za, zb = L2 + i * STAIR_RISE, L2 + (i + 1) * STAIR_RISE
        face4((xa, stair_y(za, True), za), (xa, stair_y(za), za),
              (xa, stair_y(zb), zb), (xa, stair_y(zb, True), zb), P_RISER, (1.0, 0.0, 0.0))
        face4((xa, stair_y(zb, True), zb), (xa, stair_y(zb), zb),
              (xb, stair_y(zb), zb), (xb, stair_y(zb, True), zb), P_TREAD, (0.0, 0.0, 1.0))
    # One raked slab under the lot. Its normal points down AND back up the flight, which is the
    # honest normal of a stair soffit and not the intuitive one.
    rake = _unit((-STAIR_RISE, 0.0, -STAIR_GO))
    A = (STAIR_X0, stair_y(L2), L2 - SOFFIT_DROP)
    B = (STAIR_X0, stair_y(L2, True), L2 - SOFFIT_DROP)
    C = (STAIR_X1, stair_y(L3, True), L3 - SOFFIT_DROP)
    D = (STAIR_X1, stair_y(L3), L3 - SOFFIT_DROP)
    face4(A, B, C, D, P_STEP_SIDE, rake)
    # The stringer down the open side, from the nosing line to that slab.
    E, F = (STAIR_X0, stair_y(L2, True), L2), (STAIR_X1, stair_y(L3, True), L3)
    # The open side is not vertical-planar-in-Y — the flight converges 7.7 m over its run — so its
    # normal is derived from the two endpoints rather than assumed to be -Y.
    side = _unit((-(F[1] - E[1]), F[0] - E[0], 0.0))
    if side[1] > 0:
        side = tuple(-c for c in side)
    face4(B, E, F, C, P_STEP_SIDE, side)

with b.surface(3):
    with b.part('stair glass'):
        for i in range(9):
            t0, t1 = i / 9.0, (i + 1) / 9.0
            x0, x1 = STAIR_X0 - t0 * (STAIR_X0 - STAIR_X1), STAIR_X0 - t1 * (STAIR_X0 - STAIR_X1)
            z0, z1 = L2 + t0 * (L3 - L2), L2 + t1 * (L3 - L2)
            y0, y1 = stair_y(z0, True) - 0.07, stair_y(z1, True) - 0.07
            face4((x0, y0, z0 + 0.10), (x0, y0, z0 + 1.05),
                  (x1, y1, z1 + 1.05), (x1, y1, z1 + 0.10), G_STAIR, (0.0, -1.0, 0.0))

with b.surface(1):
    with b.part('stair light'):
        p0 = (STAIR_X0, stair_y(L2, True) - 0.07, L2 + 1.12)
        p1 = (STAIR_X1, stair_y(L3, True) - 0.07, L3 + 1.12)
        neon_bar(p0, p1, 0.07, N_ICE)
        neon_bar((STAIR_X0, stair_y(L2, True) - 0.04, L2 + 0.03),
                 (STAIR_X1, stair_y(L3, True) - 0.04, L3 + 0.03), 0.05, N_CYAN)

mirror_y(flight_start)

# ---- the mezzanine's furniture --------------------------------------------------------------------

RAIL_D, RAIL_H = ATRIUM + 0.06, 1.05

with b.part('railing'):
    for k in range(4):
        for s in range(MEZZ_SEGS + 1):
            wall_box(k, RAIL_D, mezz_a(s), L3, L3 + RAIL_H, 0.12, 0.12, near=P_POST, side=P_POST,
                     far=P_POST, top=P_POST, skip=(0,))

with b.surface(3):
    with b.part('railing glass'):
        for k in range(4):
            for s in range(MEZZ_SEGS):
                # One panel in each run carries the club's mark etched into the frit, rather than
                # every panel — a repeated logo at 1.9 m centres reads as wallpaper.
                wall_quad(k, RAIL_D, mezz_a(s) + 0.10, mezz_a(s + 1) - 0.10,
                          L3 + 0.10, L3 + RAIL_H - 0.05,
                          G_ETCH if s == MEZZ_SEGS // 2 else G_PANEL)

with b.surface(1):
    with b.part('railing light'):
        for k in range(4):
            neon_bar(wall_xy(k, RAIL_D, -ATRIUM) + (L3 + RAIL_H + 0.07,),
                     wall_xy(k, RAIL_D, ATRIUM) + (L3 + RAIL_H + 0.07,), 0.075, N_ICE)

# Four booths on the +X and -X sides; two on each of +Y and -Y, whose other half is the stair
# opening. `a` is the offset along that wall.
BOOTHS = {0: (-5.7, -1.9, 1.9, 5.7), 2: (-5.7, -1.9, 1.9, 5.7), 1: (-5.7, -1.9), 3: (1.9, 5.7)}

with b.part('booths'):
    for k, spots in BOOTHS.items():
        for a in spots:
            # The raked wall is the booth's own ceiling: 2.5 m of headroom at the seat back, 5.5 at
            # the table. That alcove is what the pyramid section hands back for free, and it is why
            # the booths sit against the rake rather than out on the walkway.
            wall_box(k, 13.00, a, L3, L3 + 1.40, 0.55, 3.20,
                     near=P_BOOTH_BACK, side=P_BOOTH_END, top=P_BOOTH_SEAT, skip=(0,))
            wall_box(k, 11.95, a, L3, L3 + 0.45, 1.50, 3.20,
                     near=P_BOOTH_SEAT, side=P_BOOTH_END, top=P_BOOTH_SEAT, skip=(0,))
            tx, ty = wall_xy(k, 11.05, a)
            drum(tx, ty, L3 + 0.45, L3 + 0.94, 0.14, 0.11, 8, P_TABLE_STEM)
            drum(tx, ty, L3 + 0.94, L3 + 1.02, 0.62, 0.62, 8, P_TABLE_TOP,
                 cap_top=P_TABLE_TOP, cap_bot=P_TABLE_STEM)

with b.surface(3):
    with b.part('booth glass'):
        for k, spots in BOOTHS.items():
            for a in spots:
                for s in (-1, 1):
                    x0, y0 = wall_xy(k, 13.30, a + s * 1.75)
                    x1, y1 = wall_xy(k, 10.50, a + s * 1.75)
                    face4((x0, y0, L3), (x0, y0, L3 + 1.75), (x1, y1, L3 + 1.75), (x1, y1, L3),
                          G_BOOTH, _unit((y0 - y1, x1 - x0, 0.0)))

with b.surface(1):
    with b.part('booth light'):
        for k, spots in BOOTHS.items():
            for a in spots:
                neon_bar(wall_xy(k, 11.90, a - 1.50) + (L3 + 2.30,),
                         wall_xy(k, 11.90, a + 1.50) + (L3 + 2.30,), 0.07, N_MAGENTA)

# ---- the bar, along the back (-X) wall -------------------------------------------------------------

BAR_K, BAR_LEN = 2, 20.0

with b.part('bar'):
    wall_box(BAR_K, 17.60, 0.0, L2, L2 + 1.15, 1.30, BAR_LEN,
             near=P_BAR_FRONT, far=P_BAR_FRONT, side=P_BAR_FRONT, skip=(0,))
    wall_box(BAR_K, 17.60, 0.0, L2 + 1.15, L2 + 1.26, 1.70, BAR_LEN + 0.4,
             near=P_BAR_TOP, far=P_BAR_TOP, side=P_BAR_TOP, top=P_BAR_TOP)
    # The hood stops at depth 18.9 because the rake crosses z=12.04 there, and it sits at 11.4.
    wall_box(BAR_K, 17.60, 0.0, 11.40, 11.62, 2.60, BAR_LEN,
             near=P_BAR_HOOD, far=P_BAR_HOOD, side=P_BAR_HOOD, top=P_DARK, bot=P_BAR_HOOD)
    for i in range(3):
        z = 9.10 + i * 1.00
        wall_box(BAR_K, in_half(z) - 0.42, 0.0, z, z + 0.12, 0.62, 17.0,
                 near=P_SHELF, far=P_SHELF, side=P_SHELF, top=P_SHELF, bot=P_SHELF)
    for i in range(9):
        sx, sy = wall_xy(BAR_K, 16.30, -8.0 + 2.0 * i)
        drum(sx, sy, L2, L2 + 0.72, 0.11, 0.09, 6, P_STOOL)
        drum(sx, sy, L2 + 0.72, L2 + 0.80, 0.27, 0.27, 8, P_STOOL,
             cap_top=P_STOOL, cap_bot=P_STOOL)

with b.part('back bar'):
    # The bottle wall is PAINTED on the raked wall rather than modelled: rows of backlit bottles are
    # the one thing a 64 px panel does better than geometry, and the rake means real shelves would
    # need mitring to a 51.7 deg ceiling.
    skin_quad(BAR_K, 8.20, 11.60, lambda h: -9.0, lambda h: 9.0, P_BACKBAR, 0.10)

# ---- the dance floor -------------------------------------------------------------------------------

with b.surface(1):
    with b.part('dance floor'):
        # Light tiles on the SCROLLING page, so the floor flows. Each tile takes one colour row and
        # half a pattern period, and every other tile has its corner cycle rotated so its U runs the
        # other way — otherwise 160 tiles all crawl in +X together and the floor reads as a conveyor.
        DANCE_PITCH, DANCE_REACH, DANCE_HOLE = 2.4, 16.8, 9.0
        n = int(DANCE_REACH / DANCE_PITCH)
        for ix in range(-n, n):
            for iy in range(-n, n):
                x0, y0 = ix * DANCE_PITCH, iy * DANCE_PITCH
                x1, y1 = x0 + DANCE_PITCH, y0 + DANCE_PITCH
                if math.hypot(x0 + DANCE_PITCH / 2, y0 + DANCE_PITCH / 2) < DANCE_HOLE:
                    continue
                row = rnd.choice((N_CYAN, N_MAGENTA, N_VIOLET, N_ICE, N_GREEN, N_CHASE))
                cyc = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
                if rnd.random() < 0.5:
                    cyc = cyc[1:] + cyc[:1]
                face4(*[(x, y, L2 + 0.03) for x, y in cyc],
                      neon(row, DANCE_PITCH), (0.0, 0.0, 1.0))

# ---- screens on the raked walls ---------------------------------------------------------------------

with b.surface(2):
    with b.part('wall screens'):
        for k in range(4):
            for i, a in enumerate((-11.0, 11.0)):          # over the dance floor
                skin_quad(k, 8.60, 13.40, lambda h, a=a: a - 3.5, lambda h, a=a: a + 3.5,
                          video((k + i) % VIDEO_COLS, 1.0), 0.10)
            for i, a in enumerate((-5.0, 5.0)):            # above the booths
                skin_quad(k, 19.40, 22.60, lambda h, a=a: a - 2.6, lambda h, a=a: a + 2.6,
                          video((k + i + 2) % VIDEO_COLS, 1.0), 0.10)
        for i, a in enumerate((-11.5, 11.5)):              # flanking the entrance, outside
            skin_quad(0, 8.00, 12.50, lambda h, a=a: a - 2.2, lambda h, a=a: a + 2.2,
                      video(i * 2 + 1, 1.0), 0.14, outside=True)

# ---- light ------------------------------------------------------------------------------------------

SLANT = math.hypot(HALF, APEX) / APEX      # metres of face per metre of height
IN_SLANT = math.hypot(IN_HALF, IN_APEX) / IN_APEX


def face_disc(k, z, a, r, sides, panel, off, rays=0, ray_row=N_AMBER, ray_out=1.0):
    """A disc lying flat on exterior face k — the club's own mark, hung over its front door.

    The face's two in-plane axes are `a` (horizontal, along the wall) and `s` (up the slope), and
    `a x s` is the face's outward normal, so a ring wound CCW in (a, s) faces out with no case
    analysis. Radial UVs put concentric art on concentric rings, which is the one place in this
    library that is the point rather than the warning.
    """
    c, sn = QUARTER[k]
    axis_a = (-sn, c, 0.0)
    axis_s = _unit((-HALF / APEX * c, -HALF / APEX * sn, 1.0))
    centre = ext_point(k, z, a, off)

    def at(radius, t):
        return tuple(centre[m] + radius * (math.cos(t) * axis_a[m] + math.sin(t) * axis_s[m])
                     for m in range(3))

    base = len(b.verts)
    for i in range(sides):
        b.vert(*at(r, 2 * math.pi * i / sides))
    mid = b.vert(*centre)
    for i in range(sides):
        j = (i + 1) % sides
        pts = [at(r, 2 * math.pi * m / sides) for m in (i, j)]
        b.face((base + i, base + j, mid),
               tuple(_lib.radial_uv(panel, math.cos(2 * math.pi * m / sides) * r,
                                    math.sin(2 * math.pi * m / sides) * r, r) for m in (i, j))
               + (_lib.uv(panel, 0.5, 0.5),), ext_normal(k))
    for i in range(rays):
        t = 2 * math.pi * i / rays + math.pi / rays
        w = 0.10
        face4(at(r + 0.15, t - w), at(r + ray_out, t - w * 0.45),
              at(r + ray_out, t + w * 0.45), at(r + 0.15, t + w),
              neon(ray_row, ray_out), ext_normal(k))


with b.surface(1):
    with b.part('exterior light'):
        # The arrises first: two strips per corner, one on each adjacent face, so a corner reads as
        # a folded channel of light rather than a painted line. This is the shape that makes the
        # whole silhouette legible from the bottom of the run at night.
        for k in range(4):
            length = (35.5 - 0.6) * SLANT
            skin_quad(k, 0.60, 35.5, lambda h: h - 0.62, lambda h: h - 0.06,
                      neon(N_CYAN, length), 0.18, outside=True, u_up=True)
            skin_quad(k, 0.60, 35.5, lambda h: -h + 0.06, lambda h: -h + 0.62,
                      neon(N_CYAN, length), 0.18, outside=True, u_up=True)
        # Then the horizontal courses, on the band seams — which is why the seams were placed where
        # the building actually changes rather than at even heights.
        for z, row in ((0.55, N_VIOLET), (L2, N_MAGENTA), (PORTAL_TOP, N_CYAN),
                       (20.4, N_VIOLET), (27.0, N_MAGENTA), (33.0, N_ICE)):
            for k in range(4):
                skin_quad(k, z - 0.20, z + 0.20, lambda h: -h + 0.85, lambda h: h - 0.85,
                          neon(row, 2 * (out_half(z) - 0.85)), 0.16, outside=True)
        # The portal surround — jambs and head, on the outside face.
        for s in (-1, 1):
            skin_quad(0, L2, PORTAL_TOP,
                      lambda h, s=s: s * PORTAL_HY + (0.0 if s > 0 else -0.62),
                      lambda h, s=s: s * PORTAL_HY + (0.62 if s > 0 else 0.0),
                      neon(N_ICE, (PORTAL_TOP - L2) * SLANT), 0.16, outside=True, u_up=True)
        skin_quad(0, PORTAL_TOP, PORTAL_TOP + 0.52,
                  lambda h: -PORTAL_HY - 0.62, lambda h: PORTAL_HY + 0.62,
                  neon(N_ICE, 2 * PORTAL_HY + 1.24), 0.16, outside=True)

with b.part('emblem'):
    # The black sun over the front door: a dark disc on a 51.7 deg face, ringed and spoked with
    # light, sitting at eye height for anyone coming up the ramp.
    face_disc(0, 21.5, 0.0, 5.40, 20, P_SUN_DISC, 0.20)
    face_disc(0, 21.5, 0.0, 5.75, 20, P_SUN_RAY, 0.16, rays=12, ray_row=N_AMBER, ray_out=3.1)

with b.surface(1):
    with b.part('interior light'):
        for k in range(4):
            # A cove where the raked wall lands on the dance floor, and the line under the balcony
            # edge — the two horizontals that tell you how big the room is.
            annulus(k, L2 + 0.05, in_half(L2) - 1.30, in_half(L2) - 0.15,
                    neon(N_MAGENTA, 2 * in_half(L2)), up=True)
            annulus(k, MEZZ_BOT - 0.04, ATRIUM + 0.10, ATRIUM + 1.10,
                    neon(N_VIOLET, 2 * ATRIUM), up=False)
            # ...the interior arrises, climbing the full 25 m of atrium...
            for lo, hi in ((lambda h: h - 0.70, lambda h: h - 0.10),
                           (lambda h: -h + 0.10, lambda h: -h + 0.70)):
                skin_quad(k, L2 + 0.3, 31.6, lo, hi,
                          neon(N_CYAN, (31.6 - L2 - 0.3) * IN_SLANT), 0.14, u_up=True)
            neon_bar(wall_xy(k, ATRIUM - 0.07, -ATRIUM) + (MEZZ_BOT + 0.10,),
                     wall_xy(k, ATRIUM - 0.07, ATRIUM) + (MEZZ_BOT + 0.10,), 0.06, N_ICE)
            # ...and the last two metres of the atrium before the oculus, lit as a funnel. The disc
            # needs something to be dark AGAINST: a black disc on a black ceiling is not a black sun,
            # it is nothing, and the corona alone is a bracelet 25 m up.
            skin_quad(k, 30.4, 32.4, lambda h: -h + 0.06, lambda h: h - 0.06,
                      neon(N_VIOLET, 2 * in_half(31.4)), 0.10)
        drum(0.0, 0.0, 8.30, 8.50, 7.58, 7.58, 12,
             neon(N_AMBER, 2 * math.pi * 7.58 / 12))
        # the threshold you ride over
        neon_bar((out_half(L2) - 0.30, -PORTAL_HY, L2 + 0.06),
                 (out_half(L2) - 0.30, PORTAL_HY, L2 + 0.06), 0.06, N_ICE)

with b.surface(1):
    with b.part('ramp light'):
        # Flush inlays, not kerbs: this is a surface a rider crosses at speed, so the light is in
        # the deck rather than standing proud of it where a board would catch.
        for i in range(RAMP_BANDS):
            t0, t1 = i / RAMP_BANDS, (i + 1) / RAMP_BANDS
            x0, x1, z0, z1 = ramp_x(t0), ramp_x(t1), ramp_z(t0), ramp_z(t1)
            w0, w1 = ramp_w(t0), ramp_w(t1)
            lift, run = 0.03, math.dist((x0, 0.0, z0), (x1, 0.0, z1))

            def inlay(lo0, hi0, lo1, hi1, row, x0=x0, x1=x1, z0=z0, z1=z1, run=run):
                """Low y edge first, then along the run: that cycle is what puts U down the ramp
                AND leaves the deck's own normal pointing up out of it."""
                face4((x0, lo0, z0 + lift), (x1, lo1, z1 + lift),
                      (x1, hi1, z1 + lift), (x0, hi0, z0 + lift), neon(row, run), RAMP_N)

            inlay(w0 - 0.55, w0 - 0.10, w1 - 0.55, w1 - 0.10, N_CYAN)
            inlay(-w0 + 0.10, -w0 + 0.55, -w1 + 0.10, -w1 + 0.55, N_CYAN)
            inlay(-0.42, 0.42, -0.42, 0.42, N_AMBER)

# ---- the rig -----------------------------------------------------------------------------------------

TRUSS_R, TRUSS_Z = 11.0, 15.0
CORNERS = [(TRUSS_R, TRUSS_R), (-TRUSS_R, TRUSS_R), (-TRUSS_R, -TRUSS_R), (TRUSS_R, -TRUSS_R)]

with b.part('truss'):
    for i in range(4):
        p, q = CORNERS[i], CORNERS[(i + 1) % 4]
        beam((p[0], p[1], TRUSS_Z), (q[0], q[1], TRUSS_Z), 0.22, 0.22, P_TRUSS, cap=False)
        for t in (0.2, 0.5, 0.8):
            hx, hy = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
            beam((hx, hy, TRUSS_Z), (hx, hy, MEZZ_BOT), 0.05, 0.05, P_DUCT)
            box(b, (hx, hy, TRUSS_Z - 0.42), (0.34, 0.34, 0.46), P_FIXTURE)
            # The lens is its own face rather than the fixture box's bottom panel: a housing wants a
            # dark skin on five sides and a hot one on the sixth, and a box takes one panel per face
            # anyway, so this costs nothing and keeps `P_FIXTURE` genuinely dark.
            disc(hx, hy, TRUSS_Z - 0.66, 0.13, 6, P_LENS, up=False)
    for p in CORNERS:
        box(b, (p[0], p[1], TRUSS_Z), (0.5, 0.5, 0.5), P_TRUSS_NODE)

with b.part('sweep heads'):
    # The four declared rotations, which is the whole allowance (MAX_IMPORT_SPINS = 4). A beam is a
    # single arm rather than a symmetric disc, so it does not strobe the way a fan does — and the
    # 9.5 m reach is set by the two things it must miss: the DJ podium at 8.7 m radius on the way
    # in, and the raked wall on the way out.
    for i, p in enumerate(CORNERS):
        pivot = (p[0], p[1], 14.55)
        sx, sy = (1.0 if p[0] > 0 else -1.0), (1.0 if p[1] > 0 else -1.0)
        with b.spin(pivot, (0.0, 0.0, 1.0), 0.11 if i % 2 == 0 else -0.11):
            box(b, (pivot[0], pivot[1], pivot[2] + 0.10), (0.44, 0.44, 0.52), P_FIXTURE)
            tip = (pivot[0] + sx * 4.75, pivot[1] + sy * 4.75, pivot[2] - 6.72)
            with b.surface(1):
                beam(pivot, tip, 0.16, 0.78, neon(N_ICE if i % 2 == 0 else N_MAGENTA, 9.5),
                     along=True)

with b.part('speakers'):
    for sx in (-1, 1):
        for sy in (-1, 1):
            px, py = sx * 7.21, sy * 7.21
            box(b, (px, py, L2 + 1.00), (1.90, 1.40, 2.00),
                [P_DARK, P_SPK_SIDE, P_SPK_FACE, P_SPK_FACE, P_SPK_FACE, P_SPK_FACE], skip=(0,))
            box(b, (px, py, L2 + 2.70), (1.60, 1.20, 1.40),
                [P_SPK_SIDE, P_SPK_SIDE, P_SPK_FACE, P_SPK_FACE, P_SPK_FACE, P_SPK_FACE])
            box(b, (px, py, L2 + 3.85), (1.30, 1.00, 0.90),
                [P_SPK_SIDE, P_SPK_SIDE, P_SPK_FACE, P_SPK_FACE, P_SPK_FACE, P_SPK_FACE])

# ==== END OF PARTS ================================================================================

finish(b, NAME, TEX, GLB, roughness=0.55, surfaces=[
    # 1 — the light strips. U per SECOND; the page is uniform along U by construction, which is the
    #     only thing that makes a scroll legal (README: it must tile along the scroll axis).
    surface(NEON_TEX, scroll=(0.45, 0.0)),
    # 2 — the video walls, running upward. A scroll auto-attaches on placement where a flipbook
    #     would sit on frame 0 until someone authored an effect for it.
    surface(VIDEO_TEX, scroll=(0.0, 0.30)),
    # 3 — the glass. Cutout rather than blended: every prop material is built at alphaTest 0.4, so
    #     "translucent" here is a dither the mip chain reads as haze.
    surface(GLASS_TEX, alpha=True),
])
