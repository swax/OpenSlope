"""Rider kit: the shared half of every built-in rider in the textured family (Kestrel, Robin, Raven).

A rider is a recipe script (kestrel.py, robin.py, raven.py) that calls begin(), builds its parts with these
helpers and hands its build function and painters to run(). The kit owns what every rider must agree on: the
Slopesmith contract skeleton, loft and skinning helpers, the sculpted head and the gaiter over it, goggles,
boots, gloves, the texture bake and painting pipeline, and the glTF export. See README.md beside it.

Coordinates are Blender's: metres, Z up, the rider faces -Y, the rider's left is +X.
Recipes do `from rider_kit import *` for the helpers and garment ids, and read per-rider state (RIG, COL, NAME)
through the module (`kit.RIG`), because begin() sets it after that import.
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")       # per-rider fabric swatches and emblems: src/<name>/
BUILD = os.path.join(HERE, "build")   # painted atlases and other scratch; gitignored, the GLB embeds what it needs
TAU = 2 * math.pi

# ── Per-rider state, set by begin() ──────────────────────────────────────────────────────────────────
NAME = "Rider"          # collection, joined mesh and texture names: "Kestrel" -> kestrel-albedo.png
PREFIX = "X_"           # part and palette-material prefix: "K_"
COL = None
RIG = None
PALETTE = {}            # material name -> ((r, g, b) linear, roughness)


def begin(name, prefix, palette, face=None):
    """Start a rider: its collection, its contract rig (created once, never edited), palette and face."""
    global NAME, PREFIX, COL, RIG, PALETTE, FACE
    NAME, PREFIX, PALETTE = name, prefix, palette
    if face is not None:
        FACE = face
    COL = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if COL.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(COL)
    RIG = ensure_rig(COL)
    return RIG


# ── Rig ──────────────────────────────────────────────────────────────────────────────────────────────
# Slopesmith's contract skeleton: riderBones({ armSpread: 40, footLength: 0.18, handLength: 0.084, digits })
# from Slopesmith/tools/character-models/figure.ts, in figure space (Y up, +Z forward, +X the rider's left).
# The digits are Alpine Exo's table (tools/character-models/alpine-exo.ts), whose fist test passes against the
# runtime's fixed curl angles: a two-segment thumb based in the palm plane and three-segment fingers, named
# the Mixamo way (LeftHandIndex1...) because that is what the runtime and optical hand tracking drive.
# Every rider uses it unchanged: vary bulk and fit, never bone lengths.
# (name, parent, head, tail, roll) - roll is the world direction the bone's local +Z leans toward.
RIDER_BONES = [
    ("Hips", None, (0, 1.0364, 0), (0, 1.1764, 0), (0, 0, 1)),
    ("Spine", 'Hips', (0, 1.1764, 0), (0, 1.2284, 0), (0, 0, 1)),
    ("Chest", 'Spine', (0, 1.2284, 0), (0, 1.4704, 0), (0, 0, 1)),
    ("Neck", 'Chest', (0, 1.4704, 0), (0, 1.5454, 0), (0, 0, 1)),
    ("Head", 'Neck', (0, 1.5454, 0), (0, 1.6504, 0), (0, 0, 1)),
    ("Clavicle.L", 'Chest', (0, 1.4704, 0), (0.165, 1.3954, 0), (0, 0, 1)),
    ("UpperArm.L", 'Clavicle.L', (0.165, 1.3954, 0), (0.368249, 1.15318, 0), (0, 0, 1)),
    ("LowerArm.L", 'UpperArm.L', (0.368249, 1.15318, 0), (0.527789, 0.963045, 0), (0, 0, 1)),
    ("Hand.L", 'LowerArm.L', (0.527789, 0.963045, 0), (0.581783, 0.898697, 0), (0, 0, 1)),
    ("LeftHandThumb1", 'Hand.L', (0.549398, 0.934181, 0.054), (0.55383, 0.913002, 0.0802259), (-0.766044, -0.642788, 0)),
    ("LeftHandThumb2", 'LeftHandThumb1', (0.55383, 0.913002, 0.0802259), (0.557351, 0.896184, 0.101052), (-0.766044, -0.642788, 0)),
    ("LeftHandIndex1", 'Hand.L', (0.574863, 0.900722, 0.05), (0.594286, 0.876611, 0.0515478), (-0.766044, -0.642788, 0)),
    ("LeftHandIndex2", 'LeftHandIndex1', (0.594286, 0.876611, 0.0515478), (0.609323, 0.857944, 0.052746), (-0.766044, -0.642788, 0)),
    ("LeftHandIndex3", 'LeftHandIndex2', (0.609323, 0.857944, 0.052746), (0.621228, 0.843167, 0.0536946), (-0.766044, -0.642788, 0)),
    ("LeftHandMiddle1", 'Hand.L', (0.578077, 0.896892, 0.017), (0.599406, 0.870414, 0.017), (-0.766044, -0.642788, 0)),
    ("LeftHandMiddle2", 'LeftHandMiddle1', (0.599406, 0.870414, 0.017), (0.615717, 0.850167, 0.017), (-0.766044, -0.642788, 0)),
    ("LeftHandMiddle3", 'LeftHandMiddle2', (0.615717, 0.850167, 0.017), (0.628264, 0.834592, 0.017), (-0.766044, -0.642788, 0)),
    ("LeftHandRing1", 'Hand.L', (0.574863, 0.900722, -0.017), (0.594301, 0.876592, -0.0179294), (-0.766044, -0.642788, 0)),
    ("LeftHandRing2", 'LeftHandRing1', (0.594301, 0.876592, -0.0179294), (0.609351, 0.85791, -0.0186489), (-0.766044, -0.642788, 0)),
    ("LeftHandRing3", 'LeftHandRing2', (0.609351, 0.85791, -0.0186489), (0.621265, 0.843121, -0.0192186), (-0.766044, -0.642788, 0)),
    ("LeftHandPinky1", 'Hand.L', (0.568435, 0.908382, -0.05), (0.585332, 0.887408, -0.051885), (-0.766044, -0.642788, 0)),
    ("LeftHandPinky2", 'LeftHandPinky1', (0.585332, 0.887408, -0.051885), (0.597848, 0.871871, -0.0532813), (-0.766044, -0.642788, 0)),
    ("LeftHandPinky3", 'LeftHandPinky2', (0.597848, 0.871871, -0.0532813), (0.608487, 0.858664, -0.0544682), (-0.766044, -0.642788, 0)),
    ("Pelvis.L", 'Hips', (0, 1.0364, 0), (0.11, 0.9497, 0), (0, 0, 1)),
    ("UpperLeg.L", 'Pelvis.L', (0.11, 0.9497, 0), (0.11, 0.5332, 0), (0, 0, 1)),
    ("LowerLeg.L", 'UpperLeg.L', (0.11, 0.5332, 0), (0.11, 0.115, 0), (0, 0, 1)),
    ("Foot.L", 'LowerLeg.L', (0.11, 0.115, 0), (0.11, 0.115, 0.18), (1, 0, 0)),
    ("Clavicle.R", 'Chest', (0, 1.4704, 0), (-0.165, 1.3954, 0), (0, 0, 1)),
    ("UpperArm.R", 'Clavicle.R', (-0.165, 1.3954, 0), (-0.368249, 1.15318, 0), (0, 0, 1)),
    ("LowerArm.R", 'UpperArm.R', (-0.368249, 1.15318, 0), (-0.527789, 0.963045, 0), (0, 0, 1)),
    ("Hand.R", 'LowerArm.R', (-0.527789, 0.963045, 0), (-0.581783, 0.898697, 0), (0, 0, 1)),
    ("RightHandThumb1", 'Hand.R', (-0.552462, 0.936752, 0.054), (-0.572549, 0.928709, 0.0802259), (-0.766044, 0.642788, 0)),
    ("RightHandThumb2", 'RightHandThumb1', (-0.572549, 0.928709, 0.0802259), (-0.588501, 0.922322, 0.101052), (-0.766044, 0.642788, 0)),
    ("RightHandIndex1", 'Hand.R', (-0.580991, 0.905864, 0.05), (-0.601363, 0.882549, 0.0515478), (-0.766044, 0.642788, 0)),
    ("RightHandIndex2", 'RightHandIndex1', (-0.601363, 0.882549, 0.0515478), (-0.617135, 0.864499, 0.052746), (-0.766044, 0.642788, 0)),
    ("RightHandIndex3", 'RightHandIndex2', (-0.617135, 0.864499, 0.052746), (-0.629621, 0.850209, 0.0536946), (-0.766044, 0.642788, 0)),
    ("RightHandMiddle1", 'Hand.R', (-0.584205, 0.902034, 0.017), (-0.606576, 0.876431, 0.017), (-0.766044, 0.642788, 0)),
    ("RightHandMiddle2", 'RightHandMiddle1', (-0.606576, 0.876431, 0.017), (-0.623683, 0.856852, 0.017), (-0.766044, 0.642788, 0)),
    ("RightHandMiddle3", 'RightHandMiddle2', (-0.623683, 0.856852, 0.017), (-0.636843, 0.841791, 0.017), (-0.766044, 0.642788, 0)),
    ("RightHandRing1", 'Hand.R', (-0.580991, 0.905864, -0.017), (-0.601379, 0.882531, -0.0179294), (-0.766044, 0.642788, 0)),
    ("RightHandRing2", 'RightHandRing1', (-0.601379, 0.882531, -0.0179294), (-0.617163, 0.864466, -0.0186489), (-0.766044, 0.642788, 0)),
    ("RightHandRing3", 'RightHandRing2', (-0.617163, 0.864466, -0.0186489), (-0.629659, 0.850164, -0.0192186), (-0.766044, 0.642788, 0)),
    ("RightHandPinky1", 'Hand.R', (-0.574563, 0.913525, -0.05), (-0.592285, 0.893242, -0.051885), (-0.766044, 0.642788, 0)),
    ("RightHandPinky2", 'RightHandPinky1', (-0.592285, 0.893242, -0.051885), (-0.605413, 0.878218, -0.0532813), (-0.766044, 0.642788, 0)),
    ("RightHandPinky3", 'RightHandPinky2', (-0.605413, 0.878218, -0.0532813), (-0.616571, 0.865448, -0.0544682), (-0.766044, 0.642788, 0)),
    ("Pelvis.R", 'Hips', (0, 1.0364, 0), (-0.11, 0.9497, 0), (0, 0, 1)),
    ("UpperLeg.R", 'Pelvis.R', (-0.11, 0.9497, 0), (-0.11, 0.5332, 0), (0, 0, 1)),
    ("LowerLeg.R", 'UpperLeg.R', (-0.11, 0.5332, 0), (-0.11, 0.115, 0), (0, 0, 1)),
    ("Foot.R", 'LowerLeg.R', (-0.11, 0.115, 0), (-0.11, 0.115, 0.18), (-1, 0, 0)),
]


def ensure_rig(collection):
    """Create <NAME>_Rig from RIDER_BONES unless it already exists. Never edit it afterwards (docs/030)."""
    rig_name = f"{NAME}_Rig"
    rig = bpy.data.objects.get(rig_name)
    if rig is not None and {b.name for b in rig.data.bones} == {b[0] for b in RIDER_BONES}:
        return rig
    if rig is not None:                       # an older skeleton: replace it (its meshes are rebuilt anyway)
        old = rig.data
        bpy.data.objects.remove(rig, do_unlink=True)
        bpy.data.armatures.remove(old)
    fig = lambda v: Vector((v[0], -v[2], v[1]))   # figure -> Blender (Z up, -Y forward)
    arm = bpy.data.armatures.new(rig_name)
    rig = bpy.data.objects.new(rig_name, arm)
    collection.objects.link(rig)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, parent, head, tail, roll in RIDER_BONES:
        bone = arm.edit_bones.new(name)
        bone.head, bone.tail = fig(head), fig(tail)
    for name, parent, head, tail, roll in RIDER_BONES:
        bone = arm.edit_bones[name]
        if parent:
            bone.parent = arm.edit_bones[parent]
        bone.align_roll(fig(roll))
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.display_type = "STICK"
    rig.show_in_front = True
    return rig


def material(name):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    color, rough = PALETTE[name]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.6 if name.endswith("Lens") else 0.0
    mat.diffuse_color = (*color, 1.0)
    return mat


# Garment ids, stored per face (the `garment` attribute) and read back when painting. Shared by every rider,
# so a painter can rely on them; add new ids at the end.
G_TORSO, G_SLEEVE_L, G_SLEEVE_R, G_HOOD, G_GLOVE, G_GAUNTLET, G_PANTS = 1, 2, 3, 4, 5, 6, 7
G_SHAFT, G_FOOT, G_SOLE, G_HEAD, G_GAITER, G_BEANIE, G_POM = 8, 9, 10, 11, 12, 13, 14
G_FRAME, G_LENS, G_STRAP, G_CUP, G_BAND, G_PACK, G_PACKSTRAP = 15, 16, 17, 18, 19, 20, 21
G_RUFF, G_SHOVEL, G_LEASH, G_HANDLE = 22, 23, 24, 25


# ── Geometry helpers ─────────────────────────────────────────────────────────────────────────────────
def superellipse(n, ax, ay, p=2.4):
    """n points on |x/ax|^p + |y/ay|^p = 1, starting at +x and running counter-clockwise."""
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        c, s = math.cos(t), math.sin(t)
        pts.append((ax * math.copysign(abs(c) ** (2 / p), c), ay * math.copysign(abs(s) ** (2 / p), s)))
    return pts


def frame(axis, up_hint=Vector((0, -1, 0))):
    """Two unit vectors perpendicular to `axis`; the first leans toward up_hint (the rider's front)."""
    axis = axis.normalized()
    u = up_hint - up_hint.dot(axis) * axis
    if u.length < 1e-6:
        u = Vector((0, 0, 1)) - Vector((0, 0, 1)).dot(axis) * axis
    u.normalize()
    v = axis.cross(u).normalized()
    return u, v


def ring(center, u, v, profile):
    return [center + x * u + y * v for x, y in profile]


def uv_layers(bm):
    """The atlas UVs (UVMap, in metres until packed) and the garment's own around/along coordinates."""
    get = bm.loops.layers.uv.get
    return get("UVMap") or bm.loops.layers.uv.new("UVMap"), get("LoftUV") or bm.loops.layers.uv.new("LoftUV")


def tag(bm, garment):
    layer = bm.faces.layers.int.get("garment") or bm.faces.layers.int.new("garment")
    for f in bm.faces:
        f[layer] = garment
    return bm


def loft(rings, cap_start=True, cap_end=True, band_mats=None, closed=False):
    """Quads between consecutive rings, poked caps. band_mats[i] is the material slot of band i.

    UVs: LoftUV is (fraction around the ring, metres along the loft); UVMap is the same in metres both ways
    (around scaled by the mean ring perimeter), ready for packing at uniform texel density.
    """
    bm = bmesh.new()
    uv, luv = uv_layers(bm)
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    count = len(rings)
    centres = [sum(r, Vector()) / n for r in rings]
    along = [0.0]
    for i in range(1, count + (1 if closed else 0)):
        along.append(along[-1] + (centres[i % count] - centres[i - 1]).length)
    perim = sum(sum((r[(j + 1) % n] - r[j]).length for j in range(n)) for r in rings) / count
    bands = count if closed else count - 1
    for i in range(bands):
        a, b = vs[i], vs[(i + 1) % count]
        for j in range(n):
            f = bm.faces.new((a[j], a[(j + 1) % n], b[(j + 1) % n], b[j]))
            f.material_index = band_mats[i] if band_mats else 0
            corners = ((j, along[i]), (j + 1, along[i]), (j + 1, along[i + 1]), (j, along[i + 1]))
            for loop, (jj, sv) in zip(f.loops, corners):
                loop[luv].uv = (jj / n, sv)
                loop[uv].uv = (jj / n * perim, sv)
    for cap, idx, flag in ((cap_start, 0, False), (cap_end, -1, True)):
        if not cap or closed:
            continue
        ring_vs = vs[idx]
        centre = centres[idx]
        axis = (centres[1] - centres[0]) if idx == 0 else (centres[-1] - centres[-2])
        e1 = (ring_vs[0].co - centre).normalized()
        e2 = axis.normalized().cross(e1).normalized()
        c = bm.verts.new(centre)
        mi = (band_mats[0] if idx == 0 else band_mats[-1]) if band_mats else 0
        sv = along[idx]
        for j in range(n):
            a, b = ring_vs[j], ring_vs[(j + 1) % n]
            f = bm.faces.new((a, b, c) if flag else (b, a, c))
            f.material_index = mi
            for loop in f.loops:
                d = loop.vert.co - centre
                loop[uv].uv = (d.dot(e1), d.dot(e2))
                k = ring_vs.index(loop.vert) if loop.vert is not c else 0
                loop[luv].uv = (k / n, sv)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def strip(rows, band_mats=None):
    """Quads between consecutive open polylines (no wrap-around), UVs as loft(): around = metres across."""
    bm = bmesh.new()
    uv, luv = uv_layers(bm)
    vs = [[bm.verts.new(p) for p in r] for r in rows]
    n = len(rows[0])
    centres = [sum(r, Vector()) / n for r in rows]
    along = [0.0]
    for i in range(1, len(rows)):
        along.append(along[-1] + (centres[i] - centres[i - 1]).length)
    width = sum(sum((r[j + 1] - r[j]).length for j in range(n - 1)) for r in rows) / len(rows)
    for i in range(len(rows) - 1):
        a, b = vs[i], vs[i + 1]
        for j in range(n - 1):
            f = bm.faces.new((a[j], a[j + 1], b[j + 1], b[j]))
            f.material_index = band_mats[i] if band_mats else 0
            corners = ((j, along[i]), (j + 1, along[i]), (j + 1, along[i + 1]), (j, along[i + 1]))
            for loop, (jj, sv) in zip(f.loops, corners):
                loop[luv].uv = (jj / (n - 1), sv)
                loop[uv].uv = (jj / (n - 1) * width, sv)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def sphere_uvs(bm, centre):
    """Latitude/longitude UVs for a sphere-like part, in metres, with the wrap seam split per face."""
    import math as _m
    uv, luv = uv_layers(bm)
    r = sum(((v.co - centre).length for v in bm.verts)) / max(1, len(bm.verts))
    for f in bm.faces:
        coords = []
        for loop in f.loops:
            d = (loop.vert.co - centre).normalized()
            coords.append([_m.atan2(d.y, d.x) / (2 * _m.pi) + 0.5, _m.acos(max(-1, min(1, d.z))) / _m.pi])
        us = [c[0] for c in coords]
        if max(us) - min(us) > 0.5:
            for c in coords:
                if c[0] < 0.5:
                    c[0] += 1.0
        for loop, (u_, v_) in zip(f.loops, coords):
            loop[luv].uv = (u_, v_ * _m.pi * r)
            loop[uv].uv = (u_ * 2 * _m.pi * r, v_ * _m.pi * r)
    return bm


def axis_loft(points, radii, n=16, p=2.2, up_hint=Vector((0, -1, 0)), **kw):
    """Loft rings centred on a polyline; radii[i] = (across-front, across-side)."""
    rings = []
    for i, c in enumerate(points):
        a = points[min(i + 1, len(points) - 1)] - points[max(i - 1, 0)]
        u, v = frame(a, up_hint)
        rx, ry = radii[i]
        rings.append(ring(c, u, v, superellipse(n, rx, ry, p)))
    return loft(rings, **kw)


def arc_loft(theta0, theta1, steps, rx, ry, cy, z, half_h, half_t, closed=False, tilt=0.0):
    """A band around the head: path on an ellipse at height z, rectangular-ish cross-section."""
    rings = []
    count = steps if closed else steps + 1
    for i in range(count):
        th = math.radians(theta0 + (theta1 - theta0) * i / steps)
        c = Vector((rx * math.sin(th), cy - ry * math.cos(th), z + tilt * math.cos(th)))
        outward = Vector((math.sin(th) / rx, -math.cos(th) / ry, 0)).normalized()
        up = Vector((0, 0, 1))
        rings.append(ring(c, outward, up, superellipse(10, half_t, half_h, 3.0)))
    if closed:
        return loft(rings, cap_start=False, cap_end=False, closed=True, band_mats=[0] * len(rings))
    return loft(rings, band_mats=[0] * (len(rings) - 1))


def obj_from_bm(name, bm, mats):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(material(m))
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    COL.objects.link(ob)
    return ob


def merge(*bms):
    out = bmesh.new()
    for bm in bms:
        tmp = bpy.data.meshes.new("_tmp")
        bm.to_mesh(tmp)
        out.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
        bm.free()
    return out


def bone_pts(name):
    b = RIG.data.bones[name]
    return RIG.matrix_world @ b.head_local, RIG.matrix_world @ b.tail_local


def mirror_x(points):
    return [Vector((-p.x, p.y, p.z)) for p in points]


# ── Skinning ─────────────────────────────────────────────────────────────────────────────────────────
def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + t * ab)).length


