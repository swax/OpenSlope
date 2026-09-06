"""
Shared machinery for the low-poly prop recipes — the geometry primitives, the atlas-UV helpers, and the
build/verify/export tail every recipe ends with.

Runs INSIDE Blender (needs `bpy`). Its twin `_atlas.py` runs in the system Python and needs Pillow;
they are deliberately separate files so neither drags in the other's dependency.

A recipe looks like:

    import sys
    if ROOT not in sys.path: sys.path.insert(0, ROOT)
    import importlib, _lib; importlib.reload(_lib)      # Blender stays open between runs
    from _lib import *

    b = Build()
    with b.part('chassis'):
        box(b, ...)
    finish(b, name='Thing', tex=..., glb=...)

## The budget this targets

The target platform's own cost census, so "in family" is a number:

    Mdl_SnowBlower_Bottom (SNOW)       120 tris     a small prop part
    GARI's 648-model average          ~350 tris
    Mdl_Vehicle_SnowCat (ELYSIUM)     1662 tris     a hero vehicle
    Mdl_Vehicle_SnowCatB (GARI)       3216 tris

## Orientation is the thing this library exists to get right

A prop's normals are DERIVED from its stored winding, and the hardware lights a face from that normal
alone — `ambient + Σ max(0, N·L)·key`, shown identically from both sides (docs/028). A face wound
inside-out still draws (prop meshes are double-sided) but draws ambient-only dark from every view.

Two checks run before any export, because one is not enough:

- **Raw-space enclosed volume** must be POSITIVE, which is the convention every prop on the target
  platform stores its geometry in. This models the importer exactly — mirror the
  positions AND reverse each triangle, `glb-import.ts` — so it is a claim about what actually gets
  STORED. The equivalent check in glTF space is worthless: the frame change is a mirror, so glTF-space
  winding passes while the stored data is upside-down.
- **Per-face expected facing**, which still works on the open shells the volume test cannot judge.
  Every primitive records which way each face it emits is supposed to look.

`mirror_x` carries the same lesson one level up: a mirror reverses orientation, so it reverses the
index order of everything it copies. Without that, the mirrored half of any symmetric prop ships dark.
"""

import contextlib
import json
import math
import os
import random

import bpy

# ---- UV panels --------------------------------------------------------------------------------------

INSET = 2.0 / 128.0  # off each panel edge, so mip filtering cannot bleed one panel into the next


def panels(cols, rows):
    """The atlas grid as (u0, v0, u1, v1) rects in UV space, indexed [row][col] from the image's TOP-LEFT.

    Image space runs top-down and UV space runs bottom-up, so row 0 is the top row of the PNG and lands
    at the high-V end here. `_atlas.panels` returns the same grid in image pixels — the two must agree,
    which is why both are generated rather than written out by hand.
    """
    return [[(c / cols, 1.0 - (r + 1) / rows, (c + 1) / cols, 1.0 - r / rows)
             for c in range(cols)] for r in range(rows)]


def uv(panel, s, t):
    """A point in a panel's own 0-1 space, inset off its edges."""
    u0, v0, u1, v1 = panel
    return (u0 + INSET + s * (u1 - u0 - 2 * INSET), v0 + INSET + t * (v1 - v0 - 2 * INSET))


def band_uv(panel, t0=0.0, t1=1.0):
    """A side quad spanning a panel's full width over the vertical slice [t0, t1]. Repeats around a ring."""
    return (uv(panel, 0.0, t0), uv(panel, 1.0, t0), uv(panel, 1.0, t1), uv(panel, 0.0, t1))


def rect_uv(panel):
    """A quad taking the whole panel, corners in the order box()/quad() emit them."""
    return (uv(panel, 0.0, 0.0), uv(panel, 1.0, 0.0), uv(panel, 1.0, 1.0), uv(panel, 0.0, 1.0))


def radial_uv(panel, x, y, r):
    """Project a cap vertex onto its panel radially.

    NOTE this maps circles in texture space onto circles on the cap — so anything concentric painted into
    the panel lands as concentric rings on the prop and reads as a vinyl record. Paint irregular blobs.
    """
    return uv(panel, 0.5 + 0.5 * x / r, 0.5 + 0.5 * y / r)


# ---- the accumulator --------------------------------------------------------------------------------

