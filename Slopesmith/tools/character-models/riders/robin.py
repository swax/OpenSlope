"""Robin - big mountain on cold days: a huge quilted red parka with the hood up and a fur ruff, slim charcoal
pants, leather work gloves on wrist leashes, an avalanche pack with a shovel handle, a gaiter up to the nose.

A built-in Slopesmith rider, built on rider_kit.py (shared skeleton, shapes, skinning, painting, export).
Run headless from Slopesmith/ (or open it in Blender's Scripting workspace and Run Script):
    blender -b --factory-startup --python tools/character-models/riders/robin.py -- \
        --paint --export public/characters/robin-rigged.glb
--paint bakes and paints the texture atlas from src/robin/ (falling back to src/kestrel/ for the shared
swatches) into build/. Then check the export with `npx tsx tools/character-models/check.ts <file.glb>`.
Coordinates are Blender's: metres, Z up, the rider faces -Y, the rider's left is +X.
"""
import importlib
import math
import os
import sys


def _here():
    """This file's folder, also when run from Blender's text editor (which defines no __file__)."""
    if "__file__" in globals():
        return os.path.dirname(os.path.abspath(__file__))
    import bpy
    text = getattr(getattr(bpy.context, "space_data", None), "text", None)
    return os.path.dirname(bpy.path.abspath(text.filepath)) if text and text.filepath else os.getcwd()


HERE = _here()
if HERE not in sys.path:
    sys.path.insert(0, HERE)
sys.dont_write_bytecode = True     # no __pycache__ beside the sources
import rider_kit as kit  # noqa: E402
importlib.reload(kit)    # pick up kit edits when re-run inside one Blender session
from rider_kit import *  # noqa: E402,F401,F403  helpers and garment ids

import bmesh  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

PALETTE = {
    "R_Red": ((0.46, 0.035, 0.028), 0.75),
    "R_RedDark": ((0.25, 0.018, 0.016), 0.75),
    "R_Charcoal": ((0.045, 0.047, 0.052), 0.85),
    "R_Graphite": ((0.10, 0.105, 0.115), 0.85),
    "R_Fur": ((0.36, 0.29, 0.21), 0.95),
    "R_Tan": ((0.47, 0.28, 0.12), 0.7),
    "R_Cream": ((0.80, 0.76, 0.66), 0.9),
    "R_Sole": ((0.06, 0.045, 0.035), 0.9),
    "R_Black": ((0.015, 0.015, 0.016), 0.5),
    "R_Lens": ((0.85, 0.45, 0.08), 0.1),
    "R_Gaiter": ((0.085, 0.09, 0.10), 0.9),
    "R_Skin": ((0.27, 0.145, 0.085), 0.6),
    "R_Steel": ((0.42, 0.43, 0.45), 0.4),
    "R_Boot": ((0.07, 0.07, 0.08), 0.7),
}
ORANGE = (0.85, 0.28, 0.05)           # the robin's breast, on the emblems

# A broader, squarer jaw and chin and a longer, stronger nose than Kestrel's.
FACE = dict(BASE_FACE)
FACE.update({
    "jaw": ((0.0, 0.026, -0.060), (0.072, 0.082, 0.066), 2.8, 16.0),
    "chin": ((0.0, 0.090, -0.105), (0.030, 0.021, 0.021), 2.6),
    "bridge": ((0.0, 0.093, 0.004), (0.0, 0.119, -0.032), 0.0072, 0.0105),
    "tip": ((0.0, 0.120, -0.038), 0.0135),
    "ala": ((0.0155, 0.104, -0.045), (0.0100, 0.0100, 0.0080)),
    "upper_lip": ((0.0, 0.101, -0.066), (0.025, 0.0125, 0.0095)),
    "lower_lip": ((0.0, 0.098, -0.080), (0.022, 0.012, 0.009)),
    "mouth_line": ((0.0, 0.119, -0.0733), (0.021, 0.008, 0.0012)),
})
GAITER = "nose"     # "nose": up over the nose, edge just above its tip; "mouth": edge under the nose

kit.begin("Robin", "R_", PALETTE, FACE)