def skin(ob, bones, sharp=7.0, top=3, rigid=None):
    """Distance-to-bone weights over a candidate set (top-N, normalized), or one rigid bone."""
    for b in RIG.data.bones:
        ob.vertex_groups.new(name=b.name)
    if rigid:
        ob.vertex_groups[rigid].add([v.index for v in ob.data.vertices], 1.0, "REPLACE")
    else:
        segs = {b: bone_pts(b) for b in bones}
        for v in ob.data.vertices:
            d = {b: max(seg_dist(v.co, *segs[b]), 1e-4) for b in bones}
            dmin = min(d.values())
            w = {b: (dmin / d[b]) ** sharp for b in bones}
            best = sorted(w.items(), key=lambda kv: -kv[1])[:top]
            best = [(b, x) for b, x in best if x > 0.02]
            total = sum(x for _, x in best)
            for b, x in best:
                ob.vertex_groups[b].add([v.index], x / total, "REPLACE")
    ob.parent = RIG
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = RIG


def blend_hem(ob, top=0.98, bottom=0.80, amount=0.45, front_extra=0.0, depth=0.18):
    """Let the coat's lower part follow the thighs, so a crouch carries the hem forward instead of through it.
    front_extra adds more at the front (full at y = -depth), where a long coat rides over the thighs."""
    for v in ob.data.vertices:
        if v.co.z >= top or abs(v.co.x) > 0.27:
            continue
        t = min(1.0, (top - v.co.z) / (top - bottom))
        f = amount * t * t * (3 - 2 * t)
        if front_extra:
            f += front_extra * min(1.0, max(0.0, -v.co.y / depth)) * t * t * (3 - 2 * t)
        side = "L" if v.co.x >= 0 else "R"
        groups = {ob.vertex_groups[g.group].name: g.weight for g in v.groups}
        groups = {k: w * (1 - f) for k, w in groups.items()}
        groups[f"UpperLeg.{side}"] = groups.get(f"UpperLeg.{side}", 0.0) + f
        best = sorted(groups.items(), key=lambda kv: -kv[1])[:4]
        total = sum(w for _, w in best)
        for g in list(v.groups):
            ob.vertex_groups[g.group].remove([v.index])
        for k, w in best:
            ob.vertex_groups[k].add([v.index], w / total, "REPLACE")


