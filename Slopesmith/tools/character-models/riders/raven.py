"""Raven - the Halloween skeleton: a fitted black snowsuit printed with a glow-in-the-dark skeleton, finger
bones on the gloves that curl with the hands, foot bones on the boots, a skull balaclava under green goggles.

A built-in Slopesmith rider, built on rider_kit.py (shared skeleton, shapes, skinning, painting, export).
Run headless from Slopesmith/ (or open it in Blender's Scripting workspace and Run Script):
    blender -b --factory-startup --python tools/character-models/riders/raven.py -- \
        --paint --export public/characters/raven-rigged.glb
--paint bakes and paints the atlas, including the glow map, into build/ (the fabric swatches come from
src/kestrel/). Then check the export with `npx tsx tools/character-models/check.ts <file.glb>`.
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

PALETTE = {
    "V_Black": ((0.022, 0.022, 0.025), 0.6),
    "V_Rib": ((0.032, 0.032, 0.036), 0.85),
    "V_Glove": ((0.028, 0.028, 0.03), 0.7),
    "V_Skin": ((0.024, 0.024, 0.027), 0.8),     # the head is a black knit balaclava
    "V_Boot": ((0.03, 0.03, 0.034), 0.7),
    "V_Sole": ((0.035, 0.032, 0.03), 0.9),
    "V_Lace": ((0.025, 0.025, 0.028), 0.8),
    "V_Lens": ((0.10, 0.45, 0.16), 0.1),
}
ORANGE = (0.85, 0.24, 0.02)
BONE = (0.60, 0.63, 0.56)          # the print's colour; it also glows
GLOW = (0.20, 0.50, 0.27)          # emitted on top of the lighting: pale green, like glow-in-the-dark ink

FACE = dict(BASE_FACE)             # a balaclava over a slighter nose, so the printed nose cavity reads
FACE.update({
    "bridge": ((0.0, 0.092, 0.004), (0.0, 0.112, -0.030), 0.0058, 0.0085),
    "tip": ((0.0, 0.113, -0.035), 0.0110),
    "ala": ((0.0130, 0.100, -0.042), (0.0085, 0.0085, 0.0068)),
})

kit.begin("Raven", "V_", PALETTE, FACE)


# ── Parts ────────────────────────────────────────────────────────────────────────────────────────────
# A fitted suit: a slim top over slim legs (one black, so it reads as a onesie), a low crew collar so the
# balaclava's neck shows, ribbed hem, cuffs and collar.
TORSO_ROWS = [
    (0.860, 0.205, 0.142, 0.012), (0.885, 0.204, 0.141, 0.012), (0.950, 0.196, 0.137, 0.010),
    (1.030, 0.190, 0.133, 0.006), (1.110, 0.189, 0.132, 0.003), (1.190, 0.196, 0.136, 0.001),
    (1.270, 0.205, 0.141, 0.002), (1.330, 0.207, 0.140, 0.004), (1.385, 0.200, 0.135, 0.006),
    (1.425, 0.184, 0.126, 0.008), (1.455, 0.158, 0.112, 0.010), (1.478, 0.118, 0.094, 0.011),
    (1.495, 0.088, 0.082, 0.011), (1.508, 0.080, 0.078, 0.010),
]
TORSO_BANDS = [1] + [0] * 11 + [1]


def sleeve(side):
    return sleeve_loft(side, lambda ua, fa: [
        (-0.10, 0.074, 0.077, 0), (-0.03, 0.086, 0.088, 0), (0.06, 0.086, 0.088, 0), (0.15, 0.081, 0.083, 0),
        (ua - 0.02, 0.075, 0.077, 0), (ua + 0.06, 0.072, 0.074, 0), (ua + fa - 0.07, 0.066, 0.068, 0),
        (ua + fa - 0.045, 0.062, 0.064, 0), (ua + fa - 0.035, 0.060, 0.062, 1), (ua + fa + 0.004, 0.057, 0.059, 1),
    ])


def pant_leg(side):
    # (z, leg centre x, half-width, half-depth): slim, inside the top above its hem, roomy over the boots.
    rows = [(1.03, 0.080, 0.094, 0.104), (0.93, 0.088, 0.092, 0.102), (0.86, 0.096, 0.090, 0.099),
            (0.80, 0.102, 0.089, 0.097), (0.745, 0.108, 0.092, 0.100), (0.68, 0.112, 0.094, 0.100),
            (0.59, 0.113, 0.091, 0.097), (0.533, 0.114, 0.092, 0.099), (0.47, 0.114, 0.088, 0.093),
            (0.38, 0.113, 0.088, 0.092), (0.31, 0.112, 0.091, 0.095), (0.24, 0.111, 0.097, 0.101),
            (0.17, 0.110, 0.101, 0.106), (0.135, 0.110, 0.102, 0.107), (0.122, 0.110, 0.097, 0.102)]
    return leg_loft(side, rows)


# The glove: a ribbed cuff (slot 1) under the sleeve, then the palm (slot 0).
GLOVE_STATIONS = [(-0.062, 0.049, 0.043), (-0.036, 0.049, 0.042), (-0.016, 0.044, 0.031)] + PALM_STATIONS[1:]
GLOVE_BANDS = [1, 1] + [0] * (len(GLOVE_STATIONS) - 3)


def build():
    clear_previous()
    suit = obj_from_bm("V_Suit", merge(torso_loft(TORSO_ROWS, TORSO_BANDS), sleeve("L"), sleeve("R")),
                       ["V_Black", "V_Rib"])
    skin(suit, ["Hips", "Spine", "Chest", "Neck", "Clavicle.L", "Clavicle.R", "UpperArm.L", "UpperArm.R",
                "LowerArm.L", "LowerArm.R"], sharp=6.0)
    blend_hem(suit, top=0.98, bottom=0.86, amount=0.45)
    for side in ("L", "R"):
        add_gloves(side, ["V_Glove", "V_Rib"], GLOVE_STATIONS, GLOVE_BANDS)
        leg = obj_from_bm(f"V_Pants.{side}", pant_leg(side), ["V_Black"])
        skin(leg, ["Hips", f"Pelvis.{side}", f"UpperLeg.{side}", f"LowerLeg.{side}"], sharp=7.0)
        # The top of the leg is hidden under the top: it stays with the pelvis so a crouching thigh does not
        # swing it out through the sides; it hands over to the thigh by the hem.
        blend_toward(leg, lambda co, side=side: f"Pelvis.{side}", 0.80, 0.95, 0.85)
        add_boot(side, ["V_Boot", "V_Sole", "V_Black", "V_Lace"])
    add_head(FACE)
    gog = obj_from_bm("V_Goggles", goggles(strap_closed=False), ["V_Black", "V_Lens"])
    skin(gog, None, rigid="Head")
    return stats(join_and_pack())


# ── The print: 2-D bone shapes as signed distances (metres, negative inside) ─────────────────────────
def _np():
    import numpy as np
    return np


def seg_d(X, Z, a, b):
    np = _np()
    dx, dz = b[0] - a[0], b[1] - a[1]
    t = np.clip(((X - a[0]) * dx + (Z - a[1]) * dz) / (dx * dx + dz * dz), 0, 1)
    return np.hypot(X - (a[0] + t * dx), Z - (a[1] + t * dz))


def bone_d(X, Z, a, b, w, knob):
    """A cartoon long bone: a shaft of half-width w between a and b, a pair of round knobs at each end."""
    np = _np()
    a, b = np.asarray(a, float), np.asarray(b, float)
    u = (b - a) / np.linalg.norm(b - a)
    n = np.array([-u[1], u[0]])
    d = seg_d(X, Z, a, b) - w
    for end in (a, b):
        for s in (-1.0, 1.0):
            c = end + n * s * knob * 0.7
            d = np.minimum(d, np.hypot(X - c[0], Z - c[1]) - knob)
    return d


def ell_d(X, Z, cx, cz, rx, rz, angle=0.0):
    np = _np()
    ca, sa = np.cos(np.radians(angle)), np.sin(np.radians(angle))
    x, z = (X - cx) * ca + (Z - cz) * sa, -(X - cx) * sa + (Z - cz) * ca
    return (np.sqrt((x / rx) ** 2 + (z / rz) ** 2) - 1) * min(rx, rz)


def box_d(X, Z, cx, cz, hx, hz, r=0.0):
    np = _np()
    qx, qz = np.abs(X - cx) - hx + r, np.abs(Z - cz) - hz + r
    return np.hypot(np.maximum(qx, 0), np.maximum(qz, 0)) + np.minimum(np.maximum(qx, qz), 0) - r


def poly_d(X, Z, pts, r=0.0):
    """Convex polygon (anticlockwise), rounded by r: the largest edge half-plane distance, minus r."""
    np = _np()
    d = np.full(X.shape, -1.0)
    for (ax, az), (bx, bz) in zip(pts, pts[1:] + pts[:1]):
        ex, ez = bx - ax, bz - az
        ln = np.hypot(ex, ez)
        d = np.maximum(d, ((X - ax) * ez - (Z - az) * ex) / ln)
    return d - r


def curve_d(X, Z, xs, zs, w):
    np = _np()
    d = np.full(X.shape, 1.0)
    for i in range(len(xs) - 1):
        d = np.minimum(d, seg_d(X, Z, (xs[i], zs[i]), (xs[i + 1], zs[i + 1])))
    return d - w


def rib(X, Z, z0, x0, x1, slope, bend, w):
    np = _np()
    xs = np.linspace(x0, x1, 9)
    return curve_d(X, Z, xs, z0 - slope * (xs - x0) - bend * (xs - x0) ** 2, w)


def ribcage_front(X, Z):
    np = _np()
    ax = np.abs(X)
    d = seg_d(ax, Z, (0, 1.225), (0, 1.392)) - 0.011                               # sternum
    d = np.minimum(d, ell_d(ax, Z, 0.0, 1.405, 0.021, 0.016))
    for k in range(7):
        d = np.minimum(d, rib(ax, Z, 1.395 - 0.032 * k, 0.015, 0.112 + 0.009 * k, 0.30, 1.4, 0.0068 - 0.0003 * k))
    d = np.minimum(d, bone_d(ax, Z, (0.034, 1.441), (0.148, 1.452), 0.0062, 0.0078))   # collarbones
    for k in range(5):                                                               # lumbar spine
        d = np.minimum(d, box_d(ax, Z, 0.0, 1.035 + 0.030 * k, 0.016, 0.0105, 0.004))
    d = np.minimum(d, ell_d(ax, Z, 0.094, 0.975, 0.062, 0.039, -25))                 # hip wings
    d = np.minimum(d, poly_d(X, Z, [(0.0, 0.928), (0.030, 1.006), (-0.030, 1.006)], 0.006))  # sacrum between them
    ring = np.maximum(ell_d(ax, Z, 0.040, 0.908, 0.034, 0.025), -ell_d(ax, Z, 0.042, 0.907, 0.018, 0.013))
    d = np.minimum(d, box_d(ax, Z, 0.0, 0.904, 0.007, 0.014, 0.003))                # where the two halves meet
    return np.minimum(d, ring)


def ribcage_back(X, Z):
    np = _np()
    ax = np.abs(X)
    d = np.full(X.shape, 1.0)
    for k in range(17):                                                              # vertebrae
        zc = 0.995 + 0.0285 * k
        hw = 0.019 if k < 5 else 0.014
        d = np.minimum(d, box_d(ax, Z, 0.0, zc, hw, 0.0105, 0.004))
        d = np.minimum(d, box_d(ax, Z, 0.0, zc, hw + 0.013, 0.0035, 0.0015))
    for k in range(8):
        d = np.minimum(d, rib(ax, Z, 1.400 - 0.031 * k, 0.026, 0.150 + 0.004 * k, 0.10, 0.6, 0.0064))
    d = np.minimum(d, poly_d(ax, Z, [(0.066, 1.395), (0.088, 1.292), (0.150, 1.400)], 0.009))   # shoulder blades
    d = np.minimum(d, poly_d(ax, Z, [(0.0, 0.888), (0.034, 0.975), (-0.034, 0.975)], 0.006))     # sacrum
    return np.minimum(d, ell_d(ax, Z, 0.086, 0.978, 0.058, 0.040, -20))


def arm_bones(X, Z, side):
    np = _np()
    s = 1 if side == "L" else -1
    sh, el = bone_pts(f"UpperArm.{side}")
    _, wr = bone_pts(f"LowerArm.{side}")
    S, E, W = (np.array([p.x, p.z + 0.012]) for p in (sh, el, wr))   # the sleeves ride 12 mm above the bones
    u1 = (E - S) / np.linalg.norm(E - S)
    u2 = (W - E) / np.linalg.norm(W - E)
    n2 = np.array([-u2[1], u2[0]])
    d = bone_d(X, Z, S + u1 * 0.040, E - u1 * 0.020, 0.0085, 0.0100)
    for off in (-0.0095, 0.0095):
        d = np.minimum(d, bone_d(X, Z, E + u2 * 0.024 + n2 * off, W - u2 * 0.014 + n2 * off, 0.0050, 0.0064))
    return d


def leg_bones(X, Z, side, front):
    np = _np()
    s = 1 if side == "L" else -1
    ax = X * s
    d = bone_d(ax, Z, (0.108, 0.912), (0.112, 0.576), 0.0095, 0.0120)               # thigh bone
    d = np.minimum(d, bone_d(ax, Z, (0.110, 0.476), (0.112, 0.205), 0.0088, 0.0110))   # shin bone
    d = np.minimum(d, bone_d(ax, Z, (0.144, 0.462), (0.141, 0.220), 0.0042, 0.0058))   # and its outer partner
    if front:
        d = np.minimum(d, ell_d(ax, Z, 0.112, 0.522, 0.017, 0.019))                  # kneecap
    return d


def foot_bones(X, Y, side):
    np = _np()
    s = 1 if side == "L" else -1
    ax = X * s - 0.11                         # across the foot, + toward the outside
    d = ell_d(ax, Y, 0.0, 0.030, 0.020, 0.016)                                        # ankle
    for k in range(5):                        # big toe on the inside
        o = k - 2
        w = 0.0050 if k == 0 else 0.0036
        d = np.minimum(d, bone_d(ax, Y, (0.0085 * o, 0.006), (0.0150 * o, -0.112), w, w + 0.0012))
        d = np.minimum(d, bone_d(ax, Y, (0.0162 * o, -0.128), (0.0172 * o, -0.176 + 0.007 * abs(o)), w - 0.0004, w + 0.0008))
    return d


def stamp(c, idx, d, glow=1.0):
    """Print bone on texels idx where the signed distance d is inside (antialiased by about a texel)."""
    np = _np()
    k = np.clip(0.5 - d / (1.2 * c.mpp), 0, 1)
    c.col[idx] = c.col[idx] * (1 - k[:, None]) + np.array(BONE) * k[:, None]
    c.emit[idx] += np.array(GLOW) * (glow * k)[:, None]
    c.h[idx] += 0.0004 * k


# ── Painters ─────────────────────────────────────────────────────────────────────────────────────────
def paint_suit(c):
    np = _np()
    m, u, v, xm, ym = c.m, c.u, c.v, c.xm, c.ym
    shell = m(G_TORSO, G_SLEEVE_L, G_SLEEVE_R, G_PANTS)
    c.h += np.where(shell, 0.0006 * tile_field(c.sw("nylon_wrinkles"), xm, ym, 0.95), 0)
    c.detail += np.where(shell, 0.05 * c.n_fine + 0.04 * c.n_mid, 0)
    rib = shell & (c.slot == c.names.index("V_Rib"))
    c.h += np.where(rib, 0.0007 * np.sin(TAU * xm / 0.004), 0)
    c.detail += np.where(rib, 0.10 * np.sin(TAU * xm / 0.004), 0)
    for gid in (G_SLEEVE_L, G_SLEEVE_R):                       # elbow creases
        sl = m(gid)
        c.h += np.where(sl, 0.0022 * bump(v, 0.42, 0.07) * (0.55 + 0.45 * np.cos(TAU * u))
                        * np.sin(TAU * (v - 0.42) / 0.03 + 2.5 * c.n_mid), 0)
    pt = m(G_PANTS)
    c.h += np.where(pt, 0.0020 * bump(v, 0.50, 0.06) * (0.3 + np.clip(c.ny, 0, 1))
                    * np.sin(TAU * (v - 0.5) / 0.024 + 2.2 * c.n_mid), 0)
    c.h += np.where(pt, 0.0016 * smooth(0.76, 0.86, v) * (0.5 + 0.7 * np.abs(c.n_low))
                    * np.sin(TAU * v / 0.03 + 2.6 * c.n_mid + 1.3 * c.n_low), 0)
    # The skeleton, front and back: ribcage, spine and pelvis on the top; arm bones; leg bones.
    for gid, fn in ((G_TORSO, None), (G_SLEEVE_L, "L"), (G_SLEEVE_R, "R")):
        for front in (True, False):
            facing = (c.ny < -0.15) if front else (c.ny > 0.15)
            idx = np.nonzero(m(gid) & facing)
            X, Z = c.px[idx], c.pz[idx]
            if fn is None:
                d = ribcage_front(X, Z) if front else ribcage_back(X, Z)
            else:
                d = arm_bones(X, Z, fn)
            stamp(c, idx, d)
    for side, sign in (("L", 1), ("R", -1)):
        for front in (True, False):
            facing = (c.ny < -0.15) if front else (c.ny > 0.15)
            idx = np.nonzero(pt & facing & (np.sign(c.px) == sign))
            stamp(c, idx, leg_bones(c.px[idx], c.pz[idx], side, front))


def paint_hands(c):
    """Black gloves, grippy palms, and the hand's bones on the back: they curl with tracked fingers."""
    np = _np()
    m, xm, ym = c.m, c.xm, c.ym
    gl = m(G_GLOVE)
    c.detail += np.where(gl, 0.08 * c.n_fine + 0.05 * c.n_mid, 0)
    rib = gl & (c.slot == c.names.index("V_Rib"))
    c.h += np.where(rib, 0.0007 * np.sin(TAU * xm / 0.004), 0)
    for side, sign in (("L", 1), ("R", -1)):
        o, hx, hy, hz, _ = (np.array(v[:]) if hasattr(v, "__len__") else v for v in hand_frame(side))
        pn = np.array(palm_normal(side)[:])
        dorsal = -pn
        hand = gl & (np.sign(c.px) == sign) & ~rib
        idx = np.nonzero(hand)
        P = np.stack([c.px[idx], c.py[idx], c.pz[idx]], -1)
        N = np.stack([c.nx[idx], c.ny[idx], c.nz[idx]], -1)
        facing = N @ pn
        grip = facing > 0.38
        sub = tuple(a[grip] for a in idx)
        dots = 0.5 + 0.5 * np.sign(np.sin(TAU * xm[sub] / 0.005) * np.sin(TAU * ym[sub] / 0.005))
        c.col[sub] = np.array((0.06, 0.06, 0.065)) * (0.8 + 0.4 * dots[:, None])
        c.h[sub] += 0.0003 * dots
        # Fingers: each glove texel belongs to its nearest finger segment; bone runs down that segment's back.
        # A texel past a knuckle belongs to its nearest finger segment; behind the knuckles it is the hand's.
        segs = []
        for digit in DIGIT_NAMES:
            j = [np.array(p[:]) for p in finger_joints(side, digit)]
            segs += [(j[k], j[k + 1], k == len(j) - 2, k == 0) for k in range(len(j) - 1)]
        best = np.full(len(P), 1.0)
        dist = np.full(len(P), 1.0)
        t_near = np.zeros(len(P))
        first_near = np.zeros(len(P), bool)
        for a, b, tip, first in segs:
            ab = b - a
            t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
            r = P - (a + t[:, None] * ab)
            rn = np.linalg.norm(r, axis=1)
            u = ab / np.linalg.norm(ab)
            dp = dorsal - np.dot(dorsal, u) * u
            dp /= np.linalg.norm(dp)
            lateral = np.abs(r @ np.cross(u, dp))
            w = 0.0030 + 0.0022 * np.clip((np.abs(t - 0.5) - 0.25) / 0.15, 0, 1)   # knobbly ends
            if tip:
                w = np.where(t > 0.5, 0.0034, w)
            inside = (t > 0.08) & ((t < 0.92) | tip) & ((r @ dp) > 0)               # gaps at the joints
            d = np.where(inside, lateral - w, 1.0)
            closer = rn < dist
            best, dist = np.where(closer, d, best), np.where(closer, rn, dist)
            t_near, first_near = np.where(closer, t, t_near), np.where(closer, first, first_near)
        on_finger = (dist < 0.020) & ~(first_near & (t_near < 0.02))
        d_f = np.where(on_finger, best, 1.0)
        # The back of the hand: metacarpals from the wrist to each knuckle, and the wrist's small bones.
        rel = P - o
        a_y, a_z = rel @ hy, rel @ hz
        back = (rel @ dorsal) > 0
        d_h = np.full(len(P), 1.0)
        for digit in ("index", "middle", "ring", "pinky"):
            k = np.array(finger_joints(side, digit)[0][:]) - o
            ky, kz = k @ hy, k @ hz
            d_h = np.minimum(d_h, bone_d(a_y, a_z, (0.018, 0.55 * kz), (ky - 0.008, kz), 0.0040, 0.0052))
        k = np.array(finger_joints(side, "thumb")[0][:]) - o
        d_h = np.minimum(d_h, bone_d(a_y, a_z, (0.014, 0.024), (k @ hy - 0.008, k @ hz - 0.004), 0.0045, 0.0056))
        for cy, cz in ((0.004, -0.014), (0.004, 0.0), (0.004, 0.014), (-0.006, -0.007), (-0.006, 0.007)):
            d_h = np.minimum(d_h, np.hypot(a_y - cy, a_z - cz) - 0.0050)
        d_h = np.where(back & ~on_finger & (a_y > -0.012), d_h, 1.0)
        stamp(c, idx, np.minimum(d_f, d_h), glow=1.25)


