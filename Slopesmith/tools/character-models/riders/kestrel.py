"""Kestrel - backcountry freerider: mustard anorak, baggy pants, daypack, beanie and headphones, gauntlets.

A built-in Slopesmith rider, built on rider_kit.py (shared skeleton, shapes, skinning, painting, export).
Run headless from Slopesmith/ (or open it in Blender's Scripting workspace and Run Script):
    blender -b --factory-startup --python tools/character-models/riders/kestrel.py -- \
        --paint --export public/characters/kestrel-rigged.glb
--paint bakes and paints the texture atlas from the swatches in src/kestrel/ into build/ (about a minute);
without it the maps already in build/ are reused. Then check the export with
`npx tsx tools/character-models/check.ts <file.glb>`. See README.md in this folder.
Coordinates are Blender's: metres, Z up, the rider faces -Y, the rider's left is +X.
"""
import importlib
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

PALETTE = {
    "K_Mustard": ((0.80, 0.53, 0.07), 0.85),
    "K_MustardDark": ((0.62, 0.38, 0.05), 0.85),
    "K_Teal": ((0.05, 0.27, 0.26), 0.8),
    "K_Cream": ((0.86, 0.80, 0.66), 0.9),
    "K_Charcoal": ((0.075, 0.08, 0.09), 0.85),
    "K_Patch": ((0.17, 0.19, 0.12), 0.9),
    "K_Rust": ((0.55, 0.19, 0.07), 0.7),
    "K_Sole": ((0.06, 0.045, 0.035), 0.9),
    "K_Black": ((0.015, 0.015, 0.016), 0.5),
    "K_Lens": ((0.22, 0.20, 0.78), 0.1),
    "K_Gaiter": ((0.42, 0.09, 0.06), 0.9),
    "K_Skin": ((0.55, 0.33, 0.22), 0.6),
    "K_Olive": ((0.20, 0.24, 0.10), 0.85),
}
FACE = BASE_FACE
GAITER = "mouth"    # "down": bunched on the collar; "mouth": pulled up over mouth and chin, edge under the nose

kit.begin("Kestrel", "K_", PALETTE, FACE)


# ── Parts ────────────────────────────────────────────────────────────────────────────────────────────
# z, half-width, half-depth, y-centre of the anorak's rings: boxy, slightly flared, up to a funnel collar.
TORSO_ROWS = [
    (0.800, 0.238, 0.162, 0.014), (0.826, 0.240, 0.165, 0.014), (0.870, 0.236, 0.164, 0.013),
    (0.950, 0.226, 0.159, 0.011), (1.030, 0.216, 0.152, 0.008), (1.100, 0.210, 0.148, 0.005),
    (1.170, 0.213, 0.150, 0.002), (1.240, 0.220, 0.153, 0.000), (1.300, 0.224, 0.154, 0.002),
    (1.330, 0.224, 0.153, 0.003),
    (1.380, 0.218, 0.148, 0.006), (1.425, 0.205, 0.138, 0.008), (1.462, 0.178, 0.121, 0.010),
    (1.490, 0.138, 0.100, 0.012), (1.510, 0.098, 0.084, 0.012), (1.535, 0.080, 0.075, 0.010),
]


def torso():
    # 0 mustard, 1 teal, 2 cream, 3 mustard-dark
    bm = torso_loft(TORSO_ROWS, [1, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 1, 1, 1, 1])
    # Kangaroo pocket: the darker front panel across the belly.
    for f in bm.faces:
        c = f.calc_center_median()
        if 0.93 < c.z < 1.10 and abs(c.x) < 0.15 and c.y < -0.06:
            f.material_index = 3
    return bm


def hood():
    """The anorak's hood, rolled down behind the neck."""
    return tag(arc_loft(105, 255, 16, 0.112, 0.118, 0.018, 1.522, 0.036, 0.030), G_HOOD)