# ── Parka ────────────────────────────────────────────────────────────────────────────────────────────
# The body is a smooth profile (z, half-width, half-depth, y-centre); quilting pulls it in along baffle seams
# and puffs it out between them. A big storm collar stands up around the neck, cut lower under the chin.
PARKA = [(0.745, 0.262, 0.180, 0.016), (0.80, 0.262, 0.181, 0.015), (0.95, 0.254, 0.177, 0.012),
         (1.10, 0.248, 0.173, 0.006), (1.25, 0.256, 0.177, 0.002), (1.33, 0.258, 0.176, 0.004),
         (1.39, 0.250, 0.170, 0.006), (1.43, 0.234, 0.158, 0.008), (1.465, 0.206, 0.144, 0.010),
         (1.49, 0.172, 0.130, 0.012), (1.51, 0.146, 0.122, 0.012), (1.53, 0.134, 0.117, 0.011),
         (1.548, 0.130, 0.114, 0.010)]
SEAMS = [0.800, 0.885, 0.970, 1.055, 1.140, 1.225, 1.310, 1.395]     # baffle seams, bottom to top


def parka_at(z):
    import numpy as np
    zs = [r[0] for r in PARKA]
    return tuple(float(np.interp(z, zs, [r[k] for r in PARKA])) for k in (1, 2, 3))


def parka_rows():
    """(rows, band materials, front drops): hem band, baffles, then the smooth yoke and collar."""
    plan = [(0.745, -0.002, 1), (0.772, 0.0, 1)]
    for a, b in zip(SEAMS, SEAMS[1:]):
        plan += [(a, -0.005, 0), ((a + b) / 2, 0.005, 0)]
    plan += [(SEAMS[-1], -0.005, 0)]
    plan += [(z, 0.0, 2) for z in (1.43, 1.465, 1.49, 1.51, 1.53, 1.548)]
    rows = [(z, parka_at(z)[0] + d, parka_at(z)[1] + d, parka_at(z)[2]) for z, d, _ in plan]
    bands = [m for _, _, m in plan[1:]]
    drop = [0.0] * (len(rows) - 3) + [0.006, 0.020, 0.034]
    return rows, bands, drop


TORSO_ROWS, TORSO_BANDS, TORSO_DROP = parka_rows()


def parka_body():
    # 0 red, 1 dark red, 2 charcoal
    return torso_loft(TORSO_ROWS, TORSO_BANDS, n=26, front_drop=TORSO_DROP)


SLEEVE_SEAMS = [0.05, 0.13, 0.21, 0.29, 0.37, 0.45]


def sleeve(side):
    def stations(ua, fa):
        end = ua + fa
        st = [(-0.10, 0.086, 0.090, 2), (-0.03, 0.104, 0.108, 2), (0.040, 0.104, 0.108, 2)]
        base = lambda t: 0.104 - 0.030 * t / 0.5          # tapering from shoulder to cuff
        for a, b in zip(SLEEVE_SEAMS, SLEEVE_SEAMS[1:] + [0.505]):
            r = base(a) - 0.006
            st.append((a, r, r + 0.004, 0))
            r = base((a + b) / 2) + 0.002
            if b != 0.505:
                st.append(((a + b) / 2, r, r + 0.004, 0))
        st += [(0.485, base(0.485), base(0.485) + 0.003, 0), (0.505, 0.082, 0.085, 0),
               (0.515, 0.080, 0.082, 2), (end - 0.03, 0.074, 0.076, 2), (end - 0.008, 0.068, 0.070, 2),
               (end + 0.004, 0.062, 0.064, 2)]
        return st
    return sleeve_loft(side, stations)


# ── Hood and ruff ────────────────────────────────────────────────────────────────────────────────────
# The hood is a roomy shell around the head, made like the head itself (a field of a few rounded forms,
# meshed by rays from inside), then cut open at the face along a plane and sunk into the collar below.
# The fur ruff is a lumpy tube following the cut. Head frame as in the face dict (s, f, u from HEAD_C).
HOOD = {
    "crown": ((0.0, -0.045, 0.005), (0.142, 0.150, 0.138), 2.6),
    "cheeks": ((0.0, -0.012, -0.052), (0.124, 0.126, 0.092), 2.4),
    "neck": ((0.0, -0.022, -0.230), (0.0, -0.014, -0.090), 0.094, 0.104),
    "cut": (0.074, 0.15),      # the face opening: everything forward of f = a + b u is cut away
    "floor": 1.43,             # and everything below this height (inside the parka)
    "origin": (0.0, -0.02, -0.03),
    "triangles": 2400,         # before the cuts take away about a third
}


def hood_sdf(p):
    d = smin(ell_sdf(p, *HOOD["crown"]), ell_sdf(p, *HOOD["cheeks"]), 0.035)
    return smin(d, cone_sdf(p, *HOOD["neck"]), 0.05)