def ride_hem(ob, front=(1.04, 0.93, 0.95), back=(0.98, 0.745, 0.55), front_y=(-0.02, -0.12), split=0.06):
    """A long coat in a crouch: its lower front rides up on the thighs (nearly all thigh below a short handover
    at the hip crease), the back and sides follow gently. front/back = (z where the thigh's share starts,
    z where it is full, full share). The centre front is shared between both thighs over +-split metres, so an
    uneven crouch shears it instead of tearing it."""
    def ss(a, b, z):
        t = min(1.0, max(0.0, (z - a) / (b - a)))
        return t * t * (3 - 2 * t)
    for v in ob.data.vertices:
        co = v.co
        if co.z >= max(front[0], back[0]) or abs(co.x) > 0.27:
            continue
        fr = ss(front_y[0], front_y[1], co.y)
        f = fr * front[2] * ss(front[0], front[1], co.z) + (1 - fr) * back[2] * ss(back[0], back[1], co.z)
        if f <= 0:
            continue
        left = ss(-split, split, co.x)
        groups = {ob.vertex_groups[g.group].name: g.weight * (1 - f) for g in v.groups}
        for side, share in (("L", left), ("R", 1 - left)):
            if share > 0:
                groups[f"UpperLeg.{side}"] = groups.get(f"UpperLeg.{side}", 0.0) + f * share
        best = sorted(groups.items(), key=lambda kv: -kv[1])[:4]
        total = sum(w for _, w in best)
        for g in list(v.groups):
            ob.vertex_groups[g.group].remove([v.index])
        for k, w in best:
            ob.vertex_groups[k].add([v.index], w / total, "REPLACE")


def blend_toward(ob, bone_for, z_from, z_to, amount, keep=lambda co: True):
    """Shift weight toward one bone over a height band (0 at z_from, `amount` at z_to), keeping the top four."""
    for v in ob.data.vertices:
        if not keep(v.co):
            continue
        t = (v.co.z - z_from) / (z_to - z_from)
        if t <= 0:
            continue
        t = min(1.0, t)
        f = amount * t * t * (3 - 2 * t)
        target = bone_for(v.co)
        groups = {ob.vertex_groups[g.group].name: g.weight * (1 - f) for g in v.groups}
        groups[target] = groups.get(target, 0.0) + f
        best = sorted(groups.items(), key=lambda kv: -kv[1])[:4]
        total = sum(w for _, w in best)
        for g in list(v.groups):
            ob.vertex_groups[g.group].remove([v.index])
        for k, w in best:
            ob.vertex_groups[k].add([v.index], w / total, "REPLACE")


# ── Body lofts ───────────────────────────────────────────────────────────────────────────────────────
def torso_loft(rows, bands, n=24, p=2.35, front_drop=None):
    """The coat body: horizontal rings (z, half-width, half-depth, y-centre), capped at the hem.

    front_drop[i], if given, lowers ring i's front by that much (fading to 0 at the sides): a collar cut low
    under the chin."""
    rings = []
    for i, (z, hx, hy, cy) in enumerate(rows):
        r = ring(Vector((0, cy, z)), Vector((1, 0, 0)), Vector((0, 1, 0)), superellipse(n, hx, hy, p))
        if front_drop and front_drop[i]:
            for q in r:
                q.z -= front_drop[i] * max(0.0, -(q.y - cy) / hy) ** 2
        rings.append(r)
    return tag(loft(rings, cap_start=True, cap_end=False, band_mats=bands), G_TORSO)


def sleeve_loft(side, stations, lift=0.012, n=14, p=2.2):
    """A sleeve along the arm. stations(ua, fa) -> [(distance from the shoulder joint, half-width, half-depth,
    material of the band ending there)], ua/fa the upper and lower arm lengths."""
    s = 1 if side == "L" else -1
    sh, el = bone_pts(f"UpperArm.{side}")
    _, wr = bone_pts(f"LowerArm.{side}")
    d = (el - sh).normalized()
    ua, fa = (el - sh).length, (wr - el).length
    st = stations(ua, fa)
    lift = Vector((0, 0, lift))
    pts = [sh + lift + d * t for t, *_ in st]
    radii = [(b, a) for _, a, b, _ in st]
    bands = [m for *_, m in st[1:]]
    return tag(axis_loft(pts, radii, n=n, p=p, cap_start=True, cap_end=True, band_mats=bands),
               G_SLEEVE_L if s > 0 else G_SLEEVE_R)


def leg_loft(side, rows, cy=0.004, n=16, p=2.2):
    """A trouser leg: rings (z, leg centre x, half-width, half-depth) from the waist down, capped both ends."""
    s = 1 if side == "L" else -1
    rings = [ring(Vector((s * cx, cy, z)), Vector((1, 0, 0)), Vector((0, 1, 0)),
                  superellipse(n, hx, hy, p)) for z, cx, hx, hy in rows]
    return tag(loft(rings, cap_start=True, cap_end=True, band_mats=[0] * (len(rows) - 1)), G_PANTS)


# ── Hands ────────────────────────────────────────────────────────────────────────────────────────────
def hand_frame(side):
    """World axes of the hand bone: x = palm normal side, y = down the fingers, z = across toward the thumb."""
    b = RIG.data.bones[f"Hand.{side}"]
    m = RIG.matrix_world @ b.matrix_local
    return (m.col[3].xyz, m.col[0].xyz.normalized(), m.col[1].xyz.normalized(), m.col[2].xyz.normalized(),
            b.length)


def palm_normal(side):
    """The way the palm faces at rest: toward the body for both hands (the right frame is mirrored)."""
    _, x, _, _, _ = hand_frame("L")
    return x if side == "L" else Vector((-x.x, x.y, x.z))


DIGIT_NAMES = {"thumb": ("Thumb", 2, 0.0135), "index": ("Index", 3, 0.0118), "middle": ("Middle", 3, 0.0122),
               "ring": ("Ring", 3, 0.0114), "pinky": ("Pinky", 3, 0.0102)}
PALM_STATIONS = [(-0.014, 0.041, 0.027), (0.012, 0.047, 0.028), (0.040, 0.057, 0.027), (0.066, 0.067, 0.024),
                 (0.084, 0.066, 0.021), (0.094, 0.055, 0.016)]


def glove_palm(side, stations=PALM_STATIONS, band_mats=None):
    """The glove's palm and back: rings (distance from the wrist, half-width across the palm, half-thickness)."""
    o, x, y, z, length = hand_frame(side)
    rings = [ring(o + y * t, z, x, superellipse(14, w, th, 2.6)) for t, w, th in stations]
    return tag(loft(rings, band_mats=band_mats or [0] * (len(rings) - 1)), G_GLOVE)


FINGER_WIDTH = 1.3      # glove fingers are this much wider across the palm than thick (the contract hand is broad)
FINGER_PARALLEL = 1.0   # how much of the bones' fan-out the glove fingers drop, so neighbours stay close to the tips


def finger_joints(side, digit, parallel=FINGER_PARALLEL):
    """World points of a glove finger's joints (knuckle, then each segment's end), with the same sideways
    straightening glove_finger applies, so prints on the glove follow the glove rather than the bare bones."""
    label, segs, _ = DIGIT_NAMES[digit]
    prefix = "LeftHand" if side == "L" else "RightHand"
    chain = [RIG.data.bones[f"{prefix}{label}{k}"] for k in range(1, segs + 1)]
    pts = [RIG.matrix_world @ chain[0].head_local] + [RIG.matrix_world @ b.tail_local for b in chain]
    if digit == "thumb" or not parallel:
        return pts
    across = hand_frame(side)[3]
    return [q - across * (parallel * (q - pts[0]).dot(across)) for q in pts]


def glove_finger(side, digit, girth=1.0, width=FINGER_WIDTH, parallel=FINGER_PARALLEL):
    """One glove finger along its bone chain (five separate fingers, for optical finger tracking).

    The contract's knuckles are 33 mm apart, so round fingers leave wide gaps: the four fingers are widened
    across the palm (`width`) and laid parallel (`parallel` removes that share of their sideways splay; the
    offset is along the curl axis, so it holds when they bend). The thumb keeps its round shape and line."""
    label, segs, rad = DIGIT_NAMES[digit]
    rad = rad * girth
    if digit == "thumb":
        width, parallel = 1.0, 0.0
    prefix = "LeftHand" if side == "L" else "RightHand"
    chain = [RIG.data.bones[f"{prefix}{label}{k}"] for k in range(1, segs + 1)]
    pn = palm_normal(side)
    pts, radii = [], []
    first = chain[0]
    d0 = (first.tail_local - first.head_local).normalized()
    pts.append(first.head_local - d0 * 0.016)
    radii.append(rad)
    for k, b in enumerate(chain):
        h, t = b.head_local, b.tail_local
        d = (t - h).normalized()
        taper = 1.0 - 0.07 * k
        for f in (0.0, 0.5, 0.88):
            pts.append(h + (t - h) * f)
            radii.append(rad * taper * (1.04 if f == 0.0 and k > 0 else 1.0))
    t = chain[-1].tail_local
    d = (chain[-1].tail_local - chain[-1].head_local).normalized()
    for f, rr in ((0.0, 0.95), (0.006, 0.8), (0.0105, 0.45)):
        pts.append(t + d * f)
        radii.append(rad * (1.0 - 0.07 * (segs - 1)) * rr)
    pts = [RIG.matrix_world @ q for q in pts]
    if parallel:
        across = hand_frame(side)[3]                         # toward the thumb, across the knuckles
        knuckle = pts[1]
        pts = [q - across * (parallel * (q - knuckle).dot(across)) for q in pts]
    bm = axis_loft(pts, [(r_ * 0.86, r_ * width) for r_ in radii], n=10, p=2.2, up_hint=pn,
                   band_mats=[0] * (len(pts) - 1))
    return tag(bm, G_GLOVE), ["Hand." + side] + [b.name for b in chain]