def sleeve(side):
    return sleeve_loft(side, lambda ua, fa: [  # distance from the shoulder joint, half-width, half-depth, material
        (-0.10, 0.080, 0.084, 1), (-0.03, 0.094, 0.096, 1), (0.06, 0.094, 0.096, 1), (0.15, 0.089, 0.091, 2),
        (0.185, 0.088, 0.090, 0), (ua - 0.02, 0.080, 0.083, 0), (ua + 0.06, 0.077, 0.080, 0),
        (ua + fa - 0.06, 0.072, 0.075, 0), (ua + fa - 0.045, 0.070, 0.072, 0), (ua + fa - 0.03, 0.062, 0.064, 0),
    ])


def gauntlet(side):
    o, x, y, z, length = hand_frame(side)
    el, wr = bone_pts(f"LowerArm.{side}")
    d = (wr - el).normalized()
    stations = [(-0.080, 0.084, 0.088, 1), (-0.068, 0.087, 0.090, 1), (-0.060, 0.084, 0.087, 0),
                (-0.030, 0.074, 0.074, 0), (-0.008, 0.058, 0.052, 0), (0.004, 0.048, 0.036, 0)]
    pts = [wr + d * t for t, *_ in stations]
    bm = axis_loft(pts, [(a, b) for _, a, b, _ in stations], n=16, p=2.3, up_hint=z,
                   band_mats=[m for *_, m in stations[1:]])
    return tag(bm, G_GAUNTLET)


def pant_leg(side):
    s = 1 if side == "L" else -1
    # (z, leg centre x, half-width, half-depth). Under the coat (z > 0.80) each leg narrows and moves in so
    # its outer side stays 10-26 mm inside the coat; below the hem it is the full baggy leg.
    rows = [(1.03, 0.084, 0.106, 0.118), (0.93, 0.088, 0.104, 0.118), (0.86, 0.096, 0.105, 0.116),
            (0.80, 0.112, 0.116, 0.122), (0.74, 0.117, 0.118, 0.121), (0.68, 0.118, 0.115, 0.117),
            (0.59, 0.118, 0.111, 0.116), (0.533, 0.118, 0.112, 0.121), (0.47, 0.118, 0.107, 0.111),
            (0.38, 0.118, 0.106, 0.109), (0.31, 0.118, 0.110, 0.112), (0.275, 0.118, 0.106, 0.109),
            (0.24, 0.118, 0.114, 0.116), (0.205, 0.118, 0.110, 0.113), (0.17, 0.118, 0.119, 0.121),
            (0.135, 0.118, 0.121, 0.124), (0.122, 0.118, 0.112, 0.115)]
    bm = leg_loft(side, rows)
    for f in bm.faces:  # knee patch on the front
        c = f.calc_center_median()
        if 0.48 < c.z < 0.61 and c.y < -0.045 and abs(c.x - s * 0.118) < 0.075:
            f.material_index = 1
    return bm


def beanie():
    rows = [(1.632, 0.106, 0.118, 0.022), (1.692, 0.108, 0.120, 0.010), (1.700, 0.101, 0.112, 0.0),
            (1.738, 0.090, 0.099, 0.0), (1.768, 0.066, 0.073, 0.0), (1.786, 0.034, 0.038, 0.0)]
    rings = []
    for z, hx, hy, tilt in rows:
        pts = superellipse(22, hx, hy, 2.0)
        rings.append([Vector((px, HEAD_C.y + py, z + tilt * (-py / hy))) for px, py in pts])
    bm = loft(rings, cap_start=True, cap_end=True, band_mats=[1, 1, 0, 0, 0])
    pom = bmesh.new()
    bmesh.ops.create_icosphere(pom, subdivisions=2, radius=0.046)
    for v in pom.verts:
        v.co += Vector((0, HEAD_C.y + 0.004, 1.818))
    for f in pom.faces:
        f.material_index = 2
    return merge(tag(bm, G_BEANIE), tag(sphere_uvs(pom, Vector((0, HEAD_C.y + 0.004, 1.818))), G_POM))