def hood_plane():
    """World point and normal of the face-opening plane; the normal points forward, out of the hood."""
    a, b = HOOD["cut"]
    return Vector((0, HEAD_C.y - a, HEAD_C.z)), Vector((0, -1, -b)).normalized()


def hood():
    bm = sdf_mesh(hood_sdf, HOOD["origin"], HOOD["triangles"], t_max=0.42)
    co, no = hood_plane()
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no,
                           clear_outer=True)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=Vector((0, 0, HOOD["floor"])),
                           plane_no=Vector((0, 0, -1)), clear_outer=True)
    return tag(sphere_uvs(bm, HEAD_C), G_HOOD)


def rim(samples=720, uc=-0.03):
    """The hood's face opening: where the cut plane leaves the hood's field, as world points from the
    lower left over the top to the lower right (only the part above the collar)."""
    import numpy as np
    a, b = HOOD["cut"]
    e1 = np.array([1.0, 0.0, 0.0])
    e2 = np.array([0.0, b, 1.0]) / math.hypot(b, 1.0)            # up the plane
    centre = np.array([0.0, a + b * uc, uc])
    psi = np.linspace(-0.5 * np.pi, 1.5 * np.pi, samples, endpoint=False)   # from straight down, anticlockwise
    d = np.cos(psi)[:, None] * e1 + np.sin(psi)[:, None] * e2
    r = ray_exit(lambda t: hood_sdf(centre + d * t[:, None]) < 0, samples, t_max=0.45)
    pts = head_world(centre + d * r[:, None])
    return pts, head_world(centre[None])[0]


def ruff(spacing=0.0105, n=12, z_min=1.488):
    import numpy as np
    pts, centre = rim()
    keep = np.nonzero(pts[:, 2] > z_min)[0]
    pts = pts[keep[0]: keep[-1] + 1]                           # one arc: lower left, over the top, lower right
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    count = max(8, int(s[-1] / spacing))
    ss = np.linspace(0, s[-1], count)
    path = np.stack([np.interp(ss, s, pts[:, k]) for k in range(3)], -1)
    _, no = hood_plane()
    rings = []
    for i, p in enumerate(path):
        p = Vector(p)
        tangent = Vector(path[min(i + 1, count - 1)] - path[max(i - 1, 0)]).normalized()
        out = (p - Vector(centre))
        out -= out.dot(no) * no
        out = (out - out.dot(tangent) * tangent).normalized()
        fwd = tangent.cross(out).normalized()
        if fwd.dot(no) < 0:
            fwd = -fwd
        c = p + out * 0.005 + no * 0.004
        ring_pts = []
        for j, (x, y) in enumerate(superellipse(n, 0.027, 0.022, 2.0)):
            a = TAU * j / n                                     # noise on a circle, so each ring closes smoothly
            lump = (1 + 0.20 * vnoise(ss[i] * 70.0 + 1.4 * math.cos(a), 1.4 * math.sin(a) + 11.0, 3.0)
                    + 0.09 * vnoise(ss[i] * 190.0 + 2.6 * math.cos(a), 2.6 * math.sin(a) + 5.0, 7.0))
            ring_pts.append(c + (out * x + fwd * y) * lump)
        rings.append(ring_pts)
    return tag(loft(rings, cap_start=True, cap_end=True, band_mats=[0] * (len(rings) - 1)), G_RUFF)


# ── Legs, hands, pack ────────────────────────────────────────────────────────────────────────────────
def pant_leg(side):
    s = 1 if side == "L" else -1
    # (z, leg centre x, half-width, half-depth): slim, but roomy enough over the boot shaft at the cuff.
    # Under the long coat (z > 0.745) the leg is slimmer still, so a crouching thigh keeps it inside.
    rows = [(1.03, 0.084, 0.098, 0.108), (0.93, 0.090, 0.093, 0.103), (0.86, 0.096, 0.090, 0.099),
            (0.80, 0.102, 0.088, 0.097), (0.745, 0.108, 0.092, 0.100), (0.68, 0.112, 0.094, 0.100),
            (0.59, 0.113, 0.091, 0.097), (0.533, 0.114, 0.092, 0.099), (0.47, 0.114, 0.088, 0.093),
            (0.38, 0.113, 0.088, 0.092), (0.31, 0.112, 0.091, 0.095), (0.24, 0.111, 0.097, 0.101),
            (0.17, 0.110, 0.101, 0.106), (0.135, 0.110, 0.102, 0.107), (0.122, 0.110, 0.097, 0.102)]
    bm = leg_loft(side, rows)
    for f in bm.faces:  # scuff guard on the inside of the ankle
        c = f.calc_center_median()
        if c.z < 0.25 and s * c.x < 0.085:
            f.material_index = 1
    return bm