def add_gloves(side, mats, palm_stations=PALM_STATIONS, palm_bands=None, girth=1.0):
    """Palm plus five fingers for one hand, skinned to the hand and finger bones."""
    prefix = "LeftHand" if side == "L" else "RightHand"
    knuckles = [f"{prefix}{n}1" for n in ("Thumb", "Index", "Middle", "Ring", "Pinky")]
    palm = obj_from_bm(f"{PREFIX}Glove.{side}", glove_palm(side, palm_stations, palm_bands), mats)
    skin(palm, [f"LowerArm.{side}", f"Hand.{side}"] + knuckles, sharp=10.0, top=2)
    for digit in DIGIT_NAMES:
        bm, bones = glove_finger(side, digit, girth)
        fo = obj_from_bm(f"{PREFIX}Glove.{side}.{digit}", bm, mats)
        skin(fo, bones, sharp=12.0, top=2)


# ── Boots ────────────────────────────────────────────────────────────────────────────────────────────
def boot(side):
    """Snowboard boot. Material slots: 0 upper, 1 sole, 2 toe cap, 3 lace panel."""
    s = 1 if side == "L" else -1
    x = s * 0.11
    shaft = loft([ring(Vector((x, 0.012, z)), Vector((1, 0, 0)), Vector((0, 1, 0)),
                       superellipse(14, r, r * 1.05, 2.4)) for z, r in ((0.30, 0.076), (0.21, 0.081), (0.13, 0.083))],
                 band_mats=[0, 0])
    # Foot: rings across the foot, marching from heel to toe (-Y). (y, half-width, z-bottom, z-top)
    rows = [(0.100, 0.054, 0.044, 0.150), (0.080, 0.064, 0.044, 0.168), (0.0, 0.068, 0.044, 0.176),
            (-0.085, 0.067, 0.044, 0.140), (-0.160, 0.062, 0.044, 0.114), (-0.208, 0.050, 0.048, 0.096),
            (-0.228, 0.030, 0.056, 0.082)]
    rings = []
    for y, hx, zb, zt in rows:
        rings.append(ring(Vector((x, y, (zb + zt) / 2)), Vector((1, 0, 0)), Vector((0, 0, 1)),
                          superellipse(14, hx, (zt - zb) / 2, 2.8)))
    foot = loft(rings, band_mats=[0] * (len(rows) - 1))
    for f in foot.faces:  # black toe cap, lace panel across the instep
        c = f.calc_center_median()
        if c.y < -0.17:
            f.material_index = 2
        elif -0.13 < c.y < 0.03 and f.normal.z > 0.55 and abs(c.x - x) < 0.04:
            f.material_index = 3
    # Sole: a flat lug slab under it all.
    srows = [(0.108, 0.058), (0.075, 0.071), (-0.05, 0.073), (-0.165, 0.068), (-0.222, 0.054), (-0.238, 0.032)]
    srings = [ring(Vector((x, y, 0.024)), Vector((1, 0, 0)), Vector((0, 0, 1)), superellipse(12, hx, 0.024, 4.0))
              for y, hx in srows]
    sole = loft(srings, band_mats=[1] * (len(srows) - 1))
    for f in sole.faces:
        f.material_index = 1
    return merge(tag(shaft, G_SHAFT), tag(foot, G_FOOT), tag(sole, G_SOLE))


def add_boot(side, mats):
    b = obj_from_bm(f"{PREFIX}Boot.{side}", boot(side), mats)
    skin(b, [f"LowerLeg.{side}", f"Foot.{side}"], sharp=12.0, top=2)
    return b


# ── Head and face ────────────────────────────────────────────────────────────────────────────────────
# The head is a smooth sculpt: a signed-distance field of a few broad, rounded forms (cranium, a boxy jaw
# tilted along the mandible, chin, nose, lips, neck) joined with smooth unions, sampled onto a dense sphere
# (rays from inside, then relaxed so every part gets even vertex spacing) and decimated to a game budget.
# Like the retail riders, the shapes stay simple and the painting carries lips, nostrils and colour.
# A face dict holds the numbers in metres, in the head's own frame: s toward the rider's left (+X), f forward
# (-Y), u up, all from HEAD_C. Paired features are given for the left side and mirrored. Every rider keeps
# goggles on, so there are no eyes to model. Riders vary the face by copying BASE_FACE and changing entries.
HEAD_C = Vector((0, -0.012, 1.615))
FACE_UV_SCALE = 1.6    # the face gets this much more texture density than the clothes
BASE_FACE = {
    # (centre, radii[, exponent[, tilt degrees about s: positive drops the front]])
    "cranium": ((0.0, -0.010, 0.012), (0.090, 0.104, 0.108)),
    "jaw": ((0.0, 0.024, -0.058), (0.068, 0.080, 0.064), 2.5, 16.0),
    "chin": ((0.0, 0.088, -0.103), (0.026, 0.020, 0.020), 2.2),
    "neck": ((0.0, -0.012, -0.230), (0.0, -0.004, -0.060), 0.050, 0.048),
    "bridge": ((0.0, 0.092, 0.004), (0.0, 0.114, -0.030), 0.0065, 0.0095),
    "tip": ((0.0, 0.116, -0.036), 0.0125),
    "ala": ((0.0145, 0.102, -0.043), (0.0095, 0.0095, 0.0075)),
    "upper_lip": ((0.0, 0.100, -0.064), (0.024, 0.012, 0.009)),
    "lower_lip": ((0.0, 0.097, -0.078), (0.021, 0.0115, 0.0085)),
    "mouth_line": ((0.0, 0.118, -0.0712), (0.020, 0.008, 0.0012)),
    "origin": (0.0, 0.0, -0.02),      # inside everything: rays are cast from here
    "triangles": 2600,
}
FACE = BASE_FACE


def head_frame(p):
    """World points (N, 3) -> head frame (s, f, u)."""
    import numpy as np
    return np.stack([p[:, 0], HEAD_C.y - p[:, 1], p[:, 2] - HEAD_C.z], -1)


def head_world(p):
    import numpy as np
    return np.stack([p[:, 0], HEAD_C.y - p[:, 1], p[:, 2] + HEAD_C.z], -1)


def ell_sdf(q, c, r, n=2.0, tilt=0.0):
    """Approximate signed distance to an ellipsoid (n = 2) or superellipsoid, optionally tilted about s."""
    import numpy as np
    A = lambda v: np.asarray(v, dtype=np.float64)
    q = q - A(c)
    if tilt:
        a = np.radians(tilt)
        q = np.stack([q[:, 0], q[:, 1] * np.cos(a) - q[:, 2] * np.sin(a),
                      q[:, 1] * np.sin(a) + q[:, 2] * np.cos(a)], -1)
    r = A(r)
    if n == 2.0:
        k0 = np.linalg.norm(q / r, axis=-1)
        k1 = np.linalg.norm(q / (r * r), axis=-1)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)
    k = (np.abs(q / r) ** n).sum(-1) ** (1.0 / n)
    return (k - 1.0) * r.min()


def cone_sdf(q, a, b, ra, rb):
    import numpy as np
    A = lambda v: np.asarray(v, dtype=np.float64)
    a, b = A(a), A(b)
    ba = b - a
    h = np.clip(((q - a) @ ba) / (ba @ ba), 0, 1)
    return np.linalg.norm(q - a - h[:, None] * ba, axis=-1) - (ra + (rb - ra) * h)


def smin(a, b, k):
    import numpy as np
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def head_sdf(p, face=None, part="head"):
    """Signed distance (metres, negative inside; exact only near the surface) at head-frame points (N, 3).
    part="nose" returns the nose on its own, which the painting uses to keep the nostrils on it."""
    import numpy as np
    face = face or FACE
    mirror = np.concatenate([np.abs(p[:, :1]), p[:, 1:]], -1)
    sphere = lambda q, c, r: np.linalg.norm(q - np.asarray(c, dtype=np.float64), axis=-1) - r
    carve = lambda d, cut, k: -smin(-d, cut, k)

    d = ell_sdf(p, *face["cranium"])
    d = smin(d, ell_sdf(p, *face["jaw"]), 0.028)
    d = smin(d, ell_sdf(p, *face["chin"]), 0.014)
    d = smin(d, cone_sdf(p, *face["neck"]), 0.030)
    nose = smin(cone_sdf(p, *face["bridge"]), sphere(p, *face["tip"]), 0.007)
    nose = smin(nose, ell_sdf(mirror, *face["ala"]), 0.006)
    if part == "nose":
        return nose
    d = smin(d, nose, 0.014)
    lips = smin(ell_sdf(p, *face["upper_lip"]), ell_sdf(p, *face["lower_lip"]), 0.003)
    d = smin(d, lips, 0.010)
    d = carve(d, ell_sdf(p, *face["mouth_line"]), 0.0015)
    return d


def sdf_grad(sdf, p):
    import numpy as np
    h = 1e-4
    g = np.zeros_like(p)
    for i in range(3):
        e = np.zeros(3)
        e[i] = h
        g[:, i] = (sdf(p + e) - sdf(p - e)) / (2 * h)
    return g


def sdf_mesh(sdf, origin, triangles, subdivisions=7, relax=12, t_max=0.34):
    """A closed, star-shaped head-frame field as a world-space bmesh: rays from `origin` to its surface,
    relaxed to even spacing along the surface, then decimated (symmetric in X) to about `triangles`."""
    import numpy as np
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1.0)
    bm.verts.index_update()
    dirs = np.array([v.co[:] for v in bm.verts], dtype=np.float64)
    dirs /= np.linalg.norm(dirs, axis=-1, keepdims=True)
    tris = np.array([[v.index for v in f.verts] for f in bm.faces], dtype=np.int64)
    o = np.asarray(origin, dtype=np.float64)
    # March out until the field turns positive, then bisect: the first crossing along each ray.
    step = 0.0025
    lo = np.zeros(len(dirs))
    hi = np.full(len(dirs), t_max)
    found = np.zeros(len(dirs), bool)
    t = step
    while t <= t_max and not found.all():
        live = np.nonzero(~found)[0]
        out = sdf(o + dirs[live] * t) > 0
        idx = live[out]
        hi[idx], lo[idx], found[idx] = t, t - step, True
        t += step
    for _ in range(14):
        mid = (lo + hi) / 2
        inside = sdf(o + dirs * mid[:, None]) < 0
        lo = np.where(inside, mid, lo)
        hi = np.where(inside, hi, mid)
    V = o + dirs * ((lo + hi) / 2)[:, None]
    # Relax: even out the spacing along the surface (rays from one point bunch up on the nose's sides).
    E = np.concatenate([tris[:, [0, 1]], tris[:, [1, 2]], tris[:, [2, 0]]])
    cnt = np.bincount(E[:, 0], minlength=len(V)).astype(np.float64)[:, None]
    for _ in range(relax):
        acc = np.zeros_like(V)
        np.add.at(acc, E[:, 0], V[E[:, 1]])
        lap = acc / cnt - V
        g = sdf_grad(sdf, V)
        n = g / np.maximum(np.linalg.norm(g, axis=-1, keepdims=True), 1e-9)
        lap -= (lap * n).sum(-1, keepdims=True) * n
        V = V + 0.6 * lap
        for _ in range(2):
            g = sdf_grad(sdf, V)
            V = V - (sdf(V) / np.maximum((g * g).sum(-1), 1e-9))[:, None] * g
    pts = head_world(V)
    for v, c in zip(bm.verts, pts):
        v.co = Vector(c)
    bm.normal_update()                                     # recalc reads the face normals: refresh them first
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)    # the head frame is mirrored (f = -y): rewind outward
    # Decimate on a scratch object (collapse keeps density where the shape turns: nose, lips, chin).
    me = bpy.data.meshes.new("_head")
    bm.to_mesh(me)
    bm.free()
    tmp = bpy.data.objects.new("_head", me)
    bpy.context.scene.collection.objects.link(tmp)
    mod = tmp.modifiers.new("dec", "DECIMATE")
    mod.ratio = min(1.0, (triangles or 10 ** 9) / max(1, len(me.polygons)))
    mod.use_symmetry = True
    mod.symmetry_axis = "X"
    dg = bpy.context.evaluated_depsgraph_get()
    out = bmesh.new()
    out.from_mesh(tmp.evaluated_get(dg).to_mesh())
    tmp.evaluated_get(dg).to_mesh_clear()
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.meshes.remove(me)
    return out