def headphones():
    import math
    parts = []
    for s in (1, -1):
        stations = [(0.096, 0.040, 0.044, 0), (0.106, 0.046, 0.050, 0), (0.112, 0.050, 0.054, 1),
                    (0.128, 0.049, 0.053, 1), (0.136, 0.040, 0.044, 2)]
        pts = [Vector((s * x, HEAD_C.y + 0.006, 1.600)) for x, *_ in stations]
        parts.append(tag(axis_loft(pts, [(a, b) for _, a, b, _ in stations], n=16, p=2.4,
                                   up_hint=Vector((0, 0, 1)), band_mats=[m for *_, m in stations[1:]]), G_CUP))
    # Headband: over the crown, behind the pom, from cup to cup.
    pts = []
    for i in range(17):
        th = math.radians(-90 + 180 * i / 16)
        pts.append(Vector((0.128 * math.sin(th), HEAD_C.y + 0.036, 1.612 + 0.178 * math.cos(th))))
    parts.append(tag(axis_loft(pts, [(0.016, 0.006)] * len(pts), n=8, p=3.0, up_hint=Vector((0, -1, 0)),
                               band_mats=[0] * (len(pts) - 1)), G_BAND))
    return merge(*parts)


def pack():
    rows = [(1.05, 0.120, 0.050), (1.09, 0.140, 0.062), (1.30, 0.142, 0.064), (1.38, 0.130, 0.060),
            (1.41, 0.100, 0.048), (1.422, 0.060, 0.030)]
    rings = [ring(Vector((0, 0.212, z)), Vector((1, 0, 0)), Vector((0, 1, 0)), superellipse(16, hx, hy, 3.2))
             for z, hx, hy in rows]
    return tag(loft(rings, band_mats=[0, 0, 0, 0, 0]), G_PACK)


def gaiter():
    if GAITER == "down":
        return gaiter_down()
    return gaiter_up(TORSO_ROWS, FACE)


def build():
    clear_previous()
    hood_bm = hood()
    for f in hood_bm.faces:
        f.material_index = 1
    jacket = obj_from_bm("K_Jacket", merge(torso(), sleeve("L"), sleeve("R"), hood_bm),
                         ["K_Mustard", "K_Teal", "K_Cream", "K_MustardDark"])
    skin(jacket, ["Hips", "Spine", "Chest", "Neck", "Clavicle.L", "Clavicle.R", "UpperArm.L", "UpperArm.R",
                  "LowerArm.L", "LowerArm.R"], sharp=6.0)
    blend_hem(jacket)
    for side in ("L", "R"):
        add_gloves(side, ["K_Cream"])
        gt = obj_from_bm(f"K_Gauntlet.{side}", gauntlet(side), ["K_Teal", "K_Cream"])
        skin(gt, [f"LowerArm.{side}", f"Hand.{side}"], sharp=8.0, top=2)
        leg = obj_from_bm(f"K_Pants.{side}", pant_leg(side), ["K_Charcoal", "K_Patch"])
        skin(leg, ["Hips", f"Pelvis.{side}", f"UpperLeg.{side}", f"LowerLeg.{side}"], sharp=7.0)
        # The top of the leg is hidden under the coat: keep it with the pelvis so a crouching thigh does not
        # swing it out through the coat's sides; it hands over to the thigh by the time it reaches the hem.
        blend_toward(leg, lambda co, side=side: f"Pelvis.{side}", 0.78, 0.95, 0.85)
        add_boot(side, ["K_Rust", "K_Sole", "K_Black", "K_Cream"])
    add_head(FACE)
    add_gaiter(gaiter(), GAITER)
    hat = obj_from_bm("K_Beanie", beanie(), ["K_Cream", "K_Mustard", "K_Rust"])
    skin(hat, None, rigid="Head")
    gog = obj_from_bm("K_Goggles", goggles(), ["K_Black", "K_Lens"])
    skin(gog, None, rigid="Head")
    hp = obj_from_bm("K_Headphones", headphones(), ["K_Black", "K_Charcoal", "K_Teal"])
    skin(hp, None, rigid="Head")
    p = obj_from_bm("K_Pack", merge(pack(), straps(jacket)), ["K_Olive"])
    skin(p, None, rigid="Chest")
    return stats(join_and_pack())