class Build:
    """Verts, faces, per-face UVs, and per-face EXPECTED facing, plus the part tags that drive the
    triangle-budget table. Faces may be tris or quads; Blender triangulates on export."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.uvs = []
        self.out = []
        self.parts = []
        self.mats = []          # per-face material slot; 0 is the prop's own atlas
        self._mat = 0
        self.spins = []         # declared rotations, in `spin()` / `swing()` order
        self.face_spin = []     # per-face rotation ordinal; -1 for parts that stay bolted down
        self._spin = -1

    @contextlib.contextmanager
    def part(self, name):
        start = len(self.faces)
        yield
        self.parts.append((name, start, len(self.faces)))

    @contextlib.contextmanager
    def surface(self, index):
        """Emit faces onto a material OTHER than the prop's own atlas.

        Almost every prop wants exactly one material — one page, one draw, and the budget table stays
        readable. The exception is a surface that has to ANIMATE, because effects attach per material:
        a stream's water scrolls and its banks must not, so they cannot share a slot. Slot 0 is
        always `finish(tex=)`; 1..n are `finish(surfaces=[...])` in order.
        """
        was, self._mat = self._mat, index
        try:
            yield
        finally:
            self._mat = was

    @contextlib.contextmanager
    def _rotation(self, spec, parent):
        """Common hierarchy bookkeeping for spin() and swing()."""
        parent = self._spin if parent is None else parent
        ordinal = len(self.spins)
        if parent >= ordinal or parent < -1:
            raise ValueError(f'rotation parent must be an earlier ordinal, got {parent} for {ordinal}')
        self.spins.append(dict(spec, parent=parent))
        was, self._spin = self._spin, ordinal
        try:
            yield ordinal
        finally:
            self._spin = was

    @contextlib.contextmanager
    def spin(self, pivot, axis, revs_per_second, parent=None):
        """Emit faces that TURN — a fan inside its barrel, a wheel, a beacon.

        The faces inside become their own glTF node, parented to the prop and carrying a `OpenSlope_animation`
        declaration; the importer turns that into the same object-hierarchy clip an extracted level's
        `ModelObjects` decode to, and a placement auto-attaches the Model clip effect that runs it. This
        is the arrangement the format itself expects — an animated prop is two objects, the second
        parented to the first with one rotation channel.

        - `pivot` the point turned about, in the recipe's own Blender coordinates.
        - `axis`  the axis turned about, same frame; need not be unit.
        - `revs_per_second` rate, the sign choosing a direction. The raw frame is MIRRORED, so which way
          a given sign comes out on screen is not worth deriving — look at it and flip it if it is wrong.
        - `parent` another spin's ordinal. Omit it inside an outer `with b.spin(...) as turn:` block and
          that outer turn becomes the parent automatically. This is a real motion hierarchy: a nested car
          orbits with its platform before it turns about its own pivot.

        Anything rotationally symmetric about `axis` is its own worst case: an eight-wedge disc looks the
        same every 45 degrees, so it repeats eight times a revolution and a rate that would be readable
        on a lopsided blade reads as a strobe here. Turn it slower than seems right.
        """
        with self._rotation({'kind': 'spin', 'pivot': tuple(pivot), 'axis': tuple(axis),
                             'rps': float(revs_per_second)}, parent) as ordinal:
            yield ordinal

    @contextlib.contextmanager
    def swing(self, pivot, axis, amplitude_degrees, period_seconds, parent=None):
        """Emit faces that rock back and forth like a chairlift or pirate-ship pendulum.

        The node uses the same pivot/axis mount as spin(), but its native curve crosses the rest pose,
        eases through each `amplitude_degrees` apex and returns after `period_seconds`. The amplitude may
        be negative to choose which direction the first half-cycle travels. Nesting follows spin().
        """
        amplitude, period = float(amplitude_degrees), float(period_seconds)
        if not 0 < abs(amplitude) <= 89:
            raise ValueError(f'swing amplitude must be nonzero and at most 89 degrees, got {amplitude}')
        if not 0 < period <= 30:
            raise ValueError(f'swing period must be in (0, 30] seconds, got {period}')
        with self._rotation({'kind': 'swing', 'pivot': tuple(pivot), 'axis': tuple(axis),
                             'amplitude': amplitude, 'period': period}, parent) as ordinal:
            yield ordinal

    def vert(self, x, y, z):
        self.verts.append((x, y, z))
        return len(self.verts) - 1

    def face(self, idx, uvs, out):
        assert len(idx) == len(uvs), f'{len(idx)} corners but {len(uvs)} UVs'
        self.faces.append(tuple(idx))
        self.uvs.append(tuple(uvs))
        self.out.append(out)
        self.mats.append(self._mat)
        self.face_spin.append(self._spin)

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)


# ---- geometry ---------------------------------------------------------------------------------------

def wobble(n, seed, amount):
    """Per-angle radius factors — one profile per part, shared by all of that part's rings, so a lathed
    shape gets an irregular OUTLINE while its sides stay vertical. A clean lathe reads as CAD."""
    rnd = random.Random(seed)
    return [1.0 + rnd.uniform(-amount, amount) for _ in range(n)]


def ring(n, r, z, factors=None, cx=0.0, cy=0.0):
    return [(cx + r * (factors[i] if factors else 1.0) * math.cos(2 * math.pi * i / n),
             cy + r * (factors[i] if factors else 1.0) * math.sin(2 * math.pi * i / n), z)
            for i in range(n)]


def outward(n, i):
    """The horizontal direction the side quad between ring vertices i and i+1 should face."""
    a = 2 * math.pi * (i + 0.5) / n
    return (math.cos(a), math.sin(a), 0.0)


def puck(b, n, z_bot, z_top, r, panel_side, panel_cap, factors=None, dome=0.0, dome_dn=None):
    """A lathed disc: ring-to-ring sides plus a domed fan at each end. 4n triangles."""
    base = len(b.verts)
    bot, top = ring(n, r, z_bot, factors), ring(n, r, z_top, factors)
    for v in bot + top:
        b.vert(*v)
    c_bot = b.vert(0.0, 0.0, z_bot - (dome * 0.5 if dome_dn is None else dome_dn))
    c_top = b.vert(0.0, 0.0, z_top + dome)
    for i in range(n):
        j = (i + 1) % n
        b.face((base + i, base + j, base + n + j, base + n + i), band_uv(panel_side), outward(n, i))
    for i in range(n):
        j = (i + 1) % n
        b.face((base + n + i, base + n + j, c_top),
               (radial_uv(panel_cap, top[i][0], top[i][1], r),
                radial_uv(panel_cap, top[j][0], top[j][1], r), uv(panel_cap, 0.5, 0.5)),
               (0.0, 0.0, 1.0))
    for i in range(n):
        j = (i + 1) % n
        b.face((base + j, base + i, c_bot),
               (radial_uv(panel_cap, bot[j][0], bot[j][1], r),
                radial_uv(panel_cap, bot[i][0], bot[i][1], r), uv(panel_cap, 0.5, 0.5)),
               (0.0, 0.0, -1.0))


def cylinder(b, n, z0, z1, r0, r1, panel_side, panel_cap=None, factors=None,
             cap_bottom=False, cap_top=False):
    """A tapered tube — trunks, poles, lift towers, bamboo. Caps are opt-in because most of the time one
    end is buried in the ground and the other is inside whatever sits on it."""
    base = len(b.verts)
    lo, hi = ring(n, r0, z0, factors), ring(n, r1, z1, factors)
    for v in lo + hi:
        b.vert(*v)
    for i in range(n):
        j = (i + 1) % n
        b.face((base + i, base + j, base + n + j, base + n + i), band_uv(panel_side), outward(n, i))
    cap = panel_cap or panel_side
    if cap_bottom:
        c = b.vert(0.0, 0.0, z0)
        for i in range(n):
            j = (i + 1) % n
            b.face((base + j, base + i, c),
                   (radial_uv(cap, lo[j][0], lo[j][1], max(r0, 1e-6)),
                    radial_uv(cap, lo[i][0], lo[i][1], max(r0, 1e-6)), uv(cap, 0.5, 0.5)),
                   (0.0, 0.0, -1.0))
    if cap_top:
        c = b.vert(0.0, 0.0, z1)
        for i in range(n):
            j = (i + 1) % n
            b.face((base + n + i, base + n + j, c),
                   (radial_uv(cap, hi[i][0], hi[i][1], max(r1, 1e-6)),
                    radial_uv(cap, hi[j][0], hi[j][1], max(r1, 1e-6)), uv(cap, 0.5, 0.5)),
                   (0.0, 0.0, 1.0))


def tapered_trunk(b, n, segments, z0, z1, r0, r1, panel, panel_cap=None, factors=None, cap_top=False):
    """A trunk as a stack of tapered tubes, radius interpolated linearly with height.

    Five sides and a handful of segments is the whole thing, uncapped: the bottom is in the ground and
    the top is inside the crown, so neither cap is ever seen and both are pure cost. The segments are
    not there for roundness — five sides already reads as round at this size — they are what makes the
    taper show in silhouette and what gives per-vertex lighting something to vary over up the height.
    `trees/_species.py` derives both counts from the stem it is describing.
    """
    for seg in range(segments):
        t0, t1 = seg / segments, (seg + 1) / segments
        cylinder(b, n, z0 + (z1 - z0) * t0, z0 + (z1 - z0) * t1,
                 r0 + (r1 - r0) * t0, r0 + (r1 - r0) * t1, panel, panel_cap=panel_cap,
                 factors=factors, cap_top=cap_top and seg == segments - 1)


def card(b, origin, yaw, length, height, panel, tilt=0.0, droop=0.0, segments=2, taper=0.62,
         rise=0.0, hand=1.0):
    """A billboard strip radiating outward from `origin`, carrying an alpha-cut sprig.

    Foliage at this budget is vertical sheets and nothing else: a few dozen cards radiating from the
    trunk, the tree's whole outline living in the alpha channel of a page that is more than half holes.
    Solid geometry cannot express a conifer for the same triangles — a cone at 280 reads as a cone. The
    geometry is scaffolding for the art, not the other way round.

    Three angles, and they do different jobs:

    - `rise` elevates the card's own axis, so the sprig climbs as it goes out instead of running
      horizontally. This is tree ARCHITECTURE, not styling: a conifer's boughs leave the trunk level or
      below and its silhouette is a cone, while a broadleaf's limbs sweep upward and its crown is a
      dome. A birch built at rise=0 reads as a pale spruce however its texture is painted.
    - `tilt` rolls the card about that axis, lifting the face normal off horizontal so the sheet catches
      the key light instead of only ever taking it edge-on.
    - `droop` drops the tip, after both.

    `hand` (+1 or -1) picks WHICH WAY the tilt rolls, and a tree needs both. The roll direction cannot
    simply be flipped by negating `tilt`, because the normal's vertical component IS sin(tilt) — a
    negative tilt aims the sheet at the ground and it ships ambient-only dark. So every card rolled the
    only way it was allowed to, and a whole canopy of them came out as a pinwheel: sighting up any one
    side of the tree, every frond leaned the same way. `hand=-1` mirrors the card across its own
    axis instead of rotating it back, and reverses the winding so the normal still points up.

    UVs run inner→outer along U and bottom→top along V, so a sprig painted trunk-at-left, snow-on-top
    lands the right way up with no per-card decisions. That survives the mirror: `+up` keeps its
    positive vertical component either way, so V=1 is the upper edge for both hands.
    """
    d = (math.cos(rise) * math.cos(yaw), math.cos(rise) * math.sin(yaw), math.sin(rise))
    perp = (-math.sin(yaw), math.cos(yaw), 0.0)
    # the card's "vertical", perpendicular to the risen axis; at rise=0 this is simply +Z
    n0 = (-math.sin(rise) * math.cos(yaw), -math.sin(rise) * math.sin(yaw), math.cos(rise))
    up = (hand * math.sin(tilt) * perp[0] + math.cos(tilt) * n0[0],
          hand * math.sin(tilt) * perp[1] + math.cos(tilt) * n0[1],
          math.cos(tilt) * n0[2])
    normal = (hand * (d[1] * up[2] - d[2] * up[1]),
              hand * (d[2] * up[0] - d[0] * up[2]),
              hand * (d[0] * up[1] - d[1] * up[0]))

    base = len(b.verts)
    for k in range(segments + 1):
        t = k / segments
        half = height * 0.5 * (1.0 - (1.0 - taper) * t)      # the frond narrows toward the tip
        cx = origin[0] + d[0] * length * t
        cy = origin[1] + d[1] * length * t
        cz = origin[2] + d[2] * length * t - droop * (t ** 1.6)
        b.vert(cx - up[0] * half, cy - up[1] * half, cz - up[2] * half)
        b.vert(cx + up[0] * half, cy + up[1] * half, cz + up[2] * half)
    for k in range(segments):
        lo, hi = base + k * 2, base + (k + 1) * 2
        t0, t1 = k / segments, (k + 1) / segments
        corners = (lo, hi, hi + 1, lo + 1)
        uvs = (uv(panel, t0, 0.0), uv(panel, t1, 0.0), uv(panel, t1, 1.0), uv(panel, t0, 1.0))
        if hand < 0:
            # a mirror reverses orientation, so the corner order goes with it — UVs reversed alongside
            # so each stays paired with its own vertex and the art does not slide off the strip
            corners, uvs = tuple(reversed(corners)), tuple(reversed(uvs))
        b.face(corners, uvs, normal)


GOLDEN = math.radians(137.508)


def whorls(b, rows, panels, ring0=0, attach=None, height_ratio=0.60, segments=2, taper=0.62,
           stagger=GOLDEN, jitter=0.0, seed=0):
    """Rings of `card` sprigs radiating from a trunk — the body of any tree at this budget.

    Each row is `(z, count, length, droop, tilt_deg)`, optionally with a sixth `rise_deg`. This is the
    axis that separates one tree from another at this budget: the whole difference between a squat
    treeline pine, a tall one carrying its mass up top, and a birch with a bare lower trunk is which
    heights appear and how long the sprigs are there — not the texture, which three of them share.

    The rows are not hand-written. `trees/_species.py` generates them from crown ratio, crown spread,
    annual height increment and branch insertion angle, so a recipe declares a species rather than a
    ladder; this function only lays out what that produced.

    Ring k is yawed by `(ring0 + k) * stagger`. The golden angle is the default because any rational
    fraction of a turn makes successive rings land on top of each other, which stacks the sprigs into
    columns and puts a visible seam down one side of the silhouette. `ring0` continues the sequence
    across a second call, so a crown added on top of a body does not restart the stagger.

    `attach` maps a height to the radius its sprigs start at — normally slightly INSIDE the trunk, so a
    card's inner edge is buried in the bark instead of floating off it. Omit it to start on the axis.

    `jitter` (0-1, with `seed`) breaks the ring up. A table alone gives every sprig in a ring exactly
    one height, length, tilt and angular spacing, and the eye reads that regularity as manufactured
    however good the art is — real whorls are ragged. Each quantity is perturbed against its own
    natural scale rather than by one blanket percentage: yaw by up to half the gap to its neighbour, so
    sprigs cluster and gap without ever crossing; height and length in proportion to the sprig, so a
    0.3 m tip is not shaken as hard as a 1.7 m bough. The panel is drawn at random too, since a strict
    cycle through six sprigs is itself a visible pattern once a ring holds five or six of them.
    """
    rnd = random.Random(seed)

    def wob():
        return rnd.uniform(-jitter, jitter)

    n = 0
    for k, row in enumerate(rows):
        z, count, length, droop, tilt_deg = row[:5]
        rise_deg = row[5] if len(row) > 5 else 0.0
        for i in range(count):
            yaw = (ring0 + k) * stagger + i * 2 * math.pi / count
            cz, ln, dr, tl, rs = z, length, droop, tilt_deg, rise_deg
            panel = panels[n % len(panels)]
            if jitter:
                # 0.35 of the gap, not the half that "never crosses a neighbour" would allow: at a
                # half, two adjacent sprigs can collapse onto each other AND leave a double-width hole
                # on the other side, which punches bare patches of trunk through the canopy.
                yaw += wob() * 0.70 * math.pi / count
                cz += wob() * 0.12 * length
                ln *= 1.0 + wob() * 0.22
                dr *= 1.0 + wob() * 0.30
                # The ANGLES get the widest swing of anything here. A ring whose sprigs all leave the
                # trunk at one angle reads as machined even when their lengths and heights differ —
                # the eye picks up a repeated angle far faster than a repeated size. ±13 and ±11 deg
                # against the ±7 this used to run, which is under the threshold where it registers.
                #
                # Tilt is floored rather than allowed to swing symmetrically: it rolls the card off
                # vertical, and at or below zero the face normal drops to horizontal or under, which
                # ships the sprig ambient-only dark. See the sheet check in `check.py`.
                tl = max(5.0, tl + wob() * 13.0)
                rs += wob() * 11.0
                panel = panels[rnd.randrange(len(panels))]
            r = attach(cz) if attach else None
            origin = (0.0, 0.0, cz) if r is None else (r * math.cos(yaw), r * math.sin(yaw), cz)
            # Coin-flip the roll direction. Tilt can only ever roll a card one way without aiming its
            # normal at the ground, so left to itself a canopy comes out as a pinwheel — every frond on
            # the tree leaning the same way, obvious the moment you sight up one side of the trunk.
            # This is seeded, so it stays deterministic, and it applies whether or not jitter is on.
            card(b, origin, yaw, ln, ln * height_ratio, panel,
                 tilt=math.radians(tl), droop=dr, segments=segments, taper=taper,
                 rise=math.radians(rs), hand=1.0 if rnd.random() < 0.5 else -1.0)
            n += 1
    return n


def skirt(b, n, z_in, z_out, r_in, r_out, panel, factors=None):
    """One single-sided conical fan — a conifer's foliage tier, an umbrella, a lampshade.

    ONE sheet, no duplicate underside. That is the convention for thin props (docs/028): object
    lighting is per-vertex from the authored normal and the hardware shows identical shading from both
    sides, so a reversed twin costs triangles and changes nothing visible. The census backs it — the only
    doubled faces anywhere in the platform's 648-model reference level are on panels that un-mirror readable
    art, not to light anything.

    The consequence is that the normal MUST point up-and-out. A foliage sheet whose normal aims at the
    ground is ambient-only dark from every view, which is the one failure the arrows exist to show.

    UVs run inner→outer up the panel's V, so a foliage panel painted green at the bottom and frosted at
    the top puts the snow on the branch TIPS without any per-face decisions.
    """
    base = len(b.verts)
    inner, outer = ring(n, r_in, z_in), ring(n, r_out, z_out, factors)
    for v in inner + outer:
        b.vert(*v)
    drop, reach = z_in - z_out, r_out - r_in
    for i in range(n):
        j = (i + 1) % n
        a = 2 * math.pi * (i + 0.5) / n
        b.face((base + i, base + n + i, base + n + j, base + j),
               (uv(panel, 0.0, 0.0), uv(panel, 0.0, 1.0), uv(panel, 1.0, 1.0), uv(panel, 1.0, 0.0)),
               (math.cos(a) * drop, math.sin(a) * drop, reach))


def barrel(b, n, z0, z2, r, panel, factors=None, bulge=1.0, rows=2):
    """An uncapped lathed tube with a bulged middle. Caps are omitted deliberately: where both ends are
    covered by something else, capping spends triangles on faces nothing can see."""
    base = len(b.verts)
    for row in range(rows + 1):
        t = row / rows
        scale = 1.0 + (bulge - 1.0) * math.sin(math.pi * t)
        for v in ring(n, r * scale, z0 + (z2 - z0) * t, factors):
            b.vert(*v)
    for row in range(rows):
        a = base + row * n
        for i in range(n):
            j = (i + 1) % n
            b.face((a + i, a + j, a + n + j, a + n + i),
                   band_uv(panel, row / rows, (row + 1) / rows), outward(n, i))


# The eight corners of a unit box and its six faces, wound so each looks outward.
_BOX_CORNERS = [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
                (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]
_BOX_FACES = [((0, 3, 2, 1), (0, 0, -1)), ((4, 5, 6, 7), (0, 0, 1)),
              ((0, 1, 5, 4), (0, -1, 0)), ((2, 3, 7, 6), (0, 1, 0)),
              ((1, 2, 6, 5), (1, 0, 0)), ((3, 0, 4, 7), (-1, 0, 0))]


def box(b, centre, size, panel, taper=None, shear=(0.0, 0.0), skip=()):
    """An axis-aligned box, optionally tapered toward +Z and sheared in X/Y with height.

    `taper` scales the top face as (sx, sy); `shear` slides it. Between them a chassis, a hood and a seat
    are all one primitive. `skip` drops faces by index (0=-Z, 1=+Z, 2=-Y, 3=+Y, 4=+X, 5=-X) where
    something else covers them.

    `panel` may be one rect for the whole box or a 6-list, one per face.
    """
    cx, cy, cz = centre
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    tx, ty = taper if taper else (1.0, 1.0)
    base = len(b.verts)
    for sx, sy, sz in _BOX_CORNERS:
        k = 1.0 if sz < 0 else 0.0
        fx = 1.0 if sz < 0 else tx
        fy = 1.0 if sz < 0 else ty
        b.vert(cx + sx * hx * fx + (0.0 if k else shear[0]),
               cy + sy * hy * fy + (0.0 if k else shear[1]), cz + sz * hz)
    for fi, (corners, out) in enumerate(_BOX_FACES):
        if fi in skip:
            continue
        p = panel[fi] if isinstance(panel, list) else panel
        b.face(tuple(base + c for c in corners), rect_uv(p), out)


def quad(b, a, bb, c, d, panel, out):
    """One free quad from four points — windshields, flat plates, anything not worth a primitive."""
    base = len(b.verts)
    for v in (a, bb, c, d):
        b.vert(*v)
    b.face((base, base + 1, base + 2, base + 3), rect_uv(panel), out)


def tube(b, path, n, r, panel, closed_ends=False):
    """A polygonal tube swept along a polyline — handlebars, A-arms, roll bars."""
    if len(path) < 2:
        return
    base = len(b.verts)
    rings = []
    for k, p in enumerate(path):
        nxt = path[min(k + 1, len(path) - 1)]
        prv = path[max(k - 1, 0)]
        dx, dy, dz = nxt[0] - prv[0], nxt[1] - prv[1], nxt[2] - prv[2]
        ln = math.hypot(dx, dy, dz) or 1.0
        dx, dy, dz = dx / ln, dy / ln, dz / ln
        ux, uy, uz = (0.0, 0.0, 1.0) if abs(dz) < 0.9 else (1.0, 0.0, 0.0)
        sx, sy, sz = uy * dz - uz * dy, uz * dx - ux * dz, ux * dy - uy * dx
        sl = math.hypot(sx, sy, sz) or 1.0
        sx, sy, sz = sx / sl, sy / sl, sz / sl
        tx, ty, tz = dy * sz - dz * sy, dz * sx - dx * sz, dx * sy - dy * sx
        rings.append([(p[0] + r * (math.cos(a) * sx + math.sin(a) * tx),
                       p[1] + r * (math.cos(a) * sy + math.sin(a) * ty),
                       p[2] + r * (math.cos(a) * sz + math.sin(a) * tz))
                      for a in (2 * math.pi * i / n for i in range(n))])
    for rg in rings:
        for v in rg:
            b.vert(*v)
    for k in range(len(rings) - 1):
        a = base + k * n
        for i in range(n):
            j = (i + 1) % n
            mid = rings[k][i]
            out = (mid[0] - path[k][0], mid[1] - path[k][1], mid[2] - path[k][2])
            b.face((a + i, a + j, a + n + j, a + n + i),
                   band_uv(panel, k / (len(rings) - 1), (k + 1) / (len(rings) - 1)), out)
    if closed_ends:
        for end, sign in ((0, -1), (len(rings) - 1, 1)):
            c = b.vert(*path[end])
            a = base + end * n
            d = (path[min(end + 1, len(path) - 1)][0] - path[max(end - 1, 0)][0],
                 path[min(end + 1, len(path) - 1)][1] - path[max(end - 1, 0)][1],
                 path[min(end + 1, len(path) - 1)][2] - path[max(end - 1, 0)][2])
            for i in range(n):
                j = (i + 1) % n
                tri = (a + i, a + j, c) if sign > 0 else (a + j, a + i, c)
                b.face(tri, (uv(panel, 0.0, 0.0), uv(panel, 1.0, 0.0), uv(panel, 0.5, 1.0)),
                       (d[0] * sign, d[1] * sign, d[2] * sign))


def _cross2(o, a, c):
    return (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0])


def triangulate(pts):
    """Ear-clip a simple CCW polygon into CCW triangles (index triples).

    A fan from point 0 is only correct for a CONVEX outline, and real prop profiles are not: a ski's top
    surface dips back down behind the upturned tip, which makes that vertex reflex and silently inverts
    two cap triangles. Inverted caps are lit ambient-only dark, so this is a shading bug, not a
    tessellation nicety — the per-face guard catches it, and this is what stops it happening.
    """
    idx = list(range(len(pts)))
    out = []
    guard = 0
    while len(idx) > 3 and guard < 10_000:
        guard += 1
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            a, c, d = pts[i0], pts[i1], pts[i2]
            if _cross2(a, c, d) <= 0:
                continue                                    # reflex corner, not an ear
            if any(_cross2(a, c, pts[m]) >= 0 and _cross2(c, d, pts[m]) >= 0
                   and _cross2(d, a, pts[m]) >= 0 for m in idx if m not in (i0, i1, i2)):
                continue                                    # another vertex sits inside the candidate
            out.append((i0, i1, i2))
            idx.pop(k)
            break
        else:
            break                                           # degenerate outline; leave the rest
    if len(idx) == 3:
        out.append(tuple(idx))
    return out


def extrude_profile(b, profile, half_width, panel_side, panel_cap, x=0.0, y=0.0, z=0.0, pad=0.04):
    """Sweep a closed 2D outline along X into a solid — the vehicle workhorse: track loops, skis,
    bodywork, anything whose SIDE view is the shape that matters.

    `profile` is a list of (y, z) points. Its winding is normalised here from the shoelace area, so an
    outline can be typed in whichever direction reads naturally instead of silently shipping the part
    inside-out — the one authoring mistake this whole library exists to make impossible.

    Side UVs run along the CUMULATIVE PERIMETER, so a tread or a scuff carries continuously around the
    outline rather than restarting at every segment. Caps are fan-triangulated from the first point,
    which assumes a roughly convex outline; a deeply concave profile wants splitting into two.
    """
    pts = list(profile)
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    if area < 0:
        pts.reverse()
    seg = [math.dist(pts[i], pts[(i + 1) % n]) for i in range(n)]
    total = sum(seg) or 1.0
    s = [0.0]
    for d in seg:
        s.append(s[-1] + d / total)

    base = len(b.verts)
    for side in (-1.0, 1.0):
        for py, pz in pts:
            b.vert(x + side * half_width, y + py, z + pz)
    left, right = base, base + n

    for i in range(n):
        j = (i + 1) % n
        dy, dz = pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]
        b.face((left + i, left + j, right + j, right + i),
               (uv(panel_side, s[i], 0.0), uv(panel_side, s[i + 1], 0.0),
                uv(panel_side, s[i + 1], 1.0), uv(panel_side, s[i], 1.0)),
               (0.0, dz, -dy))          # outward normal of a CCW edge in the (y, z) plane

    ys = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    span_y = (max(ys) - min(ys)) or 1.0
    span_z = (max(zs) - min(zs)) or 1.0
    def cap_uv(p):
        return uv(panel_cap, pad + (1 - 2 * pad) * (p[0] - min(ys)) / span_y,
                  pad + (1 - 2 * pad) * (p[1] - min(zs)) / span_z)
    for i, j, k in triangulate(pts):
        b.face((right + i, right + j, right + k),
               (cap_uv(pts[i]), cap_uv(pts[j]), cap_uv(pts[k])), (1.0, 0.0, 0.0))
        b.face((left + i, left + k, left + j),
               (cap_uv(pts[i]), cap_uv(pts[k]), cap_uv(pts[j])), (-1.0, 0.0, 0.0))


def pyramid(b, cx, cy, z, half, height, yaw, panel):
    """A four-triangle pyramid with an open base — chocolate chips, rivets, studs, spikes."""
    base = len(b.verts)
    for k in range(4):
        a = yaw + math.pi * 0.5 * k + math.pi * 0.25
        b.vert(cx + half * math.cos(a), cy + half * math.sin(a), z)
    b.vert(cx, cy, z + height)
    for k in range(4):
        a = yaw + math.pi * 0.5 * k + math.pi * 0.5   # mid-angle between base verts k and k+1
        b.face((base + k, base + (k + 1) % 4, base + 4),
               (uv(panel, 0.0, 0.0), uv(panel, 1.0, 0.0), uv(panel, 0.5, 1.0)),
               (math.cos(a), math.sin(a), 0.6))


def mirror_x(b, start_face):
    """Mirror every face from `start_face` onward across x=0.

    A mirror REVERSES orientation, so each copied face has its corner order reversed — otherwise the
    mirrored half is wound inside-out and ships ambient-only dark, the same defect that inverts a whole
    GLB when the importer's frame flip forgets to reverse indices. The UVs reverse with the corners so
    they stay paired, and each expected-facing vector has its x negated.
    """
    remap = {}
    for fi in range(start_face, len(b.faces)):
        corners, uvs, out = b.faces[fi], b.uvs[fi], b.out[fi]
        new = []
        for vi in corners:
            if vi not in remap:
                x, y, z = b.verts[vi]
                remap[vi] = b.vert(-x, y, z)
            new.append(remap[vi])
        b.face(tuple(reversed(new)), tuple(reversed(uvs)), (-out[0], out[1], out[2]))


# ---- verify and export ------------------------------------------------------------------------------

def _raw_volume6(verts, faces):
    """Six times the volume the IMPORTER will store: positions mirrored to raw cm and every triangle
    reversed, which is what `glb-import.ts` does (`-100x, -100z, 100y` and `emit(a), emit(c), emit(b)`).
    Positive is the orientation every prop on the target platform stores at."""
    raw = [(-100.0 * x, -100.0 * z, 100.0 * y) for (x, y, z) in verts]
    total = 0.0
    for f in faces:
        for k in range(1, len(f) - 1):
            # fan-triangulate to (f0, fk, fk+1), then REVERSE it — the importer emits a, c, b. The swap
            # has to happen in the indexing, not in what the locals are called.
            p, q, r = raw[f[0]], raw[f[k + 1]], raw[f[k]]
            total += (p[0] * (q[1] * r[2] - q[2] * r[1])
                      - p[1] * (q[0] * r[2] - q[2] * r[0])
                      + p[2] * (q[0] * r[1] - q[1] * r[0]))
    return total


# SSX authors material motion per ANIMATION TICK, and the tick is the 60 Hz sim rate
# (`props/textures.ts`). Recipes declare a speed in UV per SECOND because that is the unit a person can
# picture, and it is converted here — the value that reaches the GLB is the native one, so there is
# exactly one representation of a scroll on the wire and nothing has to be translated back.
SSX_TICKS_PER_SECOND = 60.0


def surface(tex, alpha=False, scroll=None, active_duration=1.0, pause_duration=0.0, lifetime=0.0,
            frames=0):
    """One extra material for `finish(surfaces=[...])`.

    `scroll` is (u, v) in UV units per SECOND, and it is what makes a surface move: Slopesmith animates
    prop materials by scrolling their UVs, the engine's own mechanism for flowing water. It rides to the app
    as glTF `extras` on the material, which is metadata the format carries natively and the GLB is
    therefore self-describing — the effect travels WITH the model instead of being re-authored against
    every placement. `active_duration` and `pause_duration` are the moving/stopped portions of one native
    cycle; `lifetime=0` leaves the node installed until its effect slot unloads.

    `frames` makes the surface a FLIPBOOK: its page is a vertical filmstrip of that many frames, and the
    importer cuts it into that many bank tiles. Every frame uses one identical layout — the whole point is
    that they differ in paint, not in shape — so UVs are authored against a single frame and address all of
    them. Declare only the count. What a flipbook does is not a property of the art: a frame list is a
    STATE list, and an SSF effect authored against the placement decides whether it cycles, pulses on a
    crossing, or just holds frame 0 while game logic indexes it.
    """
    return {
        'tex': tex,
        'alpha': alpha,
        'scroll': scroll,
        'active_duration': active_duration,
        'pause_duration': pause_duration,
        'lifetime': lifetime,
        'frames': frames,
    }


# Runtime name-table order, shared by SSF emitters and the extracted PARTICLE.SSH bank. Mirrors
# `PARTICLE_SPRITE_NAMES` in core/effects/emitter-preview.ts; index is what lands in U49.
PARTICLE_SPRITES = ('part', 'snfl', 'clod', 'spry', 'halo', 'brk1', 'brk2', 'brk3',
                    'ndl1', 'ndl2', 'swd1', 'swd2', 'swp1', 'swp2', 'cnf1', 'cnf2',
                    'blb1', 'blb2', 'str1', 'str2', 'str3', 'nois', 'strk', 'tral',
                    'ex06', 'ex07', 'ex08', 'ex09', 'lens', 'blnk', 'mip1', 'mip1',
                    'mip2', 'beam', 'fog0', 'spec', 'envr', 'exlm')


def _raw_vec(v):
    """A Blender-space DIRECTION to the raw cm frame the emitter payload is authored in.

    Blender is Z-up metres, glTF is Y-up metres, raw is Z-up centimetres and X-mirrored. Composing the
    exporter's turn with the importer's gives (-100x, +100y, +100z) — a direction only, so no
    translation and no re-centring.
    """
    return (-100.0 * v[0], 100.0 * v[1], 100.0 * v[2])


def emitter(at, aim, speed, spread=(0.0, 0.0, 0.0), gravity=-4.0, life=(2.2, 0.8),
            size=(0.55, 0.25), count=40, sprite='snfl', colors=None, emission=-1.0,
            trail=1, trail_step=0.0, blend=0, jitter=(0.0, 0.0, 0.0)):
    """One particle emitter, in metres and metres per second, for `finish(emitters=[...])`.

    This writes SSX's OWN emitter payload — the `type2Sub0` field bag of a MainType-2 effect node, the
    same shape `Effects.json` stores and `timerEmitterPreviewLaw` decodes. Carrying the native record
    rather than a private particle format means the editor's existing runtime plays it unchanged and an
    exported level can ship a real emitter, instead of something that only ever existed here.

    Arguments are the readable units; the conversion to the native ones (raw cm, cm/s, cm/s^2) happens
    here so a recipe never contains a number like `U20: 1200`.

    - `at`     where the particles are born, in the recipe's own Blender coordinates.
    - `aim`    direction they leave in; scaled by `speed`.
    - `spread` per-axis velocity spread, m/s. A particle draws +/-0.5 of each axis.
    - `gravity` a scalar (down) or a vector. The engine's own sprays run well under true gravity — a
      measured example is -3 m/s^2 — because a light particle has drag the sim does not model.
    - `life`, `size` are (centre, span) pairs; each particle draws centre +/- span/2.
    - `jitter` the box particles are born IN, so a plume leaves the whole muzzle rather than one point.
    - `emission` NEGATIVE keeps the stream alive; a positive value is a one-shot burst staggered over that
      many seconds. A plume wants the former: of the 598 emitters across the reference levels only 6 are
      negative, and they are exactly the continuous
      streams. A burst on a machine that is supposed to be running fires once as its region loads and is
      gone before a rider is anywhere near it, which reads in game as no particles at all.

    `at` is the ONE thing left in file space rather than converted here: the importer re-centres a model
    on its own bounding box, so a spawn point has to go through that same shift or it drifts off the
    muzzle. Everything else is a direction and needs no such thing.
    """
    grav = (0.0, 0.0, gravity) if isinstance(gravity, (int, float)) else gravity
    fields = {
        'U0': int(count), 'U1': int(trail), 'U2': float(emission), 'U3': 1.0,
        'U4': 100.0 * size[0], 'U5': float(life[0]), 'U6': 100.0 * size[1], 'U7': float(life[1]),
        'U8': float(trail_step),
        'U9': 0.0, 'U10': 0.0, 'U11': 0.0,          # the importer fills these from `at`
    }
    for base, vec in ((12, (jitter[0], 0.0, 0.0)), (15, (0.0, jitter[1], jitter[2]))):
        for k, value in enumerate(_raw_vec(vec)):
            fields[f'U{base + k}'] = value
    for k, value in enumerate(_raw_vec(tuple(aim[i] * speed for i in range(3)))):
        fields[f'U{18 + k}'] = value
    for axis, base in enumerate((21, 24, 27)):
        vec = [0.0, 0.0, 0.0]
        vec[axis] = spread[axis]
        for k, value in enumerate(_raw_vec(vec)):
            fields[f'U{base + k}'] = value
    for k, value in enumerate(_raw_vec(grav)):
        fields[f'U{30 + k}'] = value
    # Four colour stops, native A,R,G,B per stop. Defaults fade white out, which is what snow does.
    stops = colors or ((1.0, 1.0, 1.0, 1.0), (1.0, 1.0, 1.0, 0.85),
                       (1.0, 1.0, 1.0, 0.45), (1.0, 1.0, 1.0, 0.0))
    for stop in range(4):
        r, g, bl, a = stops[stop] if stop < len(stops) else stops[-1]
        base = 33 + stop * 4
        fields[f'U{base}'], fields[f'U{base + 1}'] = float(a), float(r)
        fields[f'U{base + 2}'], fields[f'U{base + 3}'] = float(g), float(bl)
    fields['U49'] = PARTICLE_SPRITES.index(sprite) if sprite in PARTICLE_SPRITES else int(sprite)
    fields['U50'] = int(blend)
    # `at` travels in glTF's frame, because that is the frame the rest of the file is in and the
    # importer applies one transform to the lot.
    return {'at': [at[0], at[2], -at[1]], 'fields': fields}


def _material(name, index, spec, roughness):
    """One Blender material for a surface spec, with its effect attached as glTF `extras`."""
    key = name if index == 0 else f'{name}_{index}'
    mat = bpy.data.materials.get(key) or bpy.data.materials.new(key)
    mat.use_nodes = True
    tree = mat.node_tree
    for node in [n for n in tree.nodes if n.type == 'TEX_IMAGE']:
        tree.nodes.remove(node)
    bsdf = next(n for n in tree.nodes if n.type == 'BSDF_PRINCIPLED')
    img = tree.nodes.new('ShaderNodeTexImage')
    img.image = bpy.data.images.load(spec['tex'], check_existing=True)
    img.image.reload()
    img.location = (-380, 260)
    tree.links.new(img.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = 0.0
    if spec.get('alpha'):
        # Wire the map's alpha so the exporter records alphaMode MASK rather than dropping the channel.
        # Slopesmith tests every prop material at alphaTest 0.4 (props/textures.ts:288), so a cutout
        # sprig punches through with no extra plumbing — this only has to survive the round trip.
        tree.links.new(img.outputs['Alpha'], bsdf.inputs['Alpha'])
        for attr, value in (('blend_method', 'CLIP'), ('surface_render_method', 'DITHERED')):
            try:
                setattr(mat, attr, value)
            except (AttributeError, TypeError):
                pass                   # the name moved between Blender versions; the link is what counts

    # Custom properties on the datablock become the material's glTF `extras`, which is why the export
    # below passes export_extras=True — without it they are silently dropped and the prop imports inert.
    # 'SWX_effect' is the pre-rename spelling: clearing it too keeps a re-exported prop from carrying both.
    for stale in ('OpenSlope_effect', 'SWX_effect'):
        if stale in mat.keys():
            del mat[stale]
    effect = {}
    scroll = spec.get('scroll')
    if scroll:
        effect['uvScroll'] = {
            'mode': 0,
            'uPerTick': scroll[0] / SSX_TICKS_PER_SECOND,
            'vPerTick': scroll[1] / SSX_TICKS_PER_SECOND,
            'activeDuration': spec.get('active_duration', 1.0),
            'pauseDuration': spec.get('pause_duration', 0.0),
            'lifetime': spec.get('lifetime', 0.0),
        }
    frames = int(spec.get('frames') or 0)
    if frames >= 2:
        effect['flipbook'] = {'frames': frames}
    if effect:
        mat['OpenSlope_effect'] = json.dumps(effect, separators=(',', ':'))
    return mat


def _action_fcurves(action):
    """An action's F-curves, across the API change.

    Blender 4.4 moved actions to layers/strips/channelbags and 5.x dropped the flat `Action.fcurves`
    the recipes were written against. Both spellings are accepted here rather than pinning a version,
    because this folder is driven by whatever Blender the author happens to have installed.
    """
    flat = getattr(action, 'fcurves', None)
    if flat is not None:
        return list(flat)
    return [curve for layer in action.layers for strip in layer.strips
            for bag in strip.channelbags for curve in bag.fcurves]


def _keyframe_spin(child, axis, rps):
    """Give a spin child REAL Blender keyframes, so the declared rotation plays on the timeline.

    The GLB carries the spin as a `OpenSlope_animation` declaration, which is what Slopesmith reads — nothing
    in the pipeline needs this. It exists so `props.blend` can be scrubbed: a fan that only turns after
    it has been imported into the editor is a fan you cannot judge the rate of while authoring it, and
    the rate is the one number here that has to be chosen by eye.

    AXIS_ANGLE rotation mode because the axis is arbitrary — a barrel points where it points, and an
    Euler triple for it would be three numbers nobody can read. A CYCLES modifier repeats one revolution
    forever, so the preview does not depend on the scene's frame range.
    """
    length = math.sqrt(sum(c * c for c in axis)) or 1.0
    unit = tuple(c / length for c in axis)
    child.rotation_mode = 'AXIS_ANGLE'
    child.animation_data_clear()
    scene = bpy.context.scene
    start = scene.frame_start
    # One revolution in SCENE frames. The declaration is in seconds, so this follows the scene's fps
    # rather than the 30 fps clock the editor's clip runs on — same motion, different clock.
    span = max(1, round(scene.render.fps / abs(rps)))
    for frame, angle in ((start, 0.0), (start + span, math.copysign(2 * math.pi, rps))):
        child.rotation_axis_angle = (angle, *unit)
        child.keyframe_insert('rotation_axis_angle', index=0, frame=frame)
    for index in range(1, 4):                      # the axis itself is constant; key it once so it holds
        child.keyframe_insert('rotation_axis_angle', index=index, frame=start)
    for curve in _action_fcurves(child.animation_data.action):
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'
        curve.modifiers.new('CYCLES')
    return span


def _keyframe_swing(child, axis, amplitude_degrees, period_seconds):
    """Preview a declared pendulum on Blender's timeline; the exported GLB still carries only extras."""
    length = math.sqrt(sum(c * c for c in axis)) or 1.0
    unit = tuple(c / length for c in axis)
    child.rotation_mode = 'AXIS_ANGLE'
    child.animation_data_clear()
    scene = bpy.context.scene
    start = scene.frame_start
    span = max(4, round(scene.render.fps * period_seconds))
    amplitude = math.radians(amplitude_degrees)
    for quarter, angle in enumerate((0.0, amplitude, 0.0, -amplitude, 0.0)):
        child.rotation_axis_angle = (angle, *unit)
        child.keyframe_insert('rotation_axis_angle', index=0, frame=start + span * quarter / 4)
    for index in range(1, 4):
        child.keyframe_insert('rotation_axis_angle', index=index, frame=start)
    for curve in _action_fcurves(child.animation_data.action):
        for point in curve.keyframe_points:
            point.interpolation = 'BEZIER'
            point.handle_left_type = point.handle_right_type = 'AUTO_CLAMPED'
        curve.modifiers.new('CYCLES')
    return span