def head(face=None, subdivisions=7, relax=12):
    """The head as a bmesh: rays from inside the field to its surface, relaxed, then decimated."""
    face = face or FACE
    out = sdf_mesh(lambda q: head_sdf(q, face), face["origin"], face["triangles"], subdivisions, relax)
    return tag(sphere_uvs(out, HEAD_C), G_HEAD)


def add_head(face=None):
    """The head object: rigid to Head, the neck below the jaw handing over to Neck."""
    h = obj_from_bm(f"{PREFIX}Head", head(face), [f"{PREFIX}Skin"])
    for loop_uv in h.data.uv_layers["UVMap"].data:
        loop_uv.uv *= FACE_UV_SCALE
    skin(h, None, rigid="Head")
    # Below the jaw the neck follows the Neck bone, so turning the head twists the neck instead of swinging it.
    blend_toward(h, lambda co: "Neck", 1.505, 1.445, 1.0, keep=lambda co: co.y > HEAD_C.y - 0.06)
    return h


# ── Gaiter ───────────────────────────────────────────────────────────────────────────────────────────
def gaiter_down():
    """The gaiter pulled down: a soft roll bunched over the jacket's funnel collar, under the chin."""
    # z, half-width, half-depth: tucked against the collar at the bottom, bulging, then rolling back in.
    rows = [(1.478, 0.150, 0.110), (1.488, 0.156, 0.120), (1.503, 0.146, 0.118), (1.518, 0.126, 0.108),
            (1.531, 0.108, 0.098), (1.539, 0.094, 0.088), (1.542, 0.082, 0.077), (1.540, 0.074, 0.070)]
    rings = [[Vector((px, 0.010 + py, z)) for px, py in superellipse(28, hx, hy, 2.3)] for z, hx, hy in rows]
    return tag(loft(rings, cap_start=False, cap_end=False, band_mats=[0] * (len(rows) - 1)), G_GAITER)


def ray_exit(inside, count, t_max=0.30, step=0.002):
    """Per ray, the distance from the axis to the first point outside; inside(t) takes one distance per ray."""
    import numpy as np
    lo, hi = np.zeros(count), np.full(count, t_max)
    found = np.zeros(count, bool)
    t = step
    while t <= t_max and not found.all():
        out = ~inside(np.full(count, t)) & ~found
        hi[out], lo[out] = t, t - step
        found |= out
        t += step
    for _ in range(12):
        mid = (lo + hi) / 2
        ins = inside(mid)
        lo, hi = np.where(ins, mid, lo), np.where(ins, hi, mid)
    return (lo + hi) / 2


def _span_ring(r, th):
    """Push each ray's radius out to the convex hull of the ring: fabric spans across hollows (beside the nose)."""
    import numpy as np
    pts = np.stack([r * np.sin(th), -r * np.cos(th)], -1)
    order = sorted(range(len(pts)), key=lambda k: (pts[k, 0], pts[k, 1]))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for k in order:
        while len(lower) >= 2 and cross(pts[lower[-2]], pts[lower[-1]], pts[k]) <= 0:
            lower.pop()
        lower.append(k)
    for k in reversed(order):
        while len(upper) >= 2 and cross(pts[upper[-2]], pts[upper[-1]], pts[k]) <= 0:
            upper.pop()
        upper.append(k)
    hull = pts[lower[:-1] + upper[:-1]]
    out = r.copy()
    d = np.stack([np.sin(th), -np.cos(th)], -1)
    for a, b in zip(hull, np.roll(hull, -1, 0)):
        e = b - a
        den = d[:, 0] * e[1] - d[:, 1] * e[0]
        ok = np.abs(den) > 1e-12
        t = np.where(ok, (a[0] * e[1] - a[1] * e[0]) / np.where(ok, den, 1), 0)      # along the ray
        s = np.where(ok, (a[0] * d[:, 1] - a[1] * d[:, 0]) / np.where(ok, den, 1), -1)  # along the edge
        hit = ok & (s >= -1e-9) & (s <= 1 + 1e-9) & (t > 0)
        out = np.where(hit, np.maximum(out, t), out)
    return out


def gaiter_up(torso_rows=None, face=None, n=36, axis_y=-0.005, z_bottom=1.482, offset=0.003, z_top=1.553,
              z_top_front=0.008, torso_top=1.536, gathers=0.007, span=False):
    """The gaiter pulled up over the face, its edge at z_top (+ z_top_front at the front).

    Fabric spans hollows rather than following them, so each column around the neck takes the concave
    envelope of what it lies on (the collar, then the jaw, chin and lips) in (height, radius): it runs straight
    from the collar to the chin and rests on the lips. With span, each ring also spans across hollows sideways
    (beside the nose). Gathers at the bottom, a rolled hem at the top. torso_rows=None: tucked inside the
    collar instead of draped over it, so it rests on the head and neck only.
    """
    import numpy as np
    th = np.linspace(np.pi, 3 * np.pi, n, endpoint=False)     # starts at the back, so the texture wraps there
    dx, dy = np.sin(th), -np.cos(th)                 # 0 = front (-Y), increasing toward the rider's left (+X)
    front = np.where(np.cos(th) > 0, np.cos(th) ** 2, 0.0)
    z_top = z_top + z_top_front * front

    def torso_r(z):
        tz = [r[0] for r in torso_rows]
        hx, hy, cy = (np.interp(z, tz, [r[k] for r in torso_rows]) for k in (1, 2, 3))
        return ray_exit(lambda t: (np.abs(t * dx / hx) ** 2.35 + np.abs((axis_y + t * dy - cy) / hy) ** 2.35) <= 1,
                        n, t_max=0.4)

    def head_r(z):
        u = np.broadcast_to(np.asarray(z, dtype=np.float64) - HEAD_C.z, (n,))
        return ray_exit(lambda t: head_sdf(np.stack([t * dx, HEAD_C.y - (axis_y + t * dy), u], -1), face) < 0, n)

    zs, rs = [], []
    if torso_rows is not None:
        for z in np.arange(z_bottom - 0.006, torso_top, 0.006):
            zs.append(z)
            rs.append(torso_r(z) + 0.004)
    for z in np.arange(z_bottom, z_top.max() + 0.0041, 0.002):
        zs.append(z)
        rs.append(np.where(z <= z_top + 0.004, head_r(z) + offset, 0.0))
    Z, R = np.array(zs), np.stack(rs, 1)
    order = np.argsort(Z, kind="stable")
    ts = [0.0, 0.07, 0.15, 0.24, 0.34, 0.45, 0.56, 0.66, 0.75, 0.83, 0.90, 0.96, 1.0]
    rings = [[None] * n for _ in range(len(ts) + 3)]
    at = lambda j, r, z: Vector((r * dx[j], axis_y + r * dy[j], z))
    hulls = []
    for j in range(n):
        hull = []
        for k in order:
            if R[j, k] <= 0:
                continue
            p = (Z[k], R[j, k])
            while len(hull) >= 2 and ((hull[-1][0] - hull[-2][0]) * (p[1] - hull[-2][1])
                                      - (hull[-1][1] - hull[-2][1]) * (p[0] - hull[-2][0])) >= 0:
                hull.pop()
            hull.append(p)
        hulls.append(([p[0] for p in hull], [p[1] for p in hull]))
    base = np.array([[float(np.interp(z_bottom + t * (z_top[j] - z_bottom), *hulls[j])) for j in range(n)]
                     for t in ts])
    rt = np.array([float(np.interp(z_top[j], *hulls[j])) for j in range(n)])
    if span:
        base = np.array([_span_ring(b, th) for b in base])
        rt = _span_ring(rt, th)
    if torso_rows is not None:
        tuck_r = torso_r(z_bottom - 0.006) - 0.001
    else:
        tuck_r = base[0] - 0.002
    hem_in_r = head_r(z_top - 0.004) + 0.0015
    if span:
        hem_in_r = np.maximum(hem_in_r, rt - 0.0045)
    for j in range(n):
        rings[0][j] = at(j, tuck_r[j], z_bottom - 0.006)            # tucked onto (or into) the jacket
        for i, t in enumerate(ts):
            z = z_bottom + t * (z_top[j] - z_bottom)
            r = base[i, j] + gathers * max(0.0, 1 - t / 0.4) ** 2 * (0.5 + 0.5 * math.sin(7 * th[j] + 1.3))
            rings[i + 1][j] = at(j, r, z)
        rings[-2][j] = at(j, rt[j] + 0.002, z_top[j] + 0.0025)        # the rolled top edge
        rings[-1][j] = at(j, hem_in_r[j], z_top[j] - 0.004)           # and back in against the skin
    return tag(loft(rings, cap_start=False, cap_end=False, band_mats=[0] * (len(rings) - 1)), G_GAITER)


def add_gaiter(bm, mode, chin_band=(1.482, 1.508), side_band=(1.500, 1.545)):
    """The gaiter object: Chest/Neck at the collar; pulled up, the part over the jaw moves with the head."""
    g = obj_from_bm(f"{PREFIX}Gaiter", bm, [f"{PREFIX}Gaiter"])
    skin(g, ["Chest", "Neck"], sharp=6.0)
    if mode != "down":
        chin = lambda co: co.y < HEAD_C.y - 0.05
        blend_toward(g, lambda co: "Head", chin_band[0], chin_band[1], 1.0, keep=chin)
        blend_toward(g, lambda co: "Head", side_band[0], side_band[1], 1.0, keep=lambda co: not chin(co))
    return g