# The glove: a knit cuff (slot 1) under the sleeve, then Kestrel's palm stations in leather (slot 0).
GLOVE_STATIONS = [(-0.062, 0.049, 0.043), (-0.036, 0.049, 0.042), (-0.016, 0.044, 0.031)] + PALM_STATIONS[1:]
GLOVE_BANDS = [1, 1] + [0] * (len(GLOVE_STATIONS) - 3)


def leash(side):
    """A wrist leash: a cord loop hanging from the pinky side of the glove cuff."""
    o, x, y, z, length = hand_frame(side)
    a = o + y * 0.010 - z * 0.044
    b = a + y * 0.026
    pts = []
    for i in range(21):
        t = i / 20
        sag = math.sin(math.pi * t) ** 0.8
        pts.append(a + (b - a) * t + Vector((0, 0, -0.075)) * sag - z * 0.012 * sag)
    return tag(axis_loft(pts, [(0.0032, 0.0026)] * len(pts), n=6, p=2.0, up_hint=Vector((0, -1, 0)),
                         band_mats=[0] * (len(pts) - 1)), G_LEASH)


def pack():
    rows = [(1.00, 0.110, 0.046), (1.04, 0.130, 0.058), (1.30, 0.135, 0.062), (1.40, 0.128, 0.058),
            (1.45, 0.104, 0.048), (1.468, 0.066, 0.030)]
    rings = [ring(Vector((0, 0.240, z)), Vector((1, 0, 0)), Vector((0, 1, 0)), superellipse(16, hx, hy, 3.2))
             for z, hx, hy in rows]
    return tag(loft(rings, band_mats=[0] * (len(rows) - 1)), G_PACK)


def shovel():
    """The shovel's shaft out of the top of the pack (slot 0) with a T-grip (slot 1)."""
    p0, p1 = Vector((-0.070, 0.252, 1.30)), Vector((-0.092, 0.262, 1.598))
    shaft = axis_loft([p0, (p0 + p1) / 2, p1], [(0.0115, 0.0115)] * 3, n=10, p=2.0, band_mats=[0, 0])
    d = (p1 - p0).normalized()
    across = Vector((1, 0, 0))
    across = (across - across.dot(d) * d).normalized()
    g0, g1 = p1 + d * 0.012 - across * 0.050, p1 + d * 0.012 + across * 0.050
    grip = axis_loft([g0, (g0 + g1) / 2, g1], [(0.0135, 0.0135)] * 3, n=10, p=2.4, band_mats=[1, 1])
    for f in grip.faces:
        f.material_index = 1
    return merge(tag(shaft, G_SHOVEL), tag(grip, G_SHOVEL))


def torus(centre, e1, e2, r1, r2, tube, n=18, m=8):
    rings = []
    for i in range(n):
        a = 2 * math.pi * i / n
        p = centre + e1 * (r1 * math.cos(a)) + e2 * (r2 * math.sin(a))
        radial = (e1 * (math.cos(a) / r1) + e2 * (math.sin(a) / r2)).normalized()
        normal = e1.cross(e2).normalized()
        rings.append(ring(p, radial, normal, superellipse(m, tube, tube, 2.0)))
    return loft(rings, cap_start=False, cap_end=False, closed=True, band_mats=[0] * n)


def airbag_handle(jacket):
    """The airbag's pull handle on the left shoulder strap, at chest height."""
    tree = BVHTree.FromObject(jacket, bpy.context.evaluated_depsgraph_get())
    hit = tree.ray_cast(Vector((0.105, -0.5, 1.30)), Vector((0, 1, 0)))[0]
    centre = hit + Vector((0, -0.022, 0))
    return tag(torus(centre, Vector((1, 0, 0)), Vector((0, 0, 1)), 0.020, 0.013, 0.0055), G_HANDLE)


def gaiter():
    if GAITER == "mouth":
        return gaiter_up(None, FACE, n=48, z_bottom=1.468, z_top=1.553, z_top_front=0.008, gathers=0.004)
    return gaiter_up(None, FACE, n=64, z_bottom=1.468, z_top=1.585, z_top_front=0.009, gathers=0.004,
                     offset=0.0045, span=True)