def paint_feet(c):
    np = _np()
    paint_boots(c, "V_Lace", (0.05, 0.05, 0.055), panel=(0.024, 0.024, 0.027))
    ft = c.m(G_FOOT)
    for side, sign in (("L", 1), ("R", -1)):
        idx = np.nonzero(ft & (c.nz > 0.30) & (np.sign(c.px) == sign))
        stamp(c, idx, foot_bones(c.px[idx], c.py[idx], side))


def paint_goggles_v(c):
    paint_goggles(c, (0.25, 0.85, 0.30), (0.03, 0.16, 0.07), ORANGE, (0.02, 0.02, 0.022), BONE)


def paint_skull(c):
    """The balaclava: black knit with a skull printed on it, all the way round, and the neck's vertebrae."""
    np = _np()
    hi = np.nonzero(c.m(G_HEAD))
    S, F, U = c.px[hi], HEAD_C.y - c.py[hi], c.pz[hi] - HEAD_C.z
    knit = tile_field(c.sw("knit"), c.xm[hi], c.ym[hi], 0.25)
    c.detail[hi] += 0.10 * knit
    c.h[hi] += 0.0004 * knit
    aS = np.abs(S)
    az = np.arctan2(aS, F)                                          # 0 at the front, pi at the back
    jaw = np.interp(az, [0.0, 0.7, 1.15, 1.6, 1.9, np.pi], [-0.126, -0.118, -0.100, -0.080, -0.045, -0.035])
    d = jaw - U                                                     # bone above the jaw line
    cut = lambda d, hole: np.maximum(d, -hole)
    d = cut(d, np.where(F > 0.05, ell_d(aS, U, 0.034, 0.018, 0.025, 0.021), 1.0))          # eye sockets
    nose = np.minimum(ell_d(S, U, 0.0062, -0.026, 0.0072, 0.0125, 18), ell_d(S, U, -0.0062, -0.026, 0.0072, 0.0125, -18))
    d = cut(d, np.where(F > 0.07, nose, 1.0))                                                 # nose cavity
    # Teeth: a band across the mouth, split into teeth and into upper and lower rows.
    mouth_u = FACE["mouth_line"][0][2]
    teeth = (aS < 0.031) & (U > -0.085) & (U < -0.056) & (F > 0.07)
    gap = np.abs(((S / 0.0058) + 0.5) % 1.0 - 0.5) * 0.0058 < 0.00055
    line = np.abs(U - mouth_u) < 0.0011
    edge = (np.abs(U + 0.0565) < 0.0011) | (np.abs(U + 0.0845) < 0.0011)
    d = np.where(teeth & (gap | line | edge) & (aS < 0.030), np.maximum(d, 0.001), d)
    sut = ((np.abs(S - 0.0018 * np.sin(U * 420)) < 0.0007) & (U > 0.07)) | \
          ((np.abs(F - 0.030 - 0.0018 * np.sin(S * 420)) < 0.0007) & (U > 0.06))
    d = np.where(sut, np.maximum(d, 0.001), d)                                                # sutures
    neck = np.full(S.shape, 1.0)
    for k in range(5):
        neck = np.minimum(neck, box_d(S, U, 0.0, -0.076 - 0.019 * k, 0.012, 0.0065, 0.003))
    d = np.minimum(d, np.where(az > 2.4, neck, 1.0))
    k = np.clip(0.5 - d / (0.8 * c.mpp), 0, 1)
    c.col[hi] = c.col[hi] * (1 - k[:, None]) + np.array(BONE) * k[:, None]
    c.emit[hi] += np.array(GLOW) * (0.8 * k)[:, None]
    c.h[hi] += 0.0003 * k


PAINTERS = [paint_suit, paint_hands, paint_feet, paint_goggles_v, paint_skull]

result = run(build, PAINTERS, hem_garments=(G_TORSO, G_SLEEVE_L, G_SLEEVE_R, G_PANTS),
             stitch=(0.16, 0.16, 0.18),
             src_dirs=[os.path.join(kit.SRC, "kestrel")])