# ── Painting ─────────────────────────────────────────────────────────────────────────────────────────
# Each painter takes the kit Canvas `c`; see rider_kit.Canvas for what it holds.
def paint_anorak(c):
    import numpy as np
    u, v, xm, ym, m = c.u, c.v, c.xm, c.ym, c.m
    h, detail, col = c.h, c.detail, c.col
    n_fine, n_mid, n_low = c.n_fine, c.n_mid, c.n_low
    tau = TAU
    jt = m(G_TORSO, G_SLEEVE_L, G_SLEEVE_R, G_HOOD)
    h += np.where(jt, 0.0007 * tile_field(c.sw("nylon_wrinkles"), xm, ym, 0.95), 0)
    detail += np.where(jt, 0.05 * n_fine + 0.04 * tile_field(c.sw("cordura"), xm, ym, 0.08), 0)
    t = m(G_TORSO)
    drape = smooth(0.10, 0.20, v) * (1 - smooth(0.40, 0.48, v))
    h += np.where(t, 0.0022 * drape * np.sin(tau * xm / 0.12 + 2.2 * n_low), 0)
    h += np.where(t, 0.0020 * np.exp(-v / 0.035) * np.sin(tau * xm / 0.022 + 1.5 * n_mid), 0)   # drawcord
    side = np.minimum(np.abs(u - 0.0), np.minimum(np.abs(u - 0.5), np.abs(u - 1.0)))
    pit = bump(v, 0.60, 0.07) * np.exp(-(side / 0.05) ** 2)
    h += np.where(t, 0.0022 * pit * np.sin(tau * (ym / 0.045 + xm / 0.07) + n_mid), 0)
    for sid, gid in ((1, G_SLEEVE_L), (-1, G_SLEEVE_R)):
        sl = m(gid)
        crook = 0.55 + 0.45 * np.cos(tau * u)                         # u = 0 faces forward: the elbow crook
        elbow = bump(v, 0.42, 0.075) * crook
        h += np.where(sl, 0.0026 * elbow * np.sin(tau * (v - 0.42) / 0.03 + 2.5 * n_mid), 0)
        bunch = bump(v, 0.56, 0.045)
        h += np.where(sl, 0.0024 * bunch * np.sin(tau * v / 0.02 + 3.0 * n_mid), 0)
        twist = bump(v, 0.16, 0.07) * np.exp(-((u - 0.25) / 0.12) ** 2)
        h += np.where(sl, 0.0018 * twist * np.sin(tau * (ym / 0.05 + xm / 0.09)), 0)
    hd = m(G_HOOD)
    h += np.where(hd, 0.0028 * np.sin(tau * v / 0.038 + 2.0 * n_mid), 0)
    # Half zip down the front of the yoke (u = 0.75 is the front centre).
    zip_band = t & (np.abs(u - 0.75) * 1.25 < 0.006) & (v > 0.585)
    teeth = (np.sin(tau * ym / 0.004) > 0)
    col[zip_band] = np.where(teeth[zip_band, None], (0.05, 0.05, 0.055), (0.11, 0.11, 0.12))
    h[zip_band] += 0.0008
    pull = t & (np.abs(u - 0.75) * 1.25 < 0.010) & (np.abs(v - 0.70) < 0.016)
    col[pull] = (0.55, 0.55, 0.57)
    # Chest emblem on the rider's left (+X), facing front.
    emblem = emblem_mask(c.src("emblem.png"))
    chest = decal(emblem, c.px - 0.105, c.pz - 1.225, 0.14) * (t & (c.ny < -0.25))
    c.col = col * (1 - chest[..., None]) + np.array(PALETTE["K_Teal"][0]) * chest[..., None]