def finish(b, name, tex, glb, roughness=0.92, closed=True, alpha=False, surfaces=None, emitters=None,
           frames=0):
    """Assemble the mesh, check it, export it, and report the per-part triangle budget.

    `closed=False` for SHEET props — foliage skirts, fences, banners. An open mesh encloses no volume, so
    the raw-space volume test has nothing to measure and would reject a perfectly good tree: a cutout
    tree scores about −0.03 of its bounding box either way, which is noise, not an orientation. The
    per-face expected-facing check is exact either way and stays the authority there, and the count of
    downward-facing sheet faces is reported instead, because a foliage sheet aimed at the ground is the
    one thing that silently ships dark.
    """
    for stale in [o for o in bpy.data.objects if o.name.startswith(name)]:
        bpy.data.objects.remove(stale, do_unlink=True)
    for orphan in [m for m in bpy.data.meshes if m.users == 0]:
        bpy.data.meshes.remove(orphan)

    specs = [{'tex': tex, 'alpha': alpha, 'frames': frames}] + list(surfaces or [])
    for spec in specs:
        if not os.path.exists(spec['tex']):
            raise RuntimeError(f'atlas missing: {spec["tex"]} — run its _atlas recipe first')
    used = set(b.mats)
    if used - set(range(len(specs))):
        raise RuntimeError(f'faces are tagged for material slot(s) {sorted(used)} but only '
                           f'{len(specs)} surface(s) were given to finish()')
    # ONE material datablock per surface, shared by every mesh below — a per-mesh copy would export as a
    # second glTF material, and the importer numbers materials by identity.
    mats = [_material(name, index, spec, roughness) for index, spec in enumerate(specs)]

    def build(mesh_name, faces, origin):
        """One mesh from a subset of the accumulator's faces, re-indexed onto only the verts it uses and
        moved so `origin` is its local zero — which is what makes a spinning node's own translation the
        pivot the importer reads.

        A prop with no `spin()` is the whole accumulator and keeps its vertices EXACTLY as built, in
        creation order. Re-indexing would be equivalent geometry and a different file, which would rewrite
        every committed GLB the first time anything here changed — and the point of a deterministic build
        is that `git status props/` shows what a change actually moved.
        """
        whole = len(faces) == len(b.faces) and origin == (0.0, 0.0, 0.0)
        if whole:
            order, remap = range(len(b.verts)), {v: v for v in range(len(b.verts))}
        else:
            order, remap = [], {}
            for fi in faces:
                for v in b.faces[fi]:
                    if v not in remap:
                        remap[v] = len(order)
                        order.append(v)
        mesh = bpy.data.meshes.new(mesh_name)
        mesh.from_pydata([tuple(b.verts[v][k] - origin[k] for k in range(3)) for v in order], [],
                         [tuple(remap[v] for v in b.faces[fi]) for fi in faces])
        mesh.validate()
        layer = mesh.uv_layers.new(name='UVMap')
        for poly, fi in zip(mesh.polygons, faces):
            poly.use_smooth = False             # flat shading: the faceting IS the style
            poly.material_index = b.mats[fi]
            for slot, co in zip(poly.loop_indices, b.uvs[fi]):
                layer.data[slot].uv = co
        mesh.update()
        for mat in mats:
            mesh.materials.append(mat)
        inward = [fi for poly, fi in zip(mesh.polygons, faces) if poly.normal.dot(b.out[fi]) <= 0.0]
        if inward:
            raise RuntimeError(f'{len(inward)} face(s) wound against their expected facing '
                               f'(they would ship ambient-only dark): {inward[:12]}')
        return mesh

    # The static body first, then one child per declared spin. Grouping by `face_spin` rather than by
    # part keeps the split exactly where the recipe put it.
    static = [i for i, s in enumerate(b.face_spin) if s < 0]
    if not static:
        raise RuntimeError('every face is inside a rotation — a prop needs a body to bolt the moving part to')
    mesh = build(name, static, (0.0, 0.0, 0.0))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    # Emitters ride as OBJECT custom properties, which the exporter writes to the node's glTF `extras`.
    # Node rather than material because an emitter is a POINT, not a surface property — and the importer
    # already walks the nodes it collects meshes from, so nothing new has to traverse the file.
    for stale in ('OpenSlope_emitters', 'SWX_emitters'):   # the second is the pre-rename spelling
        if stale in obj.keys():
            del obj[stale]
    if emitters:
        obj['OpenSlope_emitters'] = json.dumps(list(emitters), separators=(',', ':'))

    spun = []
    for ordinal, spin in enumerate(b.spins):
        faces = [i for i, s in enumerate(b.face_spin) if s == ordinal]
        if not faces:
            raise RuntimeError(f'spin {ordinal} has no faces — put geometry inside its `with b.spin(...)`')
        child = bpy.data.objects.new(f'{name}_spin{ordinal}', build(f'{name}_spin{ordinal}', faces,
                                                                   spin['pivot']))
        bpy.context.scene.collection.objects.link(child)
        parent = spun[spin['parent']] if spin['parent'] >= 0 else obj
        child.parent = parent
        if spin['parent'] >= 0:
            pp = b.spins[spin['parent']]['pivot']
            child.location = tuple(spin['pivot'][i] - pp[i] for i in range(3))
        else:
            child.location = spin['pivot']
        # The AXIS goes to glTF space here, the way `emitter()` converts its own vectors; the node's
        # translation is converted by the exporter, so only this one needs doing by hand.
        a = spin['axis']
        axis = [a[0], a[2], -a[1]]
        declaration = ({'spin': {'axis': axis, 'revsPerSecond': spin['rps']}}
                       if spin['kind'] == 'spin' else
                       {'swing': {'axis': axis, 'amplitudeDegrees': spin['amplitude'],
                                  'periodSeconds': spin['period']}})
        child['OpenSlope_animation'] = json.dumps(declaration, separators=(',', ':'))
        spun.append(child)

    v6 = _raw_volume6(b.verts, b.faces)
    if closed:
        if v6 <= 0.0:
            raise RuntimeError(f'raw-space volume is {v6 / 6:,.0f} — the stored winding would be '
                               'inside-out. A solid prop encloses a POSITIVE raw volume.')
        verdict = f'raw volume {v6 / 6:+,.0f} cm^3'
    else:
        down = sum(1 for m in [mesh] + [c.data for c in spun]
                   for p in m.polygons if p.normal.z < -1e-6)
        verdict = (f'open sheet, volume not judged ({v6 / 6:+,.0f} cm^3 is noise); '
                   f'{down} face(s) point down')

    if b.parts:
        width = max(len(p[0]) for p in b.parts)
        print(f'  {"part".ljust(width)}   tris')
        for pname, lo, hi in b.parts:
            print(f'  {pname.ljust(width)}  {sum(len(f) - 2 for f in b.faces[lo:hi]):5d}')
    verts = len(mesh.vertices) + sum(len(c.data.vertices) for c in spun)
    print(f'{name}: {verts} verts, {b.tris()} tris, {len(b.faces)} faces, {verdict}, 0 inward')
    for o in bpy.context.selected_objects:
        o.select_set(False)
    obj.select_set(True)
    for child in spun:
        child.select_set(True)      # use_selection drops an unselected child, clip and all
    bpy.context.view_layer.objects.active = obj
    os.makedirs(os.path.dirname(glb), exist_ok=True)
    # export_extras carries each material's OpenSlope_effect custom property into glTF `extras`. It defaults
    # OFF, and with it off a scrolling surface exports as an ordinary static one — the prop looks right
    # and simply never moves, which is the kind of failure nothing reports.
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True,
                              export_extras=True)
    print(f'exported {glb}')

    # The preview animation goes on AFTER the export, and that ordering is the whole of it: the exporter
    # writes each node's transform as evaluated at the current frame, so a spin child keyframed first
    # exports rotated by however far into its turn the scene happened to be sitting — geometry baked
    # crooked by a preview that was never meant to leave Blender.
    for ordinal, (spin, child) in enumerate(zip(b.spins, spun)):
        parent = f', child of spin {spin["parent"]}' if spin['parent'] >= 0 else ''
        if spin['kind'] == 'spin':
            frames = _keyframe_spin(child, spin['axis'], spin['rps'])
            motion = f'{spin["rps"]:+.2f} rev/s; {frames} scene frames per turn'
        else:
            frames = _keyframe_swing(child, spin['axis'], spin['amplitude'], spin['period'])
            motion = (f'+/-{abs(spin["amplitude"]):.1f} deg / {spin["period"]:.2f}s; '
                      f'{frames} scene frames per cycle')
        print(f'  {spin["kind"]} {ordinal}: {len(child.data.polygons)} face(s) at {spin["pivot"]} '
              f'about {spin["axis"]}, {motion} ({parent.lstrip(", ") or "root"})')
    return obj