# ── Goggles ──────────────────────────────────────────────────────────────────────────────────────────
def notch_goggles(bm, depth=0.014, half_width=0.026, centre_z=1.636):
    """Lift the bottom edge of the frame and lens over the nose bridge, as real goggles are cut."""
    for v in bm.verts:
        if v.co.z < centre_z and v.co.y < HEAD_C.y - 0.05:
            w = max(0.0, 1.0 - (v.co.x / half_width) ** 2)
            v.co.z += depth * w * w * (centre_z - v.co.z) / 0.030
    return bm


def goggles(strap_closed=True):
    """Frame (slot 0), lens (slot 1) and strap. Material list: [frame, lens]. strap_closed: a full loop (hidden
    in front by a hat brim); False runs the strap from one side of the frame round the back to the other."""
    frame_bm = arc_loft(-78, 78, 18, 0.108, 0.120, HEAD_C.y, 1.636, 0.030, 0.012)
    lens = arc_loft(-64, 64, 16, 0.119, 0.131, HEAD_C.y, 1.636, 0.024, 0.006)
    for f in lens.faces:
        f.material_index = 1
    notch_goggles(frame_bm)
    notch_goggles(lens)
    if strap_closed:
        strap = arc_loft(0, 360, 32, 0.113, 0.125, HEAD_C.y, 1.664, 0.012, 0.004, closed=True, tilt=0.022)
    else:
        strap = arc_loft(72, 288, 22, 0.113, 0.125, HEAD_C.y, 1.650, 0.012, 0.004)
    return merge(tag(frame_bm, G_FRAME), tag(lens, G_LENS), tag(strap, G_STRAP))


# ── Packs ────────────────────────────────────────────────────────────────────────────────────────────
def straps(jacket, x=0.105, z=1.27, phi=(-62, 128)):
    """Shoulder straps laid over the jacket: rays in the side plane from a centre inside the chest."""
    tree = BVHTree.FromObject(jacket, bpy.context.evaluated_depsgraph_get())
    out = []
    for s in (1, -1):
        centre = Vector((s * x, 0.0, z))
        pts = []
        for i in range(19):
            a = math.radians(phi[0] + (phi[1] - phi[0]) * i / 18)
            d = Vector((0, -math.sin(a), math.cos(a)))
            hit = tree.ray_cast(centre + d * 0.4, -d)
            if hit[0] is not None:
                pts.append(hit[0] + d * 0.008)
        out.append(axis_loft(pts, [(0.019, 0.004)] * len(pts), n=8, p=4.0,
                             up_hint=Vector((s, 0, 0)), band_mats=[0] * (len(pts) - 1)))
    return tag(merge(*out), G_PACKSTRAP)


# ── Assembly ─────────────────────────────────────────────────────────────────────────────────────────
def clear_previous():
    for o in list(COL.objects):
        if o.type == "MESH" and (o.name.startswith(PREFIX) or o.name.startswith(NAME)):
            bpy.data.objects.remove(o, do_unlink=True)


def join_and_pack(margin=0.004):
    parts = [o for o in COL.objects if o.type == "MESH" and o.name.startswith(PREFIX)]
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = NAME
    for m in [m for m in ob.modifiers if m.type == "ARMATURE"][1:]:
        ob.modifiers.remove(m)
    me = ob.data
    # Slot of every face, kept as an attribute so painting and texturing survive a material swap.
    slot = me.attributes.get("slot") or me.attributes.new("slot", "INT", "FACE")
    slot.data.foreach_set("value", [p.material_index for p in me.polygons])
    me["slot_names"] = [m.name for m in me.materials]
    me.uv_layers.active = me.uv_layers["UVMap"]
    me.uv_layers["UVMap"].active_render = True
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=False, scale=True, margin_method="FRACTION", margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    ob.select_set(False)
    return ob


def stats(ob):
    return {NAME: (len(ob.data.vertices), sum(len(pl.vertices) - 2 for pl in ob.data.polygons))}


# ── Texture painting ─────────────────────────────────────────────────────────────────────────────────
# paint() bakes what every texel of the atlas IS (garment, around/along position, world position and normal,
# material slot, ambient occlusion) with Cycles into a Canvas, runs the rider's painters over it (fabric detail
# from swatches, wrinkles placed per garment, decals and small graphics), then adds seams and stitching and
# composes <name>-albedo.png and <name>-normal.png. apply_textures() puts them on the mesh.

def bake_passes(ob, size):
    import numpy as np
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.light_settings.distance = 0.22
    RIG.data.pose_position = "REST"
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob

    saved = [s.material for s in ob.material_slots]
    mat = bpy.data.materials.new("_rider_bake")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(emit.outputs[0], out.inputs[0])
    tex = nt.nodes.new("ShaderNodeTexImage")
    nt.nodes.active = tex

    def attr(name):
        a = nt.nodes.new("ShaderNodeAttribute")
        a.attribute_type = "GEOMETRY"
        a.attribute_name = name
        return a

    luv, gar, slot = attr("LoftUV"), attr("garment"), attr("slot")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(luv.outputs["Vector"], sep.inputs[0])
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    enc = nt.nodes.new("ShaderNodeVectorMath")      # v * 0.5 + 0.5: keeps signed vectors positive
    enc.operation = "MULTIPLY_ADD"
    enc.inputs[1].default_value = (0.5, 0.5, 0.5)
    enc.inputs[2].default_value = (0.5, 0.5, 0.5)
    for s in ob.material_slots:
        s.material = mat

    def run(name, source, margin=12, kind="EMIT", samples=1):
        img = bpy.data.images.new(name, size, size, alpha=True, float_buffer=True)
        img.colorspace_settings.name = "Non-Color"
        tex.image = img
        for link in list(emit.inputs["Color"].links):
            nt.links.remove(link)
        for link in list(enc.inputs[0].links):
            nt.links.remove(link)
        for link in list(comb.inputs[0].links) + list(comb.inputs[1].links) + list(comb.inputs[2].links):
            nt.links.remove(link)
        source()
        scene.cycles.samples = samples
        bpy.ops.object.bake(type=kind, margin=margin, margin_type="EXTEND", use_clear=True,
                            target="IMAGE_TEXTURES")
        a = np.empty(size * size * 4, np.float32)
        img.pixels.foreach_get(a)
        bpy.data.images.remove(img)
        return a.reshape(size, size, 4)

    def src_loft():
        nt.links.new(sep.outputs[0], comb.inputs[0])
        nt.links.new(sep.outputs[1], comb.inputs[1])
        nt.links.new(gar.outputs["Fac"], comb.inputs[2])
        nt.links.new(comb.outputs[0], emit.inputs["Color"])

    def src_vec(output):
        def wire():
            nt.links.new(geo.outputs[output], enc.inputs[0])
            nt.links.new(enc.outputs[0], emit.inputs["Color"])
        return wire

    def src_slot():
        nt.links.new(slot.outputs["Fac"], comb.inputs[0])
        comb.inputs[1].default_value = 1.0
        nt.links.new(comb.outputs[0], emit.inputs["Color"])

    passes = {
        "loft": run("_loft", src_loft),
        "pos": run("_pos", src_vec("Position")),
        "nrm": run("_nrm", src_vec("Normal")),
        "slot": run("_slot", src_slot),
        "mask": run("_mask", src_slot, margin=0),
        "ao": run("_ao", lambda: None, kind="AO", samples=48),
    }
    for s, m in zip(ob.material_slots, saved):
        s.material = m
    bpy.data.materials.remove(mat)
    return passes


def load_rgb(path):
    import numpy as np
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[..., :3]


def load_gray(path):
    a = load_rgb(path)
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def box_blur(a, r):
    import numpy as np
    for axis in (0, 1):
        n = a.shape[axis]
        c = np.cumsum(np.concatenate([np.take(a, range(n - r - 1, n), axis=axis), a,
                                      np.take(a, range(0, r), axis=axis)], axis=axis), axis=axis)
        a = (np.take(c, range(2 * r + 1, n + 2 * r + 1), axis=axis) - np.take(c, range(0, n), axis=axis)) / (2 * r + 1)
    return a