def paint_pants(c):
    import numpy as np
    v, xm, ym, m = c.v, c.xm, c.ym, c.m
    h, detail, col = c.h, c.detail, c.col
    n_fine, n_mid, n_low = c.n_fine, c.n_mid, c.n_low
    tau = TAU
    pt = m(G_PANTS)
    h += np.where(pt, 0.0009 * tile_field(c.sw("canvas_folds"), xm, ym, 1.0)
                  + 0.0004 * tile_field(c.sw("twill"), xm, ym, 0.6), 0)
    detail += np.where(pt, 0.06 * n_fine + 0.05 * n_mid, 0)
    knee = bump(v, 0.50, 0.07)
    back = np.clip(c.ny, 0, 1)
    h += np.where(pt, 0.0028 * knee * (0.35 + back) * np.sin(tau * (v - 0.5) / 0.028 + 2.2 * n_mid), 0)
    stack = smooth(0.70, 0.82, v)
    h += np.where(pt, 0.0034 * stack * np.sin(tau * v / 0.03 + 2.6 * n_mid + 1.3 * n_low), 0)
    inner = np.clip(-c.nx * np.sign(c.px), 0, 1)
    thigh = bump(v, 0.17, 0.10) * inner
    h += np.where(pt, 0.0022 * thigh * np.sin(tau * (ym / 0.08 + xm / 0.06)), 0)
    # Cargo pocket on the outer thigh: a stitched panel with a flap.
    outer = np.clip(c.nx * np.sign(c.px), 0, 1)
    pocket = pt & (outer > 0.75) & (np.abs(v - 0.34) < 0.075) & (np.abs(c.py) < 0.06)
    flap = pocket & (v < 0.30)
    col[pocket] *= 0.92
    col[flap] *= 0.86
    h[pocket] += 0.0012
    h[flap] += 0.0010


def paint_hands(c):
    """Insulated gloves with a leather grip palm; gauntlet cuffs with a strap."""
    import numpy as np
    u, v, xm, ym, m = c.u, c.v, c.xm, c.ym, c.m
    h, detail, col = c.h, c.detail, c.col
    n_fine, n_mid = c.n_fine, c.n_mid
    tau = TAU
    gl = m(G_GLOVE)
    detail += np.where(gl, 0.10 * n_fine + 0.06 * n_mid, 0)
    h += np.where(gl, 0.0005 * n_mid, 0)
    for side_sign, side in ((1, "L"), (-1, "R")):
        pn = palm_normal(side)
        facing = c.nx * pn.x + c.ny * pn.y + c.nz * pn.z
        hand = gl & (np.sign(c.px) == side_sign)
        palm_side = hand & (facing > 0.38)
        grip = 0.5 + 0.5 * np.sign(np.sin(tau * xm / 0.006) * np.sin(tau * ym / 0.006))
        col[palm_side] = np.array((0.24, 0.13, 0.07)) * (0.85 + 0.25 * grip[palm_side, None])
        h[palm_side] += 0.0004 * grip[palm_side]
        seam_band = hand & (facing > 0.30) & (facing <= 0.38)
        col[seam_band] *= 0.55
    gt = m(G_GAUNTLET)
    detail += np.where(gt, 0.05 * n_fine + 0.04 * tile_field(c.sw("cordura"), xm, ym, 0.08), 0)
    h += np.where(gt, 0.0016 * bump(v, 0.075, 0.02) * np.sin(tau * v / 0.014 + 2 * n_mid), 0)
    strap = gt & (np.abs(v - 0.045) < 0.009)
    col[strap] = (0.03, 0.03, 0.035)
    h[strap] += 0.0012
    tab = strap & (np.abs(u - 0.0) < 0.06)
    col[tab] = PALETTE["K_Mustard"][0]