def build():
    clear_previous()
    jacket = obj_from_bm("R_Parka", merge(parka_body(), sleeve("L"), sleeve("R")),
                         ["R_Red", "R_RedDark", "R_Charcoal"])
    skin(jacket, ["Hips", "Spine", "Chest", "Neck", "Clavicle.L", "Clavicle.R", "UpperArm.L", "UpperArm.R",
                  "LowerArm.L", "LowerArm.R"], sharp=6.0)
    ride_hem(jacket)
    for side in ("L", "R"):
        add_gloves(side, ["R_Tan", "R_Red"], GLOVE_STATIONS, GLOVE_BANDS)
        ls = obj_from_bm(f"R_Leash.{side}", leash(side), ["R_Black"])
        skin(ls, None, rigid=f"Hand.{side}")
        leg = obj_from_bm(f"R_Pants.{side}", pant_leg(side), ["R_Charcoal", "R_Graphite"])
        skin(leg, ["Hips", f"Pelvis.{side}", f"UpperLeg.{side}", f"LowerLeg.{side}"], sharp=7.0)
        # The top of the leg is hidden under the coat: keep it with the pelvis so a crouching thigh does not
        # swing it out through the coat; it hands over to the thigh by the time it reaches the hem.
        blend_toward(leg, lambda co, side=side: f"Pelvis.{side}", 0.76, 0.95, 0.85)
        add_boot(side, ["R_Boot", "R_Sole", "R_Black", "R_Red"])
    add_head(FACE)
    add_gaiter(gaiter(), GAITER, chin_band=(1.470, 1.500), side_band=(1.490, 1.540))
    hd = obj_from_bm("R_Hood", hood(), ["R_Red"])
    skin(hd, None, rigid="Head")
    blend_toward(hd, lambda co: "Neck", 1.560, 1.480, 1.0)
    blend_toward(hd, lambda co: "Chest", 1.475, 1.435, 0.8)
    rf = obj_from_bm("R_Ruff", ruff(), ["R_Fur"])
    skin(rf, None, rigid="Head")
    blend_toward(rf, lambda co: "Neck", 1.560, 1.490, 0.8)
    gog = obj_from_bm("R_Goggles", goggles(strap_closed=False), ["R_Black", "R_Lens"])
    skin(gog, None, rigid="Head")
    p = obj_from_bm("R_Pack", merge(pack(), straps(jacket), airbag_handle(jacket)), ["R_Graphite"])
    skin(p, None, rigid="Chest")
    sv = obj_from_bm("R_Shovel", shovel(), ["R_Steel", "R_Black"])
    skin(sv, None, rigid="Chest")
    return stats(join_and_pack())


# ── Painting ─────────────────────────────────────────────────────────────────────────────────────────
def robin_emblem(c):
    """The robin emblem as two square masks from robin-src/emblem.png: the dark bird and its orange breast."""
    import numpy as np
    rgb = load_rgb(c.src("emblem.png"))
    lum = rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114
    ink = lum < 0.40
    breast = (rgb[..., 0] - rgb[..., 1] > 0.25) & (rgb[..., 0] > 0.5)
    ys, xs = np.nonzero(ink | breast)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    side = int(max(y1 - y0, x1 - x0) * 1.08)
    cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
    out = []
    for mask in (np.clip((0.50 - lum) / 0.15, 0, 1) * ink, breast.astype(np.float32)):
        sq = np.zeros((side, side), np.float32)
        for yy in range(side):
            sy = cy - side // 2 + yy
            if 0 <= sy < mask.shape[0]:
                xs0 = cx - side // 2
                row = mask[sy, max(0, xs0): xs0 + side]
                sq[yy, max(0, -xs0): max(0, -xs0) + row.shape[0]] = row
        out.append(sq)
    return out


def put_emblem(c, masks, a, b, size, where, ink, breast):
    import numpy as np
    for mask, colour in zip(masks, (ink, breast)):
        k = decal(mask, a, b, size) * where
        c.col = c.col * (1 - k[..., None]) + np.array(colour) * k[..., None]