# (pitch, yaw) in degrees. NEGATIVE pitch means the camera is ABOVE the prop looking down, which is
# the convention `set_view` has always used — so 'top' really is the top.
VIEWS = {'side': (0.0, 90.0), 'front': (0.0, 0.0), 'rear': (0.0, 180.0),
         'quarter': (-26.0, 125.0), 'top': (-89.9, 0.0)}


def _preview_lighting(scene):
    """A sun and a world, made once and reused. The raster path renders through the material rather
    than the viewport's studio light, so a scene without these comes back black — and `--factory-startup`
    is exactly such a scene, which is what a headless preview always runs in."""
    sun = bpy.data.objects.get('_PropPreviewSun')
    if sun is None:
        sun = bpy.data.objects.new('_PropPreviewSun', bpy.data.lights.new('_PropPreviewSun', 'SUN'))
        scene.collection.objects.link(sun)
        sun.data.energy = 3.0
        sun.rotation_euler = (math.radians(52), 0.0, math.radians(38))
    elif sun.name not in scene.collection.objects:
        scene.collection.objects.link(sun)
    world = bpy.data.worlds.get('_PropPreviewWorld')
    if world is None:
        world = bpy.data.worlds.new('_PropPreviewWorld')
        world.use_nodes = True
        bg = world.node_tree.nodes['Background']
        bg.inputs[0].default_value = (0.42, 0.50, 0.62, 1.0)     # overcast sky, not a black void
        bg.inputs[1].default_value = 0.9
    scene.world = world
    return sun