def detail_field(path, blur=40):
    """A swatch as a seamless, zero-mean, unit-ish detail field."""
    import numpy as np
    a = load_gray(path)
    h, w = a.shape
    b = np.roll(a, (h // 2, w // 2), axis=(0, 1))
    yy, xx = np.mgrid[0:h, 0:w]
    edge = np.minimum(np.minimum(xx, w - 1 - xx) / w, np.minimum(yy, h - 1 - yy) / h)
    wa = np.clip(edge * 6.0, 0, 1)
    wa = wa * wa * (3 - 2 * wa)
    a = a * wa + b * (1 - wa)
    a = a - box_blur(box_blur(a, blur), blur)
    return a / (a.std() + 1e-6)


def tile_field(field, xm, ym, tile_m):
    import numpy as np
    h, w = field.shape
    x = (xm / tile_m * w) % w
    y = (ym / tile_m * h) % h
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    fx, fy = x - x0, y - y0
    x1, y1 = (x0 + 1) % w, (y0 + 1) % h
    top = field[y0, x0] * (1 - fx) + field[y0, x1] * fx
    bot = field[y1, x0] * (1 - fx) + field[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def vnoise(x, y, seed=0.0):
    import numpy as np
    xi, yi = np.floor(x), np.floor(y)
    xf, yf = x - xi, y - yi

    def hsh(a, b):
        v = np.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453
        return v - np.floor(v)

    sx, sy = xf * xf * (3 - 2 * xf), yf * yf * (3 - 2 * yf)
    top = hsh(xi, yi) * (1 - sx) + hsh(xi + 1, yi) * sx
    bot = hsh(xi, yi + 1) * (1 - sx) + hsh(xi + 1, yi + 1) * sx
    return (top * (1 - sy) + bot * sy) * 2 - 1


def fbm(x, y, octaves=4, seed=0.0):
    total, amp, norm = 0.0, 1.0, 0.0
    for i in range(octaves):
        total = total + amp * vnoise(x * 2 ** i, y * 2 ** i, seed + i * 13.1)
        norm += amp
        amp *= 0.5
    return total / norm


def dilate(m, r):
    import numpy as np
    for _ in range(r):
        m = m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
    return m


def emblem_mask(path, caption=0.25):
    """A generated emblem, cropped to the ink (a caption along the bottom `caption` dropped) and squared,
    1 = ink. Rows run bottom-up, as Blender stores pixels."""
    import numpy as np
    g = load_gray(path)
    h, w = g.shape
    ink = g < 0.45
    ink[: int(h * caption)] = False
    ys, xs = np.nonzero(ink)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    side = int(max(y1 - y0, x1 - x0) * 1.08)
    cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
    crop = np.zeros((side, side), np.float32)
    ys0, xs0 = cy - side // 2, cx - side // 2
    for yy in range(side):
        sy = ys0 + yy
        if 0 <= sy < h:
            row = g[sy, max(0, xs0): xs0 + side]
            crop[yy, max(0, -xs0): max(0, -xs0) + row.shape[0]] = row
    return np.clip((0.55 - crop) / 0.2, 0, 1) * (crop > 0)


def decal(mask, a, b, size):
    """Sample a square decal at local coords (a, b) metres from its centre; 0 outside."""
    import numpy as np
    n = mask.shape[0]
    x = (a / size + 0.5) * (n - 1)
    y = (b / size + 0.5) * (n - 1)
    inside = (x >= 0) & (x < n - 1) & (y >= 0) & (y < n - 1)
    xi = np.clip(x, 0, n - 1).astype(np.int32)
    yi = np.clip(y, 0, n - 1).astype(np.int32)
    return np.where(inside, mask[yi, xi], 0.0)


def smooth(e0, e1, x):
    import numpy as np
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def bump(x, centre, width):
    import numpy as np
    return np.exp(-((x - centre) / width) ** 2)


class Canvas:
    """What every painter works on: the baked per-texel data and the colour, height and detail layers.

    col: linear RGB (replaceable: painters may assign c.col); h: height in metres (normal map and crease
    shading, modified in place); detail: fabric micro-detail that tints the colour only (in place).
    u, v: the garment's own coordinates (fraction around, metres along); g: garment id; slot: material slot;
    px.. / nx..: world position and normal; xm, ym: metres in atlas space; n_fine/n_mid/n_low: noise."""

    def __init__(self, ob, size, src_dirs):
        import numpy as np
        self.src_dirs = src_dirs
        self._swatches = {}
        me = ob.data
        P = bake_passes(ob, size)
        # Pixels per metre: the packed atlas has one texel density everywhere (the face is denser on purpose,
        # so it is left out).
        uvs = me.uv_layers["UVMap"].data
        garments = [0] * len(me.polygons)
        me.attributes["garment"].data.foreach_get("value", garments)
        clothes = [p for p, gid in zip(me.polygons, garments) if gid != G_HEAD]
        uv_area = 0.0
        for poly in clothes:
            pts = [uvs[i].uv for i in poly.loop_indices]
            uv_area += abs(sum(pts[k].x * pts[(k + 1) % len(pts)].y - pts[(k + 1) % len(pts)].x * pts[k].y
                               for k in range(len(pts)))) / 2
        self.ppm = (uv_area / sum(p.area for p in clothes)) ** 0.5 * size
        self.mpp = 1.0 / self.ppm

        loft, pos, nrm, slot_p = P["loft"], P["pos"], P["nrm"], P["slot"]
        self.covered = P["mask"][..., 1] > 0.5      # the slot pass writes a constant 1 in G wherever it baked
        self.fill = slot_p[..., 1] > 0.5
        self.u = loft[..., 0]
        self.v = loft[..., 1]
        self.g = np.rint(loft[..., 2]).astype(np.int32)
        self.slot = np.rint(slot_p[..., 0]).astype(np.int32)
        self.px, self.py, self.pz = [(pos[..., i] - 0.5) * 2 for i in range(3)]
        self.nx, self.ny, self.nz = [(nrm[..., i] - 0.5) * 2 for i in range(3)]
        self.ao = P["ao"][..., 0]
        self.yy, self.xx = np.mgrid[0:size, 0:size].astype(np.float32)
        self.xm, self.ym = self.xx * self.mpp, self.yy * self.mpp    # metres in island space: x around, y along

        self.names = list(me["slot_names"])
        base = np.zeros((size, size, 3), np.float32)
        for i, name in enumerate(self.names):
            base[self.slot == i] = PALETTE[name][0]
        self.col = base.copy()
        self.h = np.zeros((size, size), np.float32)
        self.detail = np.zeros((size, size), np.float32)
        self.emit = np.zeros((size, size, 3), np.float32)    # glow, linear RGB; saved only if anything glows
        self.n_fine = fbm(self.xm * 260, self.ym * 260, 3, 1.0)
        self.n_mid = fbm(self.xm * 40, self.ym * 40, 4, 2.0)
        self.n_low = fbm(self.xm * 9, self.ym * 9, 3, 3.0)

    def m(self, *ids):
        import numpy as np
        return np.isin(self.g, ids) & self.fill

    def src(self, name):
        for d in self.src_dirs:
            path = os.path.join(d, name)
            if os.path.exists(path):
                return path
        raise FileNotFoundError(f"{name} not in {self.src_dirs}")

    def sw(self, name):
        """A fabric swatch (<name>.png from the source folders) as a detail field."""
        if name not in self._swatches:
            self._swatches[name] = detail_field(self.src(name + ".png"))
        return self._swatches[name]


def paint_gaiter(c, stripe, slack=(1.520, 1.548), gather_z=1.500, zig_z=1.509):
    """Fleece gaiter: folds that relax where it is stretched over the face, gathers low, a zigzag stripe."""
    import numpy as np
    ga = c.m(G_GAITER)
    c.detail += np.where(ga, 0.09 * c.n_fine + 0.05 * c.n_mid, 0)
    sl = 1 - smooth(slack[0], slack[1], c.pz)                     # stretched smooth over the chin and mouth
    c.h += np.where(ga, (0.0005 + 0.0014 * sl) * (0.6 + 0.6 * c.n_low) * np.sin(TAU * c.v / 0.016 + 3.0 * c.n_mid), 0)
    c.h += np.where(ga, 0.0018 * bump(c.pz, gather_z, 0.016) * np.sin(TAU * c.u * 23 + 3.0 * c.n_mid), 0)
    zig = np.abs(((c.u * 14) % 1.0) - 0.5)
    zz = ga & (np.abs(c.pz - zig_z - 0.010 * zig) < 0.0035)
    c.col[zz] = stripe


def paint_boots(c, lace_slot, lace_colour, panel=(0.06, 0.045, 0.035)):
    """Suede uppers, a dark lace panel with crossed laces, lugged soles."""
    import numpy as np
    m, v, u, xm, ym, col, h = c.m, c.v, c.u, c.xm, c.ym, c.col, c.h
    sh, ft, so = m(G_SHAFT), m(G_FOOT), m(G_SOLE)
    suede = 0.10 * fbm(xm * 500, ym * 500, 3, 5.0) + 0.06 * c.n_mid
    c.detail += np.where(sh | ft, suede, 0)
    h += np.where(sh, 0.0014 * bump(v, 0.13, 0.03) * np.sin(TAU * v / 0.012 + c.n_mid), 0)
    collar = sh & (v < 0.022)
    col[collar] *= 0.55
    lace_panel = ft & (c.slot == c.names.index(lace_slot))
    col[lace_panel] = panel
    across = (u - 0.25) * 0.42                                       # metres across the instep, roughly
    d1 = np.abs(((v + across) / 0.028) % 1.0 - 0.5)
    d2 = np.abs(((v - across) / 0.028) % 1.0 - 0.5)
    laces = lace_panel & (np.minimum(d1, d2) < 0.16)
    col[laces] = lace_colour
    h[laces] += 0.0015
    bottom = so & (c.nz < -0.6)
    lug = (np.abs(((ym / 0.022) % 1.0) - 0.5) < 0.22) | (np.abs(((xm / 0.03) % 1.0) - 0.5) < 0.12)
    h += np.where(bottom & lug, 0.002, 0)
    col[so & ~bottom] *= np.where((np.sin(TAU * c.pz / 0.008) > 0.6)[so & ~bottom, None], 0.7, 1.0)


def paint_goggles(c, lens_low, lens_high, strap_a, strap_b, chevron_colour):
    """Mirror lens graded bottom to top, a striped strap with chevrons."""
    import numpy as np
    m, ym, u = c.m, c.ym, c.u
    fr = m(G_FRAME, G_BAND)
    c.detail += np.where(fr, 0.05 * c.n_fine, 0)
    ln = m(G_LENS)
    hgt = np.clip((c.pz - 1.612) / 0.048 + 0.5, 0, 1)               # 0 at the bottom of the lens, 1 at the top
    lens_col = (np.array(lens_low) * (1 - hgt[..., None]) + np.array(lens_high) * hgt[..., None])
    streak = np.clip(1 - np.abs(((c.px * 6 + c.pz * 9) % 1.0) - 0.5) * 9, 0, 1) * 0.35
    c.col = np.where(ln[..., None], lens_col + streak[..., None], c.col)
    col = c.col
    st = m(G_STRAP)
    stripe = ((ym / 0.035) % 1.0) < 0.5
    col[st] = np.where(stripe[st, None], strap_a, strap_b)
    chevron = st & (np.abs(((ym / 0.035 + np.abs(u - 0.5) * 1.2) % 0.5) - 0.25) < 0.04)
    col[chevron] = chevron_colour


def paint_face(c, face, skin, flush=1.0, flush_colour=(0.60, 0.20, 0.16), freckles=0.45,
               freckle_colour=(0.36, 0.17, 0.09), lips=((0.50, 0.22, 0.18), (0.40, 0.16, 0.13)),
               hair=(0.055, 0.035, 0.025), nostrils=(0.0062, 0.1170)):
    """Face, neck and hair, painted in the head's own frame (s left, f forward, u up from HEAD_C), like the face
    dict. The retail riders carry most of a face in paint: lips, nostrils, a cold flush, freckles, hair.
    nostrils = (s, f) of the left nostril's centre on the underside of the nose."""
    import numpy as np
    hi = np.nonzero(c.m(G_HEAD))
    S, F, U = c.px[hi], HEAD_C.y - c.py[hi], c.pz[hi] - HEAD_C.z
    col = np.tile(np.array(skin), (len(S), 1))
    col *= (1 + 0.05 * c.n_mid[hi] + 0.03 * c.n_low[hi])[:, None]

    def blob(cs, cf, cu, rs, rf, ru, ss=S):
        return np.exp(-(((ss - cs) / rs) ** 2 + ((F - cf) / rf) ** 2 + ((U - cu) / ru) ** 2))

    def mix(col_, colour, a):
        return col_ * (1 - a[:, None]) + np.asarray(colour) * a[:, None]

    fl = flush * 0.38 * blob(0.048, 0.09, -0.030, 0.024, 0.045, 0.020, np.abs(S)) * (F > 0.03)
    fl += flush * 0.30 * blob(0.0, 0.122, -0.036, 0.012, 0.02, 0.012)                 # the tip of the nose
    col = mix(col, flush_colour, np.clip(fl, 0, 0.6))
    if freckles:
        # Freckles: one round dot at a random spot in some of the 3 mm cells across the nose and cheeks.
        band = np.exp(-((U + 0.024) / 0.016) ** 2) * np.exp(-(S / 0.050) ** 2) * (F > 0.06)
        cell = 0.0033
        ci, cj = np.floor(S / cell), np.floor(U / cell)
        rnd = lambda k: (np.sin(ci * 127.1 + cj * 311.7 + k * 74.7) * 43758.5453) % 1.0
        ds = (S / cell - ci) - (0.25 + 0.5 * rnd(1.0))
        du = (U / cell - cj) - (0.25 + 0.5 * rnd(2.0))
        radius = (0.13 + 0.10 * rnd(3.0))
        dot = np.clip((radius - np.sqrt(ds * ds + du * du)) / 0.06, 0, 1) * (rnd(4.0) < freckles * band)
        col = mix(col, freckle_colour, 0.55 * dot)

    Q = np.stack([S, F, U], -1)

    def ell(q, centre, radii):
        q = (q - np.asarray(centre)) / np.asarray(radii)
        k0 = np.linalg.norm(q, axis=-1)
        return k0 * (k0 - 1.0) / np.maximum(np.linalg.norm(q / np.asarray(radii), axis=-1), 1e-9)

    lip_d = np.minimum(ell(Q, *face["upper_lip"][:2]), ell(Q, *face["lower_lip"][:2]))
    lip = np.clip((0.0035 - lip_d) / 0.002, 0, 1) * (F > 0.085)
    mouth_u, mouth_w = face["mouth_line"][0][2], face["mouth_line"][1][0]
    lip_col = np.where((U < mouth_u)[:, None], lips[0], lips[1])
    col = col * (1 - 0.75 * lip[:, None]) + lip_col * 0.75 * lip[:, None]
    line = np.clip(1 - np.abs(U - mouth_u) / 0.0016, 0, 1) * np.clip((mouth_w - np.abs(S)) / 0.005, 0, 1) * (F > 0.095)
    col *= (1 - 0.7 * line)[:, None]
    # Nostrils: angled ovals on the underside of the nose itself (not the blend down into the upper lip).
    on_nose = (head_sdf(Q, face, part="nose") < 0.0012) & (c.nz[hi] < -0.45)
    tilt = np.radians(25)
    tip_s, tip_f = nostrils
    for side_s in (-1.0, 1.0):
        ds, df = S - side_s * tip_s, F - tip_f
        along = ds * side_s * np.sin(tilt) - df * np.cos(tilt)
        across = ds * np.cos(tilt) + df * side_s * np.sin(tilt)
        nd = (along / 0.0050) ** 2 + (across / 0.0028) ** 2
        nostril = np.clip((1 - nd) / 0.35, 0, 1) * on_nose
        col = mix(col, (0.10, 0.04, 0.03), 0.8 * nostril)

    # Short dark hair from under the hat down to the nape, with sideburns in front of the ears.
    az = np.arctan2(np.abs(S), F)                                    # 0 at the front, pi at the back
    behind = np.clip((az - 1.45) / (np.pi - 1.45), 0, 1)
    line_u = np.where(az < 1.05, 0.05, np.where(az < 1.45, -0.020, -0.035 - 0.025 * behind))
    hr = np.clip((U - line_u + 0.004 * vnoise(S * 300, F * 300, 4.0)) / 0.005, 0, 1)
    strand = vnoise(np.arctan2(S, F) * 54, U * 50, 5.0)
    col = mix(col, hair, hr) * (1 + 0.25 * hr * strand)[:, None]
    c.h[hi] += 0.0002 * hr * strand
    c.col[hi] = col


def finish(c, out_dir, hem_garments, stitch):
    """Seams on every colour-block boundary and hem, then fabric detail, crease shading, AO; save the maps."""
    import numpy as np
    col, h, g, slot, covered, fill, mpp = c.col, c.h, c.g, c.slot, c.covered, c.fill, c.mpp
    size = col.shape[0]
    same_g = lambda a, b: np.roll(a, b[0], b[1])
    boundary = np.zeros_like(covered)
    for shift in ((1, 0), (-1, 0), (1, 1), (-1, 1)):
        nb_slot, nb_g, nb_cov = same_g(slot, shift), same_g(g, shift), same_g(covered, shift)
        boundary |= covered & nb_cov & (nb_g == g) & (nb_slot != slot)
    hem_edge = covered & dilate(~covered, 1) & np.isin(g, hem_garments)
    seam = dilate(boundary, 1) & fill
    col[seam] *= 0.62
    h[seam] -= 0.0012
    dash = ((c.xx + c.yy) // 4) % 2 == 0
    for src, r in ((boundary, 5), (hem_edge, 7)):
        rng = dilate(src, r) & ~dilate(src, r - 1) & covered & dash
        col[rng] = col[rng] * 0.55 + 0.45 * np.array(stitch) * 0.8
        h[rng] += 0.0005

    # Compose: fabric detail, crease shading, ambient occlusion, sRGB.
    hs = box_blur(h, 1)
    lap = (np.roll(hs, 1, 0) + np.roll(hs, -1, 0) + np.roll(hs, 1, 1) + np.roll(hs, -1, 1) - 4 * hs) / (mpp * mpp)
    crease = np.clip(1.0 - 0.0022 * lap, 0.70, 1.22)
    col *= (1 + 0.5 * c.detail)[..., None]
    col *= crease[..., None]
    ao_k = np.where(c.m(G_HEAD), 0.32, 0.58)                       # skin takes less of the goggle shadow
    col *= (1 - ao_k + ao_k * np.clip(c.ao, 0, 1) ** 0.8)[..., None]
    col = np.clip(col, 0, 1)
    srgb = np.where(col <= 0.0031308, col * 12.92, 1.055 * np.power(col, 1 / 2.4) - 0.055)
    srgb[~fill] = 0.5

    gx = (np.roll(hs, -1, 1) - np.roll(hs, 1, 1)) / (2 * mpp)
    gy = (np.roll(hs, -1, 0) - np.roll(hs, 1, 0)) / (2 * mpp)
    nmap = np.stack([-gx * 1.1, -gy * 1.1, np.ones_like(gx)], -1)
    nmap /= np.linalg.norm(nmap, axis=-1, keepdims=True)
    nmap = nmap * 0.5 + 0.5
    nmap[~fill] = (0.5, 0.5, 1.0)
    nmap = nmap.reshape(size // 2, 2, size // 2, 2, 3).mean(axis=(1, 3))     # half resolution is plenty

    def save(name, rgb, colorspace):
        hh, ww = rgb.shape[:2]
        img = bpy.data.images.new(name, ww, hh, alpha=False)
        img.colorspace_settings.name = colorspace
        rgba = np.concatenate([rgb, np.ones((hh, ww, 1), np.float32)], -1).astype(np.float32)
        img.pixels.foreach_set(rgba.ravel())
        img.filepath_raw = os.path.join(out_dir, name)
        img.file_format = "PNG"
        img.save()
        bpy.data.images.remove(img)

    save(tex_albedo(), srgb, "sRGB")
    save(tex_normal(), nmap, "Non-Color")
    glow = os.path.join(out_dir, tex_emissive())
    if c.emit.max() > 0:
        e = np.clip(c.emit, 0, 1)
        e = np.where(e <= 0.0031308, e * 12.92, 1.055 * np.power(e, 1 / 2.4) - 0.055)
        e[~fill] = 0.0
        save(tex_emissive(), e, "sRGB")
    elif os.path.exists(glow):
        os.remove(glow)                                             # a rider that no longer glows
    return {"pixels_per_metre": round(c.ppm, 1), "albedo": os.path.join(out_dir, tex_albedo())}


def tex_albedo():
    return f"{NAME.lower()}-albedo.png"


def tex_normal():
    return f"{NAME.lower()}-normal.png"


def tex_emissive():
    return f"{NAME.lower()}-emissive.png"


def paint(painters, hem_garments, stitch, src_dirs=None, out_dir=None, size=2048):
    """Bake, run each painter(c) in order, add seams, compose and save the albedo and normal maps."""
    src_dirs = src_dirs or [os.path.join(SRC, NAME.lower())]
    out_dir = out_dir or BUILD
    os.makedirs(out_dir, exist_ok=True)
    c = Canvas(bpy.data.objects[NAME], size, src_dirs)
    for fn in painters:
        fn(c)
    return finish(c, out_dir, hem_garments, stitch)


def apply_textures(tex_dir=None):
    """Swap the palette slots for one textured fabric material (plus a glossy lens), if the atlas exists."""
    tex_dir = tex_dir or BUILD
    albedo, normal = os.path.join(tex_dir, tex_albedo()), os.path.join(tex_dir, tex_normal())
    emissive = os.path.join(tex_dir, tex_emissive())
    if not os.path.exists(albedo):
        return False
    ob = bpy.data.objects[NAME]
    me = ob.data
    names = list(me["slot_names"])
    slot = [0] * len(me.polygons)
    me.attributes["slot"].data.foreach_get("value", slot)

    def textured(name, rough, metal, glow=False):
        mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
        img_a = nt.nodes.new("ShaderNodeTexImage")
        img_a.image = bpy.data.images.load(albedo, check_existing=True)
        img_a.image.reload()
        nt.links.new(img_a.outputs["Color"], bsdf.inputs["Base Color"])
        if os.path.exists(normal):
            img_n = nt.nodes.new("ShaderNodeTexImage")
            img_n.image = bpy.data.images.load(normal, check_existing=True)
            img_n.image.reload()
            img_n.image.colorspace_settings.name = "Non-Color"
            nmap = nt.nodes.new("ShaderNodeNormalMap")
            nt.links.new(img_n.outputs["Color"], nmap.inputs["Color"])
            nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        if glow and os.path.exists(emissive):
            img_e = nt.nodes.new("ShaderNodeTexImage")
            img_e.image = bpy.data.images.load(emissive, check_existing=True)
            img_e.image.reload()
            nt.links.new(img_e.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 1.0
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        return mat

    fabric = textured(f"{NAME}_Fabric", 0.85, 0.0, glow=True)
    lens = textured(f"{NAME}_Lens", 0.12, 0.35)
    lens_slot = names.index(f"{PREFIX}Lens")
    me.materials.clear()
    me.materials.append(fabric)
    me.materials.append(lens)
    me.polygons.foreach_set("material_index", [1 if s_ == lens_slot else 0 for s_ in slot])
    return True


def export_glb(path):
    """Export the rig and a copy of the rider (without the painting-only LoftUV) in rest pose."""
    ob = bpy.data.objects[NAME]
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for o in bpy.context.selected_objects:
        o.select_set(False)
    c = ob.copy()
    c.data = ob.data.copy()
    COL.objects.link(c)
    if "LoftUV" in c.data.uv_layers:
        c.data.uv_layers.remove(c.data.uv_layers["LoftUV"])
    RIG.data.pose_position = "REST"
    c.select_set(True)
    RIG.select_set(True)
    bpy.context.view_layer.objects.active = RIG
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_animations=False,
                              export_skins=True, export_morph=False, export_yup=True, export_apply=False,
                              export_cameras=False, export_lights=False, export_image_format="JPEG",
                              export_image_quality=90, export_jpeg_quality=90)
    RIG.data.pose_position = "POSE"
    bpy.data.objects.remove(c, do_unlink=True)


def run(build, painters, hem_garments, stitch, src_dirs=None):
    """The command line every recipe shares: build, then --paint (bake and paint the atlas) and
    --export <file.glb>. Without --paint, existing maps are reused if present."""
    result = build()
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--paint" in args:
        result["paint"] = paint(painters, hem_garments, stitch, src_dirs)
    result["textured"] = apply_textures()
    if "--export" in args:
        export_glb(args[args.index("--export") + 1])
    return result