def paint_parka(c):
    import numpy as np
    u, v, xm, ym, m = c.u, c.v, c.xm, c.ym, c.m
    px, py, pz = c.px, c.py, c.pz
    h, detail, col = c.h, c.detail, c.col
    n_fine, n_mid, n_low = c.n_fine, c.n_mid, c.n_low
    body, sl_l, sl_r = m(G_TORSO), m(G_SLEEVE_L), m(G_SLEEVE_R)
    shell = body | sl_l | sl_r
    h += np.where(shell, 0.0005 * tile_field(c.sw("nylon_wrinkles"), xm, ym, 0.95), 0)
    detail += np.where(shell, 0.035 * n_fine + 0.025 * n_mid, 0)
    # Baffles: a sewn-through seam pinches each line; the down puffs and creases toward it.
    seam_d = np.full(pz.shape, 1.0, np.float32)
    for zs in SEAMS:
        seam_d = np.minimum(seam_d, np.abs(pz - zs))
    for t in SLEEVE_SEAMS + [0.505]:
        seam_d = np.where(sl_l | sl_r, np.minimum(seam_d, np.abs(v - (t + 0.10))), seam_d)
    quilted = (body & (pz > SEAMS[0] - 0.004) & (pz < SEAMS[-1] + 0.004)) | \
              ((sl_l | sl_r) & (v > SLEEVE_SEAMS[0] + 0.096) & (v < 0.605 + 0.004))
    pinch = quilted & (seam_d < 0.0018)
    col[pinch] *= 0.50
    h[pinch] -= 0.0015
    crease = quilted & (seam_d < 0.016)
    h += np.where(crease, 0.0011 * np.exp(-seam_d / 0.006) * np.sin(TAU * xm / 0.013 + 2.5 * n_mid), 0)
    h += np.where(quilted, 0.0018 * np.sin(np.pi * np.clip(seam_d / 0.0425, 0, 1)), 0)
    # Hem band with a drawcord; elastic storm cuffs.
    hem = body & (pz < SEAMS[0])
    h += np.where(hem, 0.0016 * np.exp(-v / 0.03) * np.sin(TAU * xm / 0.02 + 1.5 * n_mid), 0)
    cuff = (sl_l | sl_r) & (v > 0.605)
    h += np.where(cuff, 0.0014 * np.sin(TAU * v / 0.009 + n_mid), 0)
    detail += np.where(m(G_TORSO, G_SLEEVE_L, G_SLEEVE_R) & (c.slot == c.names.index("R_Charcoal")),
                       0.05 * tile_field(c.sw("cordura"), xm, ym, 0.08), 0)
    # Full-length front zip under a storm flap with snaps.
    front = body & (c.ny < -0.3)
    zip_band = front & (np.abs(px) < 0.0045)
    teeth = np.sin(TAU * pz / 0.004) > 0
    col[zip_band] = np.where(teeth[zip_band, None], (0.05, 0.05, 0.055), (0.11, 0.11, 0.12))
    flap = front & (px > 0.0045) & (px < 0.030)
    h[flap] += 0.0010
    col[front & (np.abs(px - 0.030) < 0.0016)] *= 0.55
    snaps = flap & ((np.abs(px - 0.018) ** 2 + (((pz - 0.775) % 0.085) - 0.0425) ** 2) < 0.0055 ** 2)
    col[snaps] = (0.30, 0.30, 0.32)
    h[snaps] += 0.0012
    # Chest pocket zip on the left, slanting.
    t = np.clip(((px - 0.07) * 0.75 + (pz - 1.25) * 0.66) / 0.11, 0, 1)
    dist = np.hypot(px - (0.07 + 0.0825 * t), pz - (1.25 + 0.0726 * t))
    pocket = front & (dist < 0.0022) & (px > 0.06)
    col[pocket] = (0.05, 0.05, 0.055)
    h[pocket] -= 0.0008
    c.col = col
    # The robin on the outside of the left shoulder (u = 0.75 faces out on the left sleeve).
    masks = robin_emblem(c)
    perim = TAU * 0.10
    put_emblem(c, masks, -(u - 0.75) * perim, -(v - 0.25), 0.095, sl_l, (0.05, 0.05, 0.055), ORANGE)