def render_views(obj, shots=('side', 'quarter', 'front'), size=(720, 480), out_dir=None,
                 cutout=False):
    """Render the prop from named angles to PNGs on disk, and return their paths.

    Deliberately NOT the interactive viewport: a screenshot of it can hand back a stale frame (with
    another prop still in it, or a hidden one still drawn), which is worse than no preview at all
    because it looks like an answer. Rendering through the scene camera to a file is reproducible and
    the file either exists with the right content or does not exist.

    Every object outside the prop's hierarchy is hidden for the duration and restored after — an animated
    prop's child meshes must stay visible and contribute to the framing bounds, while unrelated props are
    all built at the origin and would otherwise simply eat the frame.

    Two paths, and which one runs is not always the caller's choice. Workbench through
    `bpy.ops.render.opengl` is fast and shows the atlas flat, but it needs a GL context and simply
    RAISES under `blender --background`; it also ignores alpha, which would draw a cutout prop as
    opaque rectangles. So EEVEE takes over whenever this is headless or `cutout=True`, and that path
    needs its own light — see `_preview_lighting`.
    """
    import mathutils
    scene = bpy.context.scene
    out_dir = out_dir or os.path.dirname(bpy.data.filepath) or os.getcwd()
    raster = cutout or bpy.app.background

    cam = bpy.data.objects.get('_PropPreviewCam')
    if cam is None:
        cam = bpy.data.objects.new('_PropPreviewCam', bpy.data.cameras.new('_PropPreviewCam'))
        scene.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_mode = 'QUATERNION'
    cam.data.angle = math.radians(35.0)

    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    # The OpenGL render path reads scene.display, NOT the viewport's shading. 'TEXTURE' colour is the
    # part that actually shows the atlas — without it the render comes back flat grey clay.
    scene.display.shading.type = 'SOLID'
    scene.display.shading.color_type = 'TEXTURE'
    scene.display.shading.light = 'STUDIO'
    scene.display.shading.show_shadows = False
    if raster:
        scene.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in {
            i.identifier for i in type(scene.render).bl_rna.properties['engine'].enum_items
        } else 'BLENDER_EEVEE'
        scene.render.film_transparent = False
        _preview_lighting(scene)

    shown = {obj, *obj.children_recursive}
    hidden = [(o, o.hide_render, o.hide_viewport) for o in bpy.data.objects if o.type == 'MESH']
    for o, _, _ in hidden:
        o.hide_render = o.hide_viewport = (o not in shown)

    corners = [o.matrix_world @ mathutils.Vector(c) for o in shown if o.type == 'MESH' for c in o.bound_box]
    # Over the corners actually collected, not over 8 — an ANIMATED prop contributes a bounding box
    # per spin child as well as one for the body, so a fixed 8 puts the centre a multiple of the way
    # out and the prop renders in a corner of the frame, or off it.
    centre = sum(corners, mathutils.Vector()) / len(corners)
    radius = max((v - centre).length for v in corners)
    distance = radius / math.tan(cam.data.angle / 2.0) * 1.12

    paths = []
    try:
        for shot in shots:
            pitch, yaw = VIEWS[shot]
            p, y = math.radians(pitch), math.radians(yaw)
            # +sin(p), so a NEGATIVE pitch aims the camera DOWN at the prop from above — the same way
            # round as `set_view`, whose 90+pitch euler has always meant that. Negated, every named
            # view renders from underneath and 'top' hands back the bottom of the prop, which looks
            # enough like an answer to cost a build before anyone notices.
            look = mathutils.Vector((math.sin(y) * math.cos(p), -math.cos(y) * math.cos(p), math.sin(p)))
            cam.location = centre - look * distance
            cam.rotation_quaternion = look.to_track_quat('-Z', 'Y')
            path = os.path.join(out_dir, f'_preview_{shot}.png')
            scene.render.filepath = path
            if raster:
                bpy.ops.render.render(write_still=True)
            else:
                bpy.ops.render.opengl(write_still=True, view_context=False)
            paths.append(path)
    finally:
        for o, hr, hv in hidden:
            o.hide_render, o.hide_viewport = hr, hv
    return paths


def set_view(shot='quarter'):
    """Frame the selection from one named angle, in material shading.

    A vehicle is a SIDE-silhouette read, and the single three-quarter shot the cookie got away with
    hides a wrong profile completely — so look from more than one angle before calling a prop done.
    """
    import mathutils
    pitch, yaw = VIEWS[shot]
    for area in bpy.context.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        area.spaces[0].shading.type = 'MATERIAL'
        for region in area.regions:
            if region.type != 'WINDOW':
                continue
            with bpy.context.temp_override(area=area, region=region):
                area.spaces[0].region_3d.view_rotation = mathutils.Euler(
                    (math.radians(90 + pitch), 0.0, math.radians(yaw)), 'XYZ').to_quaternion()
                bpy.ops.view3d.view_selected()
    return shot