def paint_gaiter_k(c):
    paint_gaiter(c, PALETTE["K_Cream"][0])


def paint_beanie(c):
    import numpy as np
    u, v, xm, ym, m = c.u, c.v, c.xm, c.ym, c.m
    bn = m(G_BEANIE)
    knit = tile_field(c.sw("knit"), xm, ym, 0.16)
    c.detail += np.where(bn, 0.16 * knit, 0)
    c.h += np.where(bn, 0.0010 * knit, 0)
    label = bn & (np.abs(u - 0.75) * 0.7 < 0.017) & (np.abs(v - 0.035) < 0.014)
    c.col[label] = PALETTE["K_Teal"][0]
    pm = m(G_POM)
    yarn = fbm(xm * 700, ym * 700, 3, 9.0)
    c.detail += np.where(pm, 0.25 * yarn, 0)
    c.h += np.where(pm, 0.0012 * yarn, 0)


def paint_boots_k(c):
    paint_boots(c, "K_Cream", PALETTE["K_Cream"][0])


def paint_head_gear(c):
    import numpy as np
    paint_goggles(c, (0.85, 0.30, 0.05), (0.20, 0.16, 0.85), PALETTE["K_Teal"][0], PALETTE["K_Mustard"][0],
                  PALETTE["K_Cream"][0])
    cp = c.m(G_CUP)
    capside = cp & (np.abs(c.nx) > 0.7)
    emblem = emblem_mask(c.src("emblem.png"))
    logo = decal(emblem, -np.sign(c.px) * (c.py - (HEAD_C.y + 0.006)), c.pz - 1.600, 0.07) * capside
    c.col = c.col * (1 - logo[..., None]) + np.array(PALETTE["K_Mustard"][0]) * logo[..., None]


def paint_pack(c):
    import numpy as np
    m, xm, ym, px, pz = c.m, c.xm, c.ym, c.px, c.pz
    h, detail, col = c.h, c.detail, c.col
    pk = m(G_PACK)
    detail += np.where(pk, 0.10 * tile_field(c.sw("cordura"), xm, ym, 0.10) + 0.05 * c.n_mid, 0)
    backface = pk & (c.ny > 0.5)
    ax, az = -px, pz - 1.235
    rr = np.maximum(np.abs(ax) - 0.085, 0) ** 2 + np.maximum(np.abs(az) - 0.12, 0) ** 2
    zip_ring = backface & (np.abs(np.sqrt(rr) - 0.02) < 0.004)
    col[zip_ring] = (0.03, 0.03, 0.03)
    for zc in (1.12, 1.33):
        band = pk & (np.abs(pz - zc) < 0.011)
        col[band] = (0.025, 0.025, 0.03)
        h[band] += 0.0012
    emblem = emblem_mask(c.src("emblem.png"))
    pack_logo = decal(emblem, ax, az, 0.15) * backface
    col = col * (1 - pack_logo[..., None]) + np.array(PALETTE["K_Cream"][0]) * pack_logo[..., None]
    ps = m(G_PACKSTRAP)
    col[ps] = (0.03, 0.03, 0.035)
    detail += np.where(ps, 0.18 * np.sin(TAU * xm / 0.004), 0)
    buckle = ps & (np.abs(pz - 1.25) < 0.014)
    col[buckle] = (0.35, 0.36, 0.38)
    h[buckle] += 0.002
    c.col = col


def paint_face_k(c):
    paint_face(c, FACE, PALETTE["K_Skin"][0])


PAINTERS = [paint_anorak, paint_pants, paint_hands, paint_gaiter_k, paint_beanie, paint_boots_k, paint_head_gear,
            paint_pack, paint_face_k]

result = run(build, PAINTERS, hem_garments=(G_TORSO, G_SLEEVE_L, G_SLEEVE_R, G_PANTS, G_PACK, G_GAUNTLET),
             stitch=PALETTE["K_Cream"][0])