def paint_hood(c):
    import numpy as np
    m, xm, ym = c.m, c.xm, c.ym
    px, py, pz = c.px, c.py, c.pz
    hd = m(G_HOOD)
    c.h += np.where(hd, 0.0006 * tile_field(c.sw("nylon_wrinkles"), xm, ym, 0.8)
                    + 0.0012 * np.sin(TAU * (pz / 0.05) + 2.0 * c.n_mid) * c.n_low, 0)
    c.detail += np.where(hd, 0.035 * c.n_fine, 0)
    # A centre seam over the crown and a stitched channel round the face opening (where the brim wire sits).
    centre = hd & (np.abs(px) < 0.0015) & (pz > 1.60)
    c.col[centre] *= 0.6
    c.h[centre] -= 0.001
    a, b = HOOD["cut"]
    f, u = HEAD_C.y - py, pz - HEAD_C.z
    behind = (a + b * u) - f
    dash = ((c.xx + c.yy) // 4) % 2 == 0
    for d in (0.030, 0.034):
        line = hd & (np.abs(behind - d) < 0.0009) & dash
        c.col[line] = c.col[line] * 0.5 + 0.5 * np.array((0.55, 0.52, 0.5))
    # Coyote ruff: cream underfur, brown-black guard hairs in streaks along the strands, a few silver tips.
    rf = m(G_RUFF)
    fur = tile_field(c.sw("fur"), ym, xm, 0.11)                      # strands run around the tube, outward
    streak = vnoise(ym * 260.0, xm * 22.0, 4.0)                      # streaks a few mm wide along the strands
    clump = vnoise(ym * 60.0, xm * 9.0, 6.0)
    dark = np.clip(0.45 + 0.55 * streak + 0.20 * fur + 0.30 * clump, 0, 1)
    tone = np.array((0.40, 0.31, 0.21)) * (1 - dark[..., None]) + np.array((0.065, 0.045, 0.032)) * dark[..., None]
    silver = np.clip((vnoise(ym * 220.0 + 3.0, xm * 18.0, 9.0) - 0.5) * 2.5, 0, 1)[..., None]
    tone = tone * (1 - 0.5 * silver) + np.array((0.50, 0.49, 0.46)) * 0.5 * silver
    c.col = np.where(rf[..., None], tone * (1 + 0.12 * c.n_low[..., None]), c.col)
    c.h += np.where(rf, 0.0012 * fur + 0.0018 * streak, 0)
    c.detail += np.where(rf, 0.10 * streak, 0)


def paint_pants(c):
    import numpy as np
    v, xm, ym, m = c.v, c.xm, c.ym, c.m
    h, detail, col = c.h, c.detail, c.col
    pt = m(G_PANTS)
    h += np.where(pt, 0.0008 * tile_field(c.sw("canvas_folds"), xm, ym, 1.0)
                  + 0.0004 * tile_field(c.sw("twill"), xm, ym, 0.6), 0)
    detail += np.where(pt, 0.05 * c.n_fine + 0.04 * c.n_mid, 0)
    # Articulated knees: two curved darts across the front of each knee, and a little stacking at the boot.
    knee_v = 0.51
    front = np.clip(-c.ny, 0, 1)
    for off in (-0.035, 0.035):
        bend = 0.012 * np.cos(TAU * c.u) ** 2
        dart = pt & (np.abs(v - knee_v - off - bend) < 0.0016) & (front > 0.35)
        col[dart] *= 0.6
        h[dart] -= 0.0010
    h += np.where(pt, 0.0022 * bump(v, knee_v, 0.06) * (0.3 + np.clip(c.ny, 0, 1))
                  * np.sin(TAU * (v - knee_v) / 0.022 + 2.2 * c.n_mid), 0)
    h += np.where(pt, 0.0018 * smooth(0.76, 0.86, v) * (0.5 + 0.7 * np.abs(c.n_low))
                  * np.sin(TAU * v / 0.030 + 2.6 * c.n_mid + 1.3 * c.n_low), 0)
    # Thigh vent zip down the outer leg, below the parka.
    outer = np.clip(c.nx * np.sign(c.px), 0, 1)
    vent = pt & (outer > 0.8) & (np.abs(c.py - 0.004) < 0.0035) & (c.pz > 0.54) & (c.pz < 0.74)
    col[vent] = (0.02, 0.02, 0.022)
    h[vent] += 0.0006


def paint_hands(c):
    import numpy as np
    m, xm, ym = c.m, c.xm, c.ym
    gl = m(G_GLOVE)
    leather = gl & (c.slot == c.names.index("R_Tan"))
    knit = gl & (c.slot == c.names.index("R_Red"))
    lt = tile_field(c.sw("leather"), xm, ym, 0.07)
    c.h += np.where(leather, 0.0006 * lt, 0)
    c.detail += np.where(leather, 0.12 * lt + 0.08 * c.n_mid, 0)
    c.col[leather] *= (1 + 0.18 * c.n_low[leather] - 0.10 * np.clip(c.n_mid[leather], 0, 1))[..., None]
    for side_sign, side in ((1, "L"), (-1, "R")):
        pn = palm_normal(side)
        facing = c.nx * pn.x + c.ny * pn.y + c.nz * pn.z
        hand = leather & (np.sign(c.px) == side_sign)
        palm = hand & (facing > 0.35)
        c.col[palm] *= 1.12                                     # the palm's second layer, a shade lighter
        seam = hand & (np.abs(facing - 0.30) < 0.05)
        c.col[seam] *= 0.55
        c.h[seam] -= 0.0006
    rib = tile_field(c.sw("knit"), xm, ym, 0.10)
    c.detail += np.where(knit, 0.18 * rib, 0)
    c.h += np.where(knit, 0.0008 * rib, 0)
    ls = m(G_LEASH)
    c.col[ls] = (0.02, 0.02, 0.022)
    tracer = ls & ((ym / 0.008) % 1.0 < 0.3)
    c.col[tracer] = PALETTE["R_Red"][0]


def paint_gaiter_r(c):
    if GAITER == "mouth":
        paint_gaiter(c, PALETTE["R_Red"][0], slack=(1.520, 1.548), gather_z=1.47, zig_z=1.512)
    else:
        paint_gaiter(c, PALETTE["R_Red"][0], slack=(1.535, 1.575), gather_z=1.47, zig_z=1.528)


def paint_boots_r(c):
    paint_boots(c, "R_Red", (0.55, 0.05, 0.035))


def paint_goggles_r(c):
    paint_goggles(c, (0.95, 0.62, 0.10), (0.70, 0.10, 0.05), PALETTE["R_Red"][0], PALETTE["R_Charcoal"][0],
                  PALETTE["R_Cream"][0])


def paint_pack(c):
    import numpy as np
    m, xm, ym, px, pz = c.m, c.xm, c.ym, c.px, c.pz
    h, detail, col = c.h, c.detail, c.col
    pk = m(G_PACK)
    detail += np.where(pk, 0.10 * tile_field(c.sw("cordura"), xm, ym, 0.10) + 0.05 * c.n_mid, 0)
    backface = pk & (c.ny > 0.5)
    ax, az = -px, pz - 1.22
    # The shovel compartment's U-zip and a red reflective strip near the top.
    rr = np.maximum(np.abs(ax) - 0.09, 0) ** 2 + np.maximum(np.abs(az) - 0.16, 0) ** 2
    zip_ring = backface & (np.abs(np.sqrt(rr) - 0.02) < 0.004) & (az < 0.17)
    col[zip_ring] = (0.03, 0.03, 0.03)
    stripe = pk & (np.abs(pz - 1.415) < 0.008)
    col[stripe] = PALETTE["R_Red"][0]
    for zc in (1.08, 1.34):
        band = pk & (np.abs(pz - zc) < 0.010)
        col[band] = (0.025, 0.025, 0.03)
        h[band] += 0.0012
    ps = m(G_PACKSTRAP)
    col[ps] = (0.03, 0.03, 0.035)
    detail += np.where(ps, 0.18 * np.sin(TAU * xm / 0.004), 0)
    buckle = ps & (np.abs(pz - 1.22) < 0.014)
    col[buckle] = (0.35, 0.36, 0.38)
    h[buckle] += 0.002
    col[m(G_HANDLE)] = (0.62, 0.05, 0.03)
    sv = m(G_SHOVEL)
    steel = sv & (c.slot == c.names.index("R_Steel"))
    detail += np.where(steel, 0.12 * np.sin(TAU * ym / 0.0025) * 0.5 + 0.05 * c.n_fine, 0)
    grip = sv & ~steel
    h += np.where(grip, 0.0006 * np.sin(TAU * xm / 0.006), 0)
    c.col = col
    put_emblem(c, robin_emblem(c), ax, az - 0.02, 0.15, backface, PALETTE["R_Cream"][0], ORANGE)


def paint_face_r(c):
    paint_face(c, FACE, PALETTE["R_Skin"][0], flush=0.6, flush_colour=(0.36, 0.11, 0.08), freckles=0,
               lips=((0.30, 0.13, 0.10), (0.24, 0.10, 0.08)), hair=(0.018, 0.014, 0.012),
               nostrils=(0.0066, 0.1210))


PAINTERS = [paint_parka, paint_hood, paint_pants, paint_hands, paint_gaiter_r, paint_boots_r, paint_goggles_r,
            paint_pack, paint_face_r]

result = run(build, PAINTERS, hem_garments=(G_TORSO, G_SLEEVE_L, G_SLEEVE_R, G_PANTS, G_PACK),
             stitch=(0.62, 0.60, 0.58),
             src_dirs=[os.path.join(kit.SRC, "robin"), os.path.join(kit.SRC, "kestrel")])
